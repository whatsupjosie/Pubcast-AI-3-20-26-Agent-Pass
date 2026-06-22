"""
sqlite_memory_backend.py
═════════════════════════
Option C — SQLite-backed CharacterMemoryBank.

Drops in as a replacement for the in-memory CharacterMemoryBank.
Memory survives server restarts, is searchable via SQL, and scales
indefinitely without the 500-entry cap of the in-memory version.

Schema is adapted from the MemoryDatabase in the old jeremy_cricket.py.
Uses WAL mode for concurrent read safety and connection-per-call pattern
to avoid threading issues with asyncio.

HOW TO USE — two options:

  Option C1: Replace per-character banks with SQLite banks
  ──────────────────────────────────────────────────────────
  In your app startup, before registering characters:

      from sqlite_memory_backend import SQLiteMemorySystem

      # Drop-in replacement for UniversalMemorySystem
      memory = SQLiteMemorySystem("data/pubcast_memory.db")
      memory.restore()   # no-op — SQLite IS the persistence
      memory.register_character(CharacterProfile(...))

  SQLiteMemorySystem subclasses UniversalMemorySystem and overrides
  get_or_create_bank() to return SQLiteMemoryBank instances.
  Everything else (broadcast_to_all, global_context, etc.) works as-is.

  Option C2: Keep UniversalMemorySystem, use SQLite for one character
  ────────────────────────────────────────────────────────────────────
      db_path = "data/memories.db"
      bank = SQLiteMemoryBank("bot-pete", db_path)
      memory._banks["bot-pete"] = bank   # replace the in-memory bank

PERFORMANCE NOTES:
  - WAL mode allows concurrent readers, single writer
  - FTS5 full-text search (falls back to LIKE if unavailable)
  - Writes are synchronous but fast — memory banks rarely write at high rate
  - For very high write rate, wrap add() calls in a write queue

Rear View Foresight LLC — Feic Mo Chroí
"""

from __future__ import annotations

import logging
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Dict, List, Optional

from .memory import (
    CharacterMemoryBank,
    CharacterProfile,
    MemoryEntry,
    MemoryType,
    UniversalMemorySystem,
)

logger = logging.getLogger("sqlite_memory")

_SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;

CREATE TABLE IF NOT EXISTS memories (
    memory_id   TEXT    PRIMARY KEY,
    char_id     TEXT    NOT NULL,
    content     TEXT    NOT NULL,
    memory_type TEXT    NOT NULL DEFAULT 'episodic',
    importance  REAL    NOT NULL DEFAULT 0.5,
    timestamp   REAL    NOT NULL,
    source      TEXT    NOT NULL DEFAULT 'conversation',
    related_to  TEXT,
    tags        TEXT    NOT NULL DEFAULT ''   -- JSON array stored as text
);

CREATE INDEX IF NOT EXISTS idx_memories_char_id   ON memories (char_id);
CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories (char_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories (char_id, importance DESC);

CREATE TABLE IF NOT EXISTS character_profiles (
    character_id TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'assistant',
    personality  TEXT NOT NULL DEFAULT '{}',  -- JSON
    backstory    TEXT NOT NULL DEFAULT '',
    created_at   REAL NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    memory_id UNINDEXED,
    char_id UNINDEXED,
    content='memories',
    content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, memory_id, char_id)
    VALUES (new.rowid, new.content, new.memory_id, new.char_id);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, memory_id, char_id)
    VALUES ('delete', old.rowid, old.content, old.memory_id, old.char_id);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, memory_id, char_id)
    VALUES ('delete', old.rowid, old.content, old.memory_id, old.char_id);
    INSERT INTO memories_fts(rowid, content, memory_id, char_id)
    VALUES (new.rowid, new.content, new.memory_id, new.char_id);
