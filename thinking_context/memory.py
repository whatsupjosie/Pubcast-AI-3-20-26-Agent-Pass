"""
universal_memory_system.py
═══════════════════════════════════════════════════
Universal Memory System — shared memory layer for AI conversation agents.
Provides CharacterMemoryBank, MemoryEntry, UniversalMemorySystem, CharacterProfile.
Full RAG/vector implementation is Phase 3 (Ollama Qwen integration).

Rear View Foresight LLC — Feic Mo Chroí
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class MemoryType(str, Enum):
    EPISODIC    = "episodic"
    SEMANTIC    = "semantic"
    PROCEDURAL  = "procedural"
    EMOTIONAL   = "emotional"
    RELATIONAL  = "relational"


@dataclass
class MemoryEntry:
    content:      str
    memory_type:  MemoryType  = MemoryType.EPISODIC
    importance:   float        = 0.5
    timestamp:    float        = field(default_factory=time.time)
    memory_id:    str          = field(default_factory=lambda: uuid.uuid4().hex[:12])
    tags:         List[str]    = field(default_factory=list)
    source:       str          = "conversation"
    related_to:   Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "memory_id":   self.memory_id,
            "content":     self.content,
            "type":        self.memory_type.value,
            "importance":  self.importance,
            "timestamp":   self.timestamp,
            "tags":        self.tags,
        }


@dataclass
class CharacterProfile:
    character_id:  str
    name:          str
    role:          str            = "assistant"
    personality:   Dict[str, Any] = field(default_factory=dict)
    backstory:     str            = ""
    created_at:    float          = field(default_factory=time.time)


class CharacterMemoryBank:
    """Per-character in-memory store with recency + importance retrieval."""

    def __init__(self, character_id: str, max_entries: int = 500) -> None:
        self.character_id = character_id
        self.max_entries  = max_entries
        self._memories: List[MemoryEntry] = []

    def add(self, entry: MemoryEntry) -> None:
        self._memories.append(entry)
        if len(self._memories) > self.max_entries:
            self._memories.sort(key=lambda m: (m.importance, m.timestamp), reverse=True)
            self._memories = self._memories[:self.max_entries]

    def search(self, query: str, *, limit: int = 10,
               memory_type: Optional[MemoryType] = None) -> List[MemoryEntry]:
        results = self._memories
        if memory_type:
            results = [m for m in results if m.memory_type == memory_type]
        query_lower = query.lower()
        scored = [
            (sum(1 for w in query_lower.split() if w in m.content.lower()), m)
            for m in results
        ]
        scored.sort(key=lambda t: (t[0], t[1].importance, t[1].timestamp), reverse=True)
        return [m for _, m in scored[:limit]]

    def recent(self, limit: int = 20) -> List[MemoryEntry]:
        return sorted(self._memories, key=lambda m: m.timestamp, reverse=True)[:limit]

    def clear(self) -> None:
        self._memories.clear()


class UniversalMemorySystem:
    """Multi-character memory system with cross-character event awareness."""

    def __init__(self) -> None:
        self._banks:    Dict[str, CharacterMemoryBank] = {}
        self._profiles: Dict[str, CharacterProfile]   = {}
        self._global:   List[MemoryEntry]              = []

    def get_or_create_bank(self, character_id: str) -> CharacterMemoryBank:
        if character_id not in self._banks:
            self._banks[character_id] = CharacterMemoryBank(character_id)
        return self._banks[character_id]

    def register_character(self, profile: CharacterProfile) -> None:
        self._profiles[profile.character_id] = profile
        self.get_or_create_bank(profile.character_id)

    def add_global_event(self, entry: MemoryEntry) -> None:
        self._global.append(entry)
        if len(self._global) > 1000:
            self._global = sorted(
                self._global, key=lambda m: (m.importance, m.timestamp), reverse=True
            )[:800]

    def broadcast_to_all(self, entry: MemoryEntry) -> None:
        self.add_global_event(entry)
        for bank in self._banks.values():
            bank.add(entry)

    def global_context(self, limit: int = 30) -> List[MemoryEntry]:
        return sorted(self._global, key=lambda m: m.timestamp, reverse=True)[:limit]

    # ── Persistence (Option A — JSON snapshot) ────────────────────────────────

    def serialize(self, path) -> None:
        """
        Dump all character memories and profiles to a JSON file.
        Call on app shutdown to survive restarts.
        """
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)

        def _entry(m):
            return {
                "memory_id":   m.memory_id,
                "content":     m.content,
                "memory_type": m.memory_type.value,
                "importance":  m.importance,
                "timestamp":   m.timestamp,
                "tags":        m.tags,
                "source":      m.source,
                "related_to":  m.related_to,
            }

        def _profile(p):
            return {
                "character_id": p.character_id,
                "name":         p.name,
                "role":         p.role,
                "personality":  p.personality,
                "backstory":    p.backstory,
                "created_at":   p.created_at,
            }

        payload = {
            "saved_at":  time.time(),
            "profiles":  {cid: _profile(p) for cid, p in self._profiles.items()},
            "banks":     {
                cid: [_entry(m) for m in bank._memories]
                for cid, bank in self._banks.items()
            },
            "global":    [_entry(m) for m in self._global],
        }

        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(path)
        logger.info(
            "UniversalMemorySystem: saved %d character(s), %d global entries -> %s",
            len(self._banks), len(self._global), path,
        )

    def restore(self, path) -> int:
        """
        Reload memories from a JSON snapshot written by serialize().
        Returns total entries loaded, or 0 if file absent.
        Call on app startup before registering new characters.
        """
        path = Path(path)
        if not path.exists():
            logger.info("UniversalMemorySystem: no snapshot at %s — starting fresh.", path)
            return 0

        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.error("UniversalMemorySystem: failed to load snapshot %s: %s", path, exc)
            return 0

        def _entry(d):
            return MemoryEntry(
                content     = d["content"],
                memory_type = MemoryType(d["memory_type"]),
                importance  = d.get("importance", 0.5),
                timestamp   = d.get("timestamp", time.time()),
                memory_id   = d.get("memory_id", uuid.uuid4().hex[:12]),
                tags        = d.get("tags", []),
                source      = d.get("source", "restored"),
                related_to  = d.get("related_to"),
            )

        for cid, pd in payload.get("profiles", {}).items():
            if cid not in self._profiles:
                self._profiles[cid] = CharacterProfile(
                    character_id = cid,
                    name         = pd["name"],
                    role         = pd.get("role", "assistant"),
                    personality  = pd.get("personality", {}),
                    backstory    = pd.get("backstory", ""),
                    created_at   = pd.get("created_at", time.time()),
                )

        total = 0
        for cid, entries in payload.get("banks", {}).items():
            bank = self.get_or_create_bank(cid)
            for d in entries:
                bank.add(_entry(d))
                total += 1

        for d in payload.get("global", []):
            self._global.append(_entry(d))
            total += 1

        saved_at = payload.get("saved_at", 0)
        age_mins = (time.time() - saved_at) / 60
        logger.info(
            "UniversalMemorySystem: restored %d entries from snapshot (%.0f min old) -> %s",
            total, age_mins, path,
        )
        return total
