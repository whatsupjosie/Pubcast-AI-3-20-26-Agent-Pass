"""
nudge_queue.py
══════════════
Approach B — Event Queue Decoupling.

Jeremy puts nudge events on a shared asyncio.Queue.
BotManager consumes that queue in a background task.
Neither object holds a direct reference to the other.

HOW TO USE:

  In main.py:

      from nudge_queue import NudgeQueue, NudgeConsumer

      nudge_q = NudgeQueue()

      # Pass nudge_q to Jeremy instead of bot_manager
      jeremy = await create_jeremy_cricket(
          memory_system = memory,
          bot_manager   = nudge_q,   # NudgeQueue implements the nudge() interface
          hub           = hub,
      )

      # Pass nudge_q to BotManager and start the consumer
      bm = BotManager(data_dir, hub)
      consumer = NudgeConsumer(nudge_q, bm)
      asyncio.create_task(consumer.run())

  That's it. Jeremy calls nudge_q.nudge() — it enqueues.
  BotManager's consumer dequeues and delivers.
  No circular reference. No construction-order gotcha.

UPGRADING FROM APPROACH A:

  Replace the `bot_manager=bm` argument in create_jeremy_cricket() with
  `bot_manager=nudge_q`. Everything else stays the same.
  Jeremy's internal call to `self._bm.nudge(room_id, hint)` still works
  because NudgeQueue exposes the same async nudge() signature.

Rear View Foresight LLC — Feic Mo Chroí
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Optional

logger = logging.getLogger("nudge_queue")


@dataclass
class NudgeEvent:
    room_id:    str
    hint:       str
    enqueued_at: float = field(default_factory=time.time)

    def age_seconds(self) -> float:
        return time.time() - self.enqueued_at


class NudgeQueue:
    """
    Async queue that exposes the same nudge() interface Jeremy expects.

    Jeremy calls `await self._bm.nudge(room_id, hint)` — this object
    satisfies that contract by enqueuing instead of delivering directly.

    Stale events (older than max_age_seconds) are discarded by the consumer,
    not at enqueue time, so Jeremy's nudge() call always returns immediately.
    """

    def __init__(self, maxsize: int = 64) -> None:
        self._queue: asyncio.Queue[NudgeEvent] = asyncio.Queue(maxsize=maxsize)

    async def nudge(self, room_id: str, hint: str) -> bool:
        """
        Enqueue a nudge event.
        Returns True immediately if enqueued, False if queue is full.
        Jeremy treats the return value as 'was this accepted' — True here
        means Jeremy will record a nudge and apply cooldown, which is correct:
        if the queue is full we don't want Jeremy to immediately retry anyway.
        """
        event = NudgeEvent(room_id=room_id, hint=hint)
        try:
            self._queue.put_nowait(event)
            logger.debug("nudge_queue: enqueued for room '%s' (qsize=%d)", room_id, self._queue.qsize())
            return True
        except asyncio.QueueFull:
            logger.warning("nudge_queue: full — dropped nudge for room '%s'", room_id)
            return False

    async def get(self) -> NudgeEvent:
        return await self._queue.get()

    def task_done(self) -> None:
        self._queue.task_done()

    @property
    def qsize(self) -> int:
        return self._queue.qsize()


class NudgeConsumer:
    """
    Background task that drains the NudgeQueue and delivers to BotManager.

    Construct once and fire with asyncio.create_task(consumer.run()).
    Stop with consumer.stop() — waits for current delivery to finish.
    """

    def __init__(
        self,
        queue:        NudgeQueue,
        bot_manager:  Any,
        max_age:      float = 30.0,   # discard stale events older than this
    ) -> None:
        self._queue      = queue
        self._bm         = bot_manager
        self._max_age    = max_age
        self._running    = False
        self._task: Optional[asyncio.Task] = None

    async def run(self) -> None:
        self._running = True
        logger.info("NudgeConsumer: started.")
        while self._running:
            try:
                event = await asyncio.wait_for(self._queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break

            try:
                age = event.age_seconds()
                if age > self._max_age:
                    logger.debug(
                        "NudgeConsumer: discarding stale event for '%s' (%.1fs old)",
                        event.room_id, age,
                    )
                    continue

                delivered = await self._bm.nudge(event.room_id, event.hint)
                if delivered:
                    logger.info(
                        "NudgeConsumer: delivered to '%s' (queue_age=%.2fs)",
                        event.room_id, age,
                    )
                else:
                    logger.debug(
                        "NudgeConsumer: no eligible bot in '%s' right now.",
                        event.room_id,
                    )
            except Exception as exc:
                logger.error("NudgeConsumer: delivery error for '%s': %s", event.room_id, exc)
            finally:
                self._queue.task_done()

        logger.info("NudgeConsumer: stopped.")

    def stop(self) -> None:
        self._running = False
