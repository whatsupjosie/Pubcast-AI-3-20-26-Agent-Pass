"""
thinking_context/protocols.py
══════════════════════════════
Three interfaces your app implements to connect Thinking Context
to any FastAPI project. These replace all PubCast-specific assumptions.

Your app provides one object that satisfies ContextHost — that's the
entire integration surface. Everything else is handled internally.

Rear View Foresight LLC — Feic Mo Chroí
"""
from __future__ import annotations

from typing import Any, Dict, List, Protocol, runtime_checkable


@runtime_checkable
class HistoryProvider(Protocol):
    """
    Anything that can return recent messages from a room.

    Your Hub, your ChatService, your database wrapper —
    as long as it has get_recent_history(), it works.
    """

    async def get_recent_history(self, room: str, limit: int = 12) -> List[Dict[str, Any]]:
        """
        Return the most recent `limit` messages from the room.

        Each message should be a dict with at least:
            { "user_id": str, "text": str, "ts": float }

        Extra keys are fine and will be ignored.
        Missing keys will be treated as empty strings / 0.
        """
        ...


@runtime_checkable
class NudgeTarget(Protocol):
    """
    Anything that can receive a hint and make an AI respond unprompted.

    Your BotManager, your AgentPool, your single-bot wrapper —
    as long as it has nudge(), it works.
    """

    async def nudge(self, room_id: str, hint: str) -> bool:
        """
        Deliver a stage direction to the most-idle agent in room_id.

        The hint is injected silently into the agent's context.
        Nobody in the room sees it. The agent just knows more.

        Returns True if an agent was successfully nudged.
        Returns False if no eligible agent exists right now.
        """
        ...


@runtime_checkable
class ContextHost(HistoryProvider, NudgeTarget, Protocol):
    """
    The single interface Thinking Context needs from your app.

    Implement both get_recent_history() and nudge() on one object
    and pass it to mount(). That's the entire integration contract.

    ── Minimal implementation example ──────────────────────────────

        class MyAppAdapter:

            def __init__(self, my_hub, my_bot_pool):
                self._hub  = my_hub
                self._bots = my_bot_pool

            async def get_recent_history(self, room, limit=12):
                return await self._hub.recent_messages(room, n=limit)

            async def nudge(self, room_id, hint):
                return await self._bots.inject_and_trigger(room_id, hint)

        adapter = MyAppAdapter(hub, bots)
        # Then pass adapter to thinking_context.mount(app, adapter, ...)

    ────────────────────────────────────────────────────────────────
    """
    ...
