"""
thinking_context/mount.py
══════════════════════════
Drop-in FastAPI integration. Mount this in any FastAPI app in ~5 lines.

USAGE
─────

    # main.py (your app)
    from fastapi import FastAPI
    from thinking_context import mount, CharacterProfile

    app = FastAPI()

    class MyAdapter:
        \"\"\"Thin wrapper — implement these two methods for your app.\"\"\"

        async def get_recent_history(self, room: str, limit: int = 12):
            # Return recent messages as list of {"user_id", "text", "ts"} dicts
            return await your_hub.recent_messages(room, limit)

        async def nudge(self, room_id: str, hint: str) -> bool:
            # Inject hint and trigger your AI agent
            return await your_bots.inject_and_trigger(room_id, hint)

    adapter = MyAdapter()

    characters = [
        CharacterProfile(character_id="bot-1", name="Alice", role="host"),
        CharacterProfile(character_id="bot-2", name="Bob",   role="commentator"),
    ]

    mount(app, adapter, characters=characters)

That's it. Jeremy starts watching on startup, saves memory on shutdown,
and whispers to your bots whenever a room needs it.

OPTIONAL PARAMETERS
───────────────────

    mount(
        app,
        adapter,
        characters       = [...],        # list of CharacterProfile
        snapshot_path    = "data/memory_snapshot.json",
        poll_interval    = 5.0,          # seconds between Jeremy's room checks
        silence_threshold = 45.0,        # seconds of quiet before Jeremy considers nudging
        min_nudge_interval = 90.0,       # minimum seconds between nudges in same room
        drama_threshold  = 0.65,         # 0–1, how dramatic the room needs to be before nudging
        include_router   = True,         # mount /thinking-context/status endpoint
        startup_rooms    = [],           # room IDs to watch immediately on startup
                                         # (if empty, call tc.watch_room(room_id) yourself)
    )

RUNTIME API
───────────
After mount(), the ThinkingContext instance is available at:

    app.state.thinking_context

Use it to manage rooms:

    tc = app.state.thinking_context
    await tc.watch_room("my-room")
    await tc.release_room("my-room")

Or inject it with FastAPI dependency:

    from thinking_context import get_thinking_context
    from fastapi import Depends

    @app.post("/rooms/{room_id}/join")
    async def join_room(room_id: str, tc=Depends(get_thinking_context)):
        await tc.watch_room(room_id)

Rear View Foresight LLC — Feic Mo Chroí
"""
from __future__ import annotations

import asyncio
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Callable, List, Optional

from fastapi import APIRouter, FastAPI, Request

from .jeremy import JeremyCricket, JeremyConfig, create_jeremy_cricket
from .memory import CharacterProfile, UniversalMemorySystem

logger = logging.getLogger("thinking_context")


# ─────────────────────────────────────────────────────────────────────────────
# ThinkingContext — the runtime handle your app gets back from mount()
# ─────────────────────────────────────────────────────────────────────────────

class ThinkingContext:
    """
    The live instance created by mount().
    Stored at app.state.thinking_context.
    Use it to manage room lifecycles at runtime.
    """

    def __init__(self, jeremy: JeremyCricket, memory: UniversalMemorySystem) -> None:
        self._jeremy = jeremy
        self._memory = memory
        self._started_at = time.time()

    async def watch_room(self, room_id: str) -> None:
        """Start watching a room. Call when a room opens."""
        await self._jeremy.watch_room(room_id)

    async def release_room(self, room_id: str) -> None:
        """Stop watching a room. Call when a room closes."""
        await self._jeremy.release_room(room_id)

    async def on_message(self, room_id: str, user_id: str, text: str) -> None:
        """
        Notify Jeremy about a new message.
        Call this from your chat broadcast path — fire and forget.

        Example in your hub/broadcast function:
            asyncio.create_task(tc.on_message(room_id, user_id, text))
        """
        await self._jeremy.on_message(room_id, user_id, text)

    @property
    def memory(self) -> UniversalMemorySystem:
        """Direct access to the memory system if you need it."""
        return self._memory

    def stats(self) -> dict:
        return {
            "uptime_seconds": round(time.time() - self._started_at, 1),
            "jeremy":         self._jeremy.get_stats(),
        }


# ─────────────────────────────────────────────────────────────────────────────
# FastAPI dependency helper
# ─────────────────────────────────────────────────────────────────────────────

