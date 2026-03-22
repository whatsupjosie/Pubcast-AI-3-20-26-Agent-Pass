"""
thinking_context
════════════════
Memory, conduction, and the whisper between them.

Drop this folder into any FastAPI project. Two steps:

  1. Implement the adapter (two methods on one class)
  2. Call mount(app, adapter)

That's it. Your AI agents will remember, watch rooms, and speak
unprompted when the conversation needs them.

Quick start
───────────

    from fastapi import FastAPI
    from thinking_context import mount, CharacterProfile

    app = FastAPI()

    class MyAdapter:
        async def get_recent_history(self, room, limit=12):
            return await my_hub.recent(room, limit)

        async def nudge(self, room_id, hint):
            return await my_bots.trigger(room_id, hint)

    mount(app, MyAdapter(), characters=[
        CharacterProfile(character_id="bot-1", name="Alice", role="host"),
    ])

Runtime room management
───────────────────────

    # In any route or startup hook:
    tc = app.state.thinking_context

    await tc.watch_room("lobby")          # start watching
    await tc.release_room("lobby")        # stop watching
    await tc.on_message(room, uid, text)  # feed a message to Jeremy

Full docs: see mount.py and protocols.py

Rear View Foresight LLC — Feic Mo Chroí
"""

from .memory import (
    CharacterMemoryBank,
    CharacterProfile,
    MemoryEntry,
    MemoryType,
    UniversalMemorySystem,
)
from .jeremy import (
    JeremyCricket,
    JeremyConfig,
    create_jeremy_cricket,
)
try:
    from .mount import (
        ThinkingContext,
        get_thinking_context,
        mount,
    )
except ImportError:
    # fastapi not installed — mount/ThinkingContext unavailable
    # Memory, Jeremy, and extractor components still work fine
    ThinkingContext = None       # type: ignore
    get_thinking_context = None  # type: ignore
    mount = None                 # type: ignore
from .protocols import (
    ContextHost,
    HistoryProvider,
    NudgeTarget,
)
from .nudge_queue import NudgeConsumer, NudgeQueue
from .sqlite_backend import SQLiteMemoryBank, SQLiteMemorySystem

__all__ = [
    # Core entry point
    "mount",
    "ThinkingContext",
    "get_thinking_context",
    # Protocols (implement these in your adapter)
    "ContextHost",
    "HistoryProvider",
    "NudgeTarget",
    # Memory
    "UniversalMemorySystem",
    "SQLiteMemorySystem",
    "CharacterProfile",
    "CharacterMemoryBank",
    "SQLiteMemoryBank",
    "MemoryEntry",
    "MemoryType",
    # Jeremy internals (if you need low-level access)
    "JeremyCricket",
    "JeremyConfig",
    "create_jeremy_cricket",
    # Decoupled nudge queue (optional — see nudge_queue.py)
    "NudgeQueue",
    "NudgeConsumer",
]