END;
"""

import json


def _row_to_entry(row: sqlite3.Row) -> MemoryEntry:
    tags = []
    try:
        tags = json.loads(row["tags"]) if row["tags"] else []
    except Exception:
        pass
    return MemoryEntry(
        memory_id   = row["memory_id"],
        content     = row["content"],
        memory_type = MemoryType(row["memory_type"]),
        importance  = row["importance"],
        timestamp   = row["timestamp"],
        source      = row["source"],
        related_to  = row["related_to"],
        tags        = tags,
    )


class _DB:
    """Thread-local SQLite connection pool."""

    def __init__(self, path: str) -> None:
        self._path  = path
        self._local = threading.local()

    def conn(self) -> sqlite3.Connection:
        if not getattr(self._local, "conn", None):
            c = sqlite3.connect(self._path, check_same_thread=False)
            c.row_factory = sqlite3.Row
            c.executescript(_SCHEMA)
            self._local.conn = c
        return self._local.conn


class SQLiteMemoryBank(CharacterMemoryBank):
    """
    SQLite-backed drop-in for CharacterMemoryBank.
    Persists to disk automatically — no serialize/restore needed.
    """

    def __init__(self, character_id: str, db_path: str) -> None:
        super().__init__(character_id)
        self._db = _DB(db_path)
        self._fts_available = self._check_fts()

    def _check_fts(self) -> bool:
        try:
            self._db.conn().execute(
                "SELECT memory_id FROM memories_fts WHERE memories_fts MATCH 'test' LIMIT 1"
            )
            return True
        except Exception:
            logger.warning("SQLiteMemoryBank: FTS5 unavailable, falling back to LIKE search.")
            return False

    def add(self, entry: MemoryEntry) -> None:
        """Persist a MemoryEntry. Ignores max_entries — SQLite handles unlimited storage."""
        tags_json = json.dumps(entry.tags)
        try:
            self._db.conn().execute(
                """
                INSERT OR REPLACE INTO memories
                    (memory_id, char_id, content, memory_type, importance,
                     timestamp, source, related_to, tags)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    entry.memory_id, self.character_id, entry.content,
                    entry.memory_type.value, entry.importance, entry.timestamp,
                    entry.source, entry.related_to, tags_json,
                ),
            )
            self._db.conn().commit()
        except Exception as exc:
            logger.error("SQLiteMemoryBank.add failed for %s: %s", self.character_id, exc)

    def search(
        self, query: str, *, limit: int = 10, memory_type: Optional[MemoryType] = None
    ) -> List[MemoryEntry]:
        conn = self._db.conn()
        rows = []

        if self._fts_available:
            try:
                # FTS5 full-text search, ranked by importance and recency
                type_clause = "AND m.memory_type = ?" if memory_type else ""
                params: list = [query, self.character_id]
                if memory_type:
                    params.append(memory_type.value)
                params.append(limit)

                rows = conn.execute(
                    f"""
                    SELECT m.*
                    FROM memories m
                    JOIN memories_fts fts ON fts.memory_id = m.memory_id
                    WHERE memories_fts MATCH ?
                      AND m.char_id = ?
                      {type_clause}
                    ORDER BY m.importance DESC, m.timestamp DESC
                    LIMIT ?
                    """,
                    params,
                ).fetchall()
            except Exception as exc:
                logger.debug("FTS search failed, falling back to LIKE: %s", exc)
                rows = []

        if not rows:
            # LIKE fallback
            type_clause = "AND memory_type = ?" if memory_type else ""
            params = [self.character_id, f"%{query}%"]
            if memory_type:
                params.append(memory_type.value)
            params.append(limit)
            rows = conn.execute(
                f"""
                SELECT * FROM memories
                WHERE char_id = ? AND content LIKE ?
                {type_clause}
                ORDER BY importance DESC, timestamp DESC
                LIMIT ?
                """,
                params,
            ).fetchall()

        return [_row_to_entry(r) for r in rows]

    def recent(self, limit: int = 20) -> List[MemoryEntry]:
        rows = self._db.conn().execute(
            "SELECT * FROM memories WHERE char_id = ? ORDER BY timestamp DESC LIMIT ?",
            (self.character_id, limit),
        ).fetchall()
        return [_row_to_entry(r) for r in rows]

    def count(self) -> int:
        row = self._db.conn().execute(
            "SELECT COUNT(*) as n FROM memories WHERE char_id = ?",
            (self.character_id,),
        ).fetchone()
        return row["n"] if row else 0

    def clear(self) -> None:
        conn = self._db.conn()
        conn.execute("DELETE FROM memories WHERE char_id = ?", (self.character_id,))
        conn.commit()


class SQLiteMemorySystem(UniversalMemorySystem):
    """
    Drop-in replacement for UniversalMemorySystem that persists to SQLite.

    serialize() / restore() are no-ops here — SQLite IS the persistence.
    All other UniversalMemorySystem methods work as-is.
    """

    def __init__(self, db_path: str) -> None:
        super().__init__()
        self._db_path = str(Path(db_path))
        # Ensure schema is initialized
        _DB(self._db_path).conn()
        logger.info("SQLiteMemorySystem: initialized at %s", self._db_path)

    def get_or_create_bank(self, character_id: str) -> SQLiteMemoryBank:
        if character_id not in self._banks:
            self._banks[character_id] = SQLiteMemoryBank(character_id, self._db_path)
            logger.debug("SQLiteMemorySystem: created bank for '%s'", character_id)
        return self._banks[character_id]  # type: ignore[return-value]

    def register_character(self, profile: CharacterProfile) -> None:
        super().register_character(profile)
        # Also persist the profile to SQLite
        try:
            conn = _DB(self._db_path).conn()
            conn.execute(
                """
                INSERT OR REPLACE INTO character_profiles
                    (character_id, name, role, personality, backstory, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    profile.character_id, profile.name, profile.role,
                    json.dumps(profile.personality), profile.backstory, profile.created_at,
                ),
            )
            conn.commit()
        except Exception as exc:
            logger.error("SQLiteMemorySystem: failed to persist profile %s: %s", profile.character_id, exc)

    def restore_profiles(self) -> int:
        """
        Reload character profiles from SQLite on startup.
        Call this after constructing SQLiteMemorySystem if the server restarted
        and you want to recover previously registered characters automatically.
        Returns the number of profiles restored.
        """
        conn = _DB(self._db_path).conn()
        rows = conn.execute("SELECT * FROM character_profiles").fetchall()
        count = 0
        for row in rows:
            cid = row["character_id"]
            if cid not in self._profiles:
                personality = {}
                try:
                    personality = json.loads(row["personality"]) if row["personality"] else {}
                except Exception:
                    pass
                self._profiles[cid] = CharacterProfile(
                    character_id = cid,
                    name         = row["name"],
                    role         = row["role"],
                    personality  = personality,
                    backstory    = row["backstory"] or "",
                    created_at   = row["created_at"],
                )
                # Ensure bank exists
                self.get_or_create_bank(cid)
                count += 1
        if count:
            logger.info("SQLiteMemorySystem: restored %d character profile(s) from DB.", count)
        return count

    # No-op persistence methods — SQLite handles this automatically
    def serialize(self, path=None) -> None:  # type: ignore[override]
        logger.debug("SQLiteMemorySystem.serialize() called — no-op, SQLite persists automatically.")

    def restore(self, path=None) -> int:  # type: ignore[override]
        logger.debug("SQLiteMemorySystem.restore() called — use restore_profiles() instead.")
        return self.restore_profiles()