def get_thinking_context(request: Request) -> ThinkingContext:
    """
    FastAPI dependency. Inject the live ThinkingContext into any route.

        @app.post("/rooms/{room_id}")
        async def open_room(room_id: str, tc=Depends(get_thinking_context)):
            await tc.watch_room(room_id)
    """
    tc: Optional[ThinkingContext] = getattr(request.app.state, "thinking_context", None)
    if tc is None:
        raise RuntimeError(
            "ThinkingContext not found on app.state. "
            "Did you call thinking_context.mount(app, adapter) ?"
        )
    return tc


# ─────────────────────────────────────────────────────────────────────────────
# mount() — the entry point
# ─────────────────────────────────────────────────────────────────────────────

def mount(
    app:                 FastAPI,
    adapter:             Any,
    *,
    characters:          Optional[List[CharacterProfile]] = None,
    snapshot_path:       str   = "data/memory_snapshot.json",
    poll_interval:       float = 5.0,
    silence_threshold:   float = 45.0,
    min_nudge_interval:  float = 90.0,
    drama_threshold:     float = 0.65,
    include_router:      bool  = True,
    startup_rooms:       Optional[List[str]] = None,
) -> None:
    """
    Wire Thinking Context into a FastAPI app.

    Parameters
    ----------
    app         : your FastAPI instance
    adapter     : any object with get_recent_history() and nudge() methods
    characters  : list of CharacterProfile to register (can add more later)
    snapshot_path : where to save/load memory between restarts
    include_router : if True, mounts GET /thinking-context/status
    startup_rooms  : rooms to watch immediately on startup
    """

    _validate_adapter(adapter)

    # ── Build lifespan ────────────────────────────────────────────────────────

    # Preserve any existing lifespan the app already has
    _existing_lifespan = getattr(app.router, "lifespan_context", None)

    @asynccontextmanager
    async def _lifespan(application: FastAPI):
        # ── startup ───────────────────────────────────────────────────────────
        memory = UniversalMemorySystem()

        restored = memory.restore(snapshot_path)
        if restored:
            logger.info("💾 ThinkingContext: restored %d memory entries.", restored)
        else:
            logger.info("🆕 ThinkingContext: fresh session — no prior memory.")

        for char in (characters or []):
            memory.register_character(char)

        jeremy = await create_jeremy_cricket(
            memory_system    = memory,
            bot_manager      = adapter,
            hub              = adapter,
            config           = JeremyConfig(
                poll_interval      = poll_interval,
                silence_threshold  = silence_threshold,
                min_nudge_interval = min_nudge_interval,
                drama_threshold    = drama_threshold,
            ),
        )

        tc = ThinkingContext(jeremy, memory)
        application.state.thinking_context = tc

        for room_id in (startup_rooms or []):
            await tc.watch_room(room_id)
            logger.info("ThinkingContext: watching room '%s'", room_id)

        logger.info("✅ ThinkingContext: mounted and ready.")

        # Run existing lifespan if any
        if _existing_lifespan:
            async with _existing_lifespan(application):
                yield
        else:
            yield

        # ── shutdown ──────────────────────────────────────────────────────────
        logger.info("ThinkingContext: shutting down Jeremy...")
        await jeremy.shutdown()

        logger.info("ThinkingContext: saving memory to %s", snapshot_path)
        memory.serialize(snapshot_path)
        logger.info("ThinkingContext: memory saved.")

    app.router.lifespan_context = _lifespan

    # ── Optional status router ────────────────────────────────────────────────

    if include_router:
        router = APIRouter(prefix="/thinking-context", tags=["thinking-context"])

        @router.get("/status")
        async def status(request: Request):
            tc = get_thinking_context(request)
            return tc.stats()

        app.include_router(router)


# ─────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ─────────────────────────────────────────────────────────────────────────────

def _validate_adapter(adapter: Any) -> None:
    """Give a clear error if the adapter is missing required methods."""
    missing = []
    if not callable(getattr(adapter, "get_recent_history", None)):
        missing.append("get_recent_history(self, room: str, limit: int) -> List[dict]")
    if not callable(getattr(adapter, "nudge", None)):
        missing.append("nudge(self, room_id: str, hint: str) -> bool")
    if missing:
        raise TypeError(
            "ThinkingContext adapter is missing required methods:\n"
            + "\n".join(f"  • {m}" for m in missing)
            + "\n\nSee thinking_context.protocols.ContextHost for the full interface."
        )
