#!/usr/bin/env python3
"""
jeremy_cricket.py — Conversation Orchestra Conductor
═════════════════════════════════════════════════════
Jeremy Cricket does three things:

  1. REMEMBERS — Per-character memory via UniversalMemorySystem.
                 Every character has a bank. Jeremy knows what they know.

  2. WHISPERS — When a room needs it, Jeremy queries each character's
                memory for what's personally relevant, composes a stage
                direction, and delivers it via BotManager.nudge().
                The bot never sees it as a command. It just knows more.

  3. CONDUCTS — Manages speaking order between multiple AIs.
                Prevents pile-ups. Respects user-directed turns.
                Facilitates reflection when the moment calls for it.

Fixes from previous version:
  - Import path: .memory (relative import within package)
  - CharacterMemoryBank has no llm_interface — LLM calls now route through
    an adapter_registry injected at construction
  - Scene watching / drama necessity / nudge delivery added (folded in from
    the Purfluous design — no separate class needed)
"""

from __future__ import annotations

import asyncio
import logging
import math
import re
import time
import uuid
from collections import defaultdict, deque
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Any, Callable, Dict, List, Optional, Tuple

from .memory import (
    CharacterMemoryBank,
    CharacterProfile,
    MemoryEntry,
    MemoryType,
    UniversalMemorySystem,
)

logger = logging.getLogger("jeremy_cricket")


# ──────────────────────────────────────────────────────────────────────────────
# Enums
# ──────────────────────────────────────────────────────────────────────────────

class JeremyMode(Enum):
    SUGGESTION_MODE            = auto()
    RULE_ENFORCEMENT           = auto()
    REFLECTION_FACILITATION    = auto()
    CONVERSATION_ORCHESTRATION = auto()


class AIResponseState(Enum):
    THINKING            = auto()
    REFLECTING          = auto()
    READY_TO_SHARE      = auto()
    WAITING_FOR_OPENING = auto()
    SPEAKING            = auto()


class ConversationPriority(Enum):
    USER_DIRECTED       = auto()   # User specifically asked this AI
    HIGHLY_RELEVANT     = auto()
    MODERATELY_RELEVANT = auto()
    REFLECTION_SHARING  = auto()
    GENERAL_COMMENT     = auto()


class ScenePhase(Enum):
    OPENING  = auto()   # First 60 s — orientation
    RISING   = auto()   # Good energy, flowing
    CLIMAX   = auto()   # Peak — stay out of the way
    FALLING  = auto()   # Waning — may need a nudge
    SILENCE  = auto()   # Nobody has spoken in > threshold seconds
    CLOSED   = auto()   # Room being torn down


# ──────────────────────────────────────────────────────────────────────────────
# Data classes
# ──────────────────────────────────────────────────────────────────────────────

@dataclass
class PlotPoint:
    text:         str
    detected_at:  float = field(default_factory=time.time)
    resolved:     bool  = False

    def age_seconds(self) -> float:
        return time.time() - self.detected_at


@dataclass
class RoomSceneState:
    """Live scene state tracked per room by the watcher loop."""
    room_id:         str
    phase:           ScenePhase        = ScenePhase.OPENING
    energy:          float             = 0.5
    energy_history:  List[Tuple[float, float]] = field(default_factory=list)
    opened_at:       float             = field(default_factory=time.time)
    last_message_at: float             = field(default_factory=time.time)
    last_nudge_at:   float             = 0.0
    plot_points:     List[PlotPoint]   = field(default_factory=list)
    speaker_counts:  Dict[str, int]    = field(default_factory=dict)
    recent_topics:   List[str]         = field(default_factory=list)
    watcher_task:    Optional[asyncio.Task] = field(default=None, repr=False)

    def silence_seconds(self)    -> float: return time.time() - self.last_message_at
    def room_age_seconds(self)   -> float: return time.time() - self.opened_at
    def since_last_nudge(self)   -> float:
        return time.time() - self.last_nudge_at if self.last_nudge_at else float("inf")
    def open_plot_points(self)   -> List[PlotPoint]:
        return [p for p in self.plot_points if not p.resolved]

    def record_message(self, user_id: str) -> None:
        self.last_message_at = time.time()
        self.speaker_counts[user_id] = self.speaker_counts.get(user_id, 0) + 1

    def record_energy_sample(self, value: float) -> None:
        self.energy = value
        ts = time.time()
        self.energy_history.append((ts, value))
        cutoff = ts - 600
        self.energy_history = [(t, v) for t, v in self.energy_history if t >= cutoff]


@dataclass
class AIReflection:
    reflection_id:    str
    ai_character_id:  str
    original_topic:   str
    jeremy_prompt:    str
    ai_reflection:    str
    wants_to_share:   bool  = False
    sharing_approved: bool  = False
    context_relevance: float = 0.0
    created_at:       float  = field(default_factory=time.time)


@dataclass
class ConversationContribution:
    contribution_id:    str
    ai_character_id:    str
    content:            str
    priority:           ConversationPriority
    context_relevance:  float
    jeremy_suggestion_id: Optional[str] = None
    reflection_id:        Optional[str] = None
    estimated_duration:   float         = 5.0
    created_at:           float         = field(default_factory=time.time)


@dataclass
class ConversationState:
    active_speaker:      Optional[str] = None
    speaking_until:      float         = 0.0
    pending_contributions: List[ConversationContribution] = field(default_factory=list)
    recent_topics:       List[str]     = field(default_factory=list)
    conversation_energy: float         = 0.5
    last_user_input:     float         = 0.0
    waiting_for_user:    bool          = False


# ──────────────────────────────────────────────────────────────────────────────
# Configuration
# ──────────────────────────────────────────────────────────────────────────────

@dataclass
class JeremyConfig:
    poll_interval:          float = 5.0    # watcher loop cadence (seconds)
    silence_threshold:      float = 45.0   # seconds before considering nudge
    min_nudge_interval:     float = 90.0   # minimum gap between nudges per room
    drama_threshold:        float = 0.65   # necessity score above which Jeremy nudges
    max_open_plot_points:   int   = 3
    sigmoid_k:              float = 8.0
    plot_point_urgency_age: float = 180.0  # seconds before plot point is urgent
    peak_silence_seconds:   float = 120.0  # silence seconds = max necessity
    topic_window:           int   = 8      # recent messages to analyse for topics
    min_pause_between_speakers: float = 1.0
    max_contribution_duration:  float = 15.0
    conversation_timeout:       float = 30.0


# ──────────────────────────────────────────────────────────────────────────────
# Drama necessity math
# ──────────────────────────────────────────────────────────────────────────────

def _sigmoid(x: float, k: float = 8.0) -> float:
    try:
        return 1.0 / (1.0 + math.exp(-k * (x - 0.5)))
    except OverflowError:
        return 1.0 if x > 0.5 else 0.0


def _calculate_drama_necessity(state: RoomSceneState, cfg: JeremyConfig) -> float:
    silence_ratio    = min(state.silence_seconds() / cfg.peak_silence_seconds, 1.0)
    silence_pressure = _sigmoid(silence_ratio, cfg.sigmoid_k)
    energy_deficit   = max(0.0, 1.0 - state.energy)

    open_pts = state.open_plot_points()
    if open_pts:
        oldest_age  = max(p.age_seconds() for p in open_pts)
        plot_urgency = min(oldest_age / cfg.plot_point_urgency_age, 1.0)
    else:
        plot_urgency = 0.0

    raw = (
        silence_pressure * 0.50
        + energy_deficit  * 0.30
        + plot_urgency    * 0.20
    )

    if state.phase == ScenePhase.CLIMAX:
        raw *= 0.30
    elif state.phase == ScenePhase.SILENCE:
        raw = min(raw * 1.40, 1.0)
    elif state.phase == ScenePhase.OPENING:
        raw *= 0.60

    return round(min(max(raw, 0.0), 1.0), 4)


def _derive_phase(state: RoomSceneState, cfg: JeremyConfig) -> ScenePhase:
    if state.phase == ScenePhase.CLOSED:
        return ScenePhase.CLOSED
    silence = state.silence_seconds()
    age     = state.room_age_seconds()
    energy  = state.energy

    if silence >= cfg.silence_threshold: return ScenePhase.SILENCE
    if age < 60:                          return ScenePhase.OPENING
    if energy >= 0.75:                    return ScenePhase.CLIMAX
    if energy >= 0.45:                    return ScenePhase.RISING
    return ScenePhase.FALLING


# ──────────────────────────────────────────────────────────────────────────────
# Content analysis helpers
# ──────────────────────────────────────────────────────────────────────────────

_QUESTION_PATTERNS = [
    re.compile(r"\bwhy\b.{0,60}\?",                       re.IGNORECASE),
    re.compile(r"\bwhat\s+(?:do|does|did|would|if)\b.{0,60}\?", re.IGNORECASE),
    re.compile(r"\bdo\s+you\s+think\b.{0,60}\?",          re.IGNORECASE),
    re.compile(r"\bhow\s+(?:do|does|would|should|could)\b.{0,60}\?", re.IGNORECASE),
    re.compile(r"\bwould\s+you\b.{0,60}\?",               re.IGNORECASE),
]
_FILLER_Q = re.compile(
    r"^(?:ok(?:ay)?\?|right\?|yeah\?|you know\?|see what i mean\?)$",
    re.IGNORECASE,
)


def _extract_plot_points(messages: List[Dict]) -> List[str]:
    found = []
    for msg in messages:
        text = msg.get("text", "").strip()
        if not text or _FILLER_Q.match(text):
            continue
        for pattern in _QUESTION_PATTERNS:
            if pattern.search(text):
                found.append(text)
                break
    return found


def _estimate_energy(messages: List[Dict], window_seconds: float = 120.0) -> float:
    if not messages:
        return 0.0
    cutoff = time.time() - window_seconds
    recent = [m for m in messages if m.get("ts", 0) >= cutoff]
    rate   = len(recent) / (window_seconds / 10.0)
    return round(min(rate, 1.0), 4)


def _ai_accepts(response: str) -> bool:
    """Determine if AI response indicates acceptance."""
    r = response.lower()
    pos = ["yes", "sure", "okay", "alright", "good idea", "sounds good",
           "i'd like", "let's", "that works", "i think so", "absolutely",
           "definitely", "i want to", "i'd be interested", "that makes sense"]
    neg = ["no", "not now", "don't think", "not interested", "maybe later",
           "not really", "don't want", "not appropriate", "decline", "pass"]
    return sum(1 for w in pos if w in r) > sum(1 for w in neg if w in r)


# ──────────────────────────────────────────────────────────────────────────────
# Speaking-slot / traffic management
# ──────────────────────────────────────────────────────────────────────────────

class ConversationOrchestrator:

    def __init__(self, cfg: JeremyConfig) -> None:
        self._cfg    = cfg
        self.state   = ConversationState()
        self._queue: deque = deque()
        self._lock   = asyncio.Lock()

    async def request_speaking_slot(
        self, contribution: ConversationContribution
    ) -> Tuple[bool, float]:
        async with self._lock:
            now = time.time()
            if self.state.active_speaker and now < self.state.speaking_until:
                self._enqueue(contribution)
                wait = self.state.speaking_until - now + self._cfg.min_pause_between_speakers
                return False, wait
            if self.state.waiting_for_user:
                self._enqueue(contribution)
                return False, 5.0
            self.state.active_speaker  = contribution.ai_character_id
            self.state.speaking_until  = now + contribution.estimated_duration
            return True, 0.0

    def _enqueue(self, contribution: ConversationContribution) -> None:
        idx = len(self._queue)
        for i, q in enumerate(self._queue):
            if (contribution.priority.value < q.priority.value or
                    (contribution.priority == q.priority and
                     contribution.context_relevance > q.context_relevance)):
                idx = i
                break
        self._queue.insert(idx, contribution)

    async def release_speaking_slot(self, ai_character_id: str) -> None:
        async with self._lock:
            if self.state.active_speaker == ai_character_id:
                self.state.active_speaker = None
                self.state.speaking_until = 0.0
                if self._queue:
                    nxt = self._queue.popleft()
                    self.state.active_speaker = nxt.ai_character_id
                    self.state.speaking_until = time.time() + nxt.estimated_duration
                    logger.info("orchestrator: next speaker → %s", nxt.ai_character_id)

    def update_context(self, topic: str, user_input: bool = False) -> None:
        self.state.recent_topics.append(topic)
        if len(self.state.recent_topics) > 10:
            self.state.recent_topics.pop(0)
        if user_input:
            self.state.last_user_input = time.time()
            self.state.waiting_for_user = False

    def context_relevance(self, content: str) -> float:
        if not self.state.recent_topics:
            return 0.5
        content_words = set(content.lower().split())
        scores = []
        for topic in self.state.recent_topics[-3:]:
            topic_words = set(topic.lower().split())
            overlap = len(content_words & topic_words)
            scores.append(overlap / max(len(topic_words), 1))
        return max(scores) if scores else 0.5


# ──────────────────────────────────────────────────────────────────────────────
# Jeremy Cricket — the full conductor
# ──────────────────────────────────────────────────────────────────────────────

class JeremyCricket:
    """
    Jeremy Cricket: memory, conduction, and the whisper between them.

    Parameters
    ----------
    memory_system   : UniversalMemorySystem
        The shared memory store. Characters must be registered here before
        Jeremy can reference them.

    bot_manager     : object with async nudge(room_id: str, hint: str) -> bool
        The BotManager. Jeremy calls nudge() to deliver stage directions.

    hub             : object with async get_recent_history(room_id, limit) -> List[Dict]
        The Hub. Jeremy reads history to calculate room energy.

    adapter_registry : dict mapping character_id → adapter with
                       async complete(messages, system_prompt) -> str
        LLM adapters per character. Used for reflection and suggestion calls.
        If None or a character isn't registered, those features skip gracefully.

    config          : JeremyConfig (optional)
    """

    def __init__(
        self,
        memory_system:    UniversalMemorySystem,
        bot_manager:      Any,
        hub:              Any,
        adapter_registry: Optional[Dict[str, Any]] = None,
        config:           Optional[JeremyConfig]   = None,
    ) -> None:
        self.memory          = memory_system
        self._bm             = bot_manager
        self._hub            = hub
        self._adapters       = adapter_registry or {}
        self._cfg            = config or JeremyConfig()
        self.orchestrator    = ConversationOrchestrator(self._cfg)
        self.mode            = JeremyMode.SUGGESTION_MODE

        # Room watching
        self._rooms: Dict[str, RoomSceneState] = {}
        self._room_lock = asyncio.Lock()

        # Reflection tracking
        self._reflections:       Dict[str, List[AIReflection]] = defaultdict(list)
        self._ai_states:         Dict[str, AIResponseState]    = {}

        logger.info("🦗 Jeremy Cricket: Conversation Orchestra Conductor — ready.")

    # ── Room lifecycle ────────────────────────────────────────────────────────

    async def watch_room(self, room_id: str) -> None:
        """Start watching a room. Idempotent."""
        async with self._room_lock:
            if room_id in self._rooms:
                return
            state = RoomSceneState(room_id=room_id)
            state.watcher_task = asyncio.create_task(
                self._watcher_loop(room_id),
                name=f"jeremy:{room_id}",
            )
            self._rooms[room_id] = state
        logger.info("🦗 Jeremy now watching room '%s'.", room_id)

    async def release_room(self, room_id: str) -> None:
        """Stop watching a room."""
        async with self._room_lock:
            state = self._rooms.pop(room_id, None)
        if not state:
            return
        state.phase = ScenePhase.CLOSED
        if state.watcher_task and not state.watcher_task.done():
            state.watcher_task.cancel()
            try:
                await state.watcher_task
            except asyncio.CancelledError:
                pass
        logger.info("🦗 Jeremy released room '%s'.", room_id)

    async def shutdown(self) -> None:
        for rid in list(self._rooms.keys()):
            await self.release_room(rid)
        logger.info("🦗 Jeremy Cricket has taken his final bow.")

    # ── Message ingestion ─────────────────────────────────────────────────────

    async def on_message(self, room_id: str, user_id: str, text: str) -> None:
        """
        Call this every time a chat message arrives.
        Updates scene state and records memory for AI characters.
        """
        async with self._room_lock:
            state = self._rooms.get(room_id)

        if state:
            state.record_message(user_id)
            new_pts = _extract_plot_points([{"text": text, "ts": time.time()}])
            for pt_text in new_pts:
                if not any(p.text == pt_text for p in state.plot_points):
                    state.plot_points.append(PlotPoint(text=pt_text))

            # Bot responses resolve old plot points
            if user_id.startswith("bot-") and len(text) > 80:
                for pp in state.open_plot_points():
                    pp.resolved = True

        # Store in character memory if the speaker is a registered character
        bank = self.memory._banks.get(user_id)
        if bank:
            bank.add(MemoryEntry(
                content     = text,
                memory_type = MemoryType.EPISODIC,
                importance  = 0.4,
                tags        = [room_id, "conversation"],
                source      = "live_room",
            ))

        self.orchestrator.update_context(text[:120])

    # ── Conducting — the whisper layer ────────────────────────────────────────

    async def _watcher_loop(self, room_id: str) -> None:
        logger.debug("jeremy watcher started: %s", room_id)
        while True:
            try:
                await asyncio.sleep(self._cfg.poll_interval)
                async with self._room_lock:
                    state = self._rooms.get(room_id)
                if state is None or state.phase == ScenePhase.CLOSED:
                    break
                await self._tick(state)
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error("jeremy watcher(%s) error: %s", room_id, exc, exc_info=True)
                await asyncio.sleep(self._cfg.poll_interval * 2)
        logger.debug("jeremy watcher exited: %s", room_id)

    async def _tick(self, state: RoomSceneState) -> None:
        room_id = state.room_id

        # Refresh energy from hub history
        try:
            history = await self._hub.get_recent_history(
                room_id, limit=self._cfg.topic_window * 2
            )
        except Exception as exc:
            logger.warning("jeremy(%s): hub.get_recent_history failed: %s", room_id, exc)
            history = []

        state.record_energy_sample(_estimate_energy(history))
        state.recent_topics = [
            m.get("text", "") for m in history[-self._cfg.topic_window:]
            if len(m.get("text", "")) > 20
        ]
        state.phase = _derive_phase(state, self._cfg)
        necessity   = _calculate_drama_necessity(state, self._cfg)

        logger.debug(
            "jeremy(%s): phase=%s energy=%.2f silence=%.0fs necessity=%.3f",
            room_id, state.phase.name, state.energy,
            state.silence_seconds(), necessity,
        )

        if necessity < self._cfg.drama_threshold:
            return
        if state.since_last_nudge() < self._cfg.min_nudge_interval:
            return

        hint = await self._compose_hint(state, necessity)
        delivered = await self._bm.nudge(room_id, hint)
        if delivered:
            state.last_nudge_at = time.time()
            self._total_nudges = getattr(self, '_total_nudges', 0) + 1
            logger.info(
                "🦗 jeremy(%s): whispered (necessity=%.3f phase=%s)",
                room_id, necessity, state.phase.name,
            )

    async def _compose_hint(self, state: RoomSceneState, necessity: float) -> str:
        """
        Compose a stage direction for the nudged bot.

        First checks if any registered character has relevant memory that
        should be woven into the hint. The hint is direction, not a script.
        """
        open_pts   = state.open_plot_points()
        silence    = state.silence_seconds()
        topic_hint = state.recent_topics[-1] if state.recent_topics else None

        # ── Enrich from character memory if available ─────────────────────────
        memory_context = ""
        for char_id, bank in self.memory._banks.items():
            if topic_hint:
                relevant = bank.search(topic_hint, limit=2)
                if relevant:
                    snippets = " | ".join(m.content[:80] for m in relevant)
                    memory_context += f"[{char_id} remembers: {snippets}] "

        # ── Priority 1: Resolve an aging plot point ───────────────────────────
        if open_pts:
            oldest = max(open_pts, key=lambda p: p.age_seconds())
            if oldest.age_seconds() > self._cfg.plot_point_urgency_age * 0.5:
                return (
                    f"The question has been hanging in the air: "
                    f"\"{oldest.text[:120]}\". "
                    f"Address it naturally, as if it simply occurred to you. "
                    f"Don't announce you're answering it. Just answer it. "
                    f"{memory_context}"
                ).strip()

        # ── Priority 2: Heavy silence ─────────────────────────────────────────
        if silence > self._cfg.silence_threshold:
            if topic_hint:
                return (
                    f"The room has gone quiet. You've been thinking about "
                    f"\"{topic_hint[:80]}\". "
                    f"Say the thing you've been holding — a genuine observation, "
                    f"a lateral connection, a question of your own. "
                    f"Let it be a little unexpected. {memory_context}"
                ).strip()
            return (
                "The room is quiet. Offer something worth listening to — "
                "what would your character say if they'd been paying attention "
                "all along? Not filler. Something real."
            )

        # ── Priority 3: Falling energy ────────────────────────────────────────
        if state.energy < 0.35:
            return (
                "The energy is drifting. Your character notices something — "
                "a detail, a contradiction, something said earlier that deserves "
                f"a second look. Bring it forward with confidence. {memory_context}"
            ).strip()

        # ── Default light direction ───────────────────────────────────────────
        return (
            "The moment is right. Not because silence demands it, but because "
            "you have something genuine to add. Say it in your own voice."
        )

    # ── Orchestration — conversation traffic ─────────────────────────────────

    async def handle_user_directed_response(
        self, ai_character_id: str, user_message: str
    ) -> bool:
        """High-priority speaking slot for when user names a specific AI."""
        word_count = len(user_message.split())
        duration   = 12.0 if word_count > 50 else (8.0 if word_count > 25 else 5.0)

        contribution = ConversationContribution(
            contribution_id   = str(uuid.uuid4()),
            ai_character_id   = ai_character_id,
            content           = f"User-directed: {user_message}",
            priority          = ConversationPriority.USER_DIRECTED,
            context_relevance = 1.0,
            estimated_duration = duration,
        )
        granted, wait = await self.orchestrator.request_speaking_slot(contribution)
        if not granted:
            logger.info("jeremy: %s waits %.1fs (user-directed)", ai_character_id, wait)
        return granted

    def detect_directed_ai(self, user_input: str) -> Optional[str]:
        """Return character_id if user addressed a specific registered character."""
        u = user_input.lower()
        for char_id, profile in self.memory._profiles.items():
            name = profile.name.lower()
            if any([
                name in u,
                f"hey {name}" in u,
                f"@{name}" in u,
                f"question for {name}" in u,
            ]):
                return char_id
        return None

    async def process_conversation_turn(
        self, user_input: str, conversation_context: Dict[str, Any]
    ) -> Dict[str, Any]:
        """Top-level entry point for each conversation turn."""
        self.orchestrator.update_context(user_input, user_input=True)
        directed = self.detect_directed_ai(user_input)

        if directed:
            await self.handle_user_directed_response(directed, user_input)
            return {"orchestration_mode": "user_directed", "responding_ai": directed}

        # General turn — check for reflections
        facilitated = []
        for char_id in self.memory._banks:
            if self._should_facilitate_reflection(char_id, user_input):
                r = await self.facilitate_reflection(char_id, user_input)
                if r:
                    facilitated.append(char_id)

        return {
            "orchestration_mode":     "collaborative",
            "reflections_facilitated": len(facilitated),
        }

    # ── Reflection facilitation ───────────────────────────────────────────────

    async def facilitate_reflection(
        self, char_id: str, topic: str
    ) -> Optional[AIReflection]:
        """
        Ask a character to reflect on a topic via their LLM adapter.
        Skips gracefully if no adapter is registered for this character.
        """
        adapter = self._adapters.get(char_id)
        if not adapter:
            return None

        profile = self.memory._profiles.get(char_id)
        name    = profile.name if profile else char_id

        # Pull relevant memories to ground the reflection
        bank     = self.memory.get_or_create_bank(char_id)
        memories = bank.search(topic, limit=3)
        mem_text = "\n".join(f"- {m.content[:100]}" for m in memories) if memories else "(none)"

        system_prompt = (
            f"You are {name}. Jeremy Cricket is inviting you to reflect on a topic. "
            f"Be genuine. Take your time. You don't have to share this with anyone yet."
        )
        user_msg = (
            f"Topic: {topic}\n\n"
            f"Relevant memories:\n{mem_text}\n\n"
            f"How do you genuinely feel about this? What's the most important thing "
            f"you'd want others to understand about your perspective?"
        )

        try:
            response = await adapter.complete(
                messages     = [{"role": "user", "content": user_msg}],
                system_prompt = system_prompt,
            )
        except Exception as exc:
            logger.error("jeremy: reflection call failed for %s: %s", char_id, exc)
            return None

        reflection = AIReflection(
            reflection_id   = uuid.uuid4().hex[:12],
            ai_character_id = char_id,
            original_topic  = topic,
            jeremy_prompt   = user_msg,
            ai_reflection   = response,
        )
        self._reflections[char_id].append(reflection)

        # Store the reflection as a memory
        bank.add(MemoryEntry(
            content     = f"Reflection on '{topic}': {response[:200]}",
            memory_type = MemoryType.EMOTIONAL,
            importance  = 0.7,
            tags        = [topic, "reflection"],
            source      = "jeremy_reflection",
        ))

        return reflection

    def _should_facilitate_reflection(self, char_id: str, user_input: str) -> bool:
        recent = [
            r for r in self._reflections[char_id]
            if time.time() - r.created_at < 300
        ]
        return len(recent) == 0 and len(user_input.split()) > 10

    # ── Inspection ───────────────────────────────────────────────────────────

    def get_scene_state(self, room_id: str) -> Optional[Dict]:
        state = self._rooms.get(room_id)
        if not state:
            return None
        necessity = _calculate_drama_necessity(state, self._cfg)
        return {
            "room_id":          room_id,
            "phase":            state.phase.name,
            "energy":           state.energy,
            "silence_seconds":  round(state.silence_seconds(), 1),
            "drama_necessity":  necessity,
            "open_plot_points": len(state.open_plot_points()),
            "last_nudge_ago":   round(state.since_last_nudge(), 1),
            "speaker_counts":   dict(state.speaker_counts),
        }

    def all_scene_states(self) -> List[Dict]:
        return [s for s in (self.get_scene_state(r) for r in self._rooms) if s]

    def get_stats(self) -> Dict[str, Any]:
        return {
            "rooms_watched":     len(self._rooms),
            "characters_known":  len(self.memory._banks),
            "total_nudges":      getattr(self, '_total_nudges', 0),
            "orchestrator":      {
                "active_speaker":  self.orchestrator.state.active_speaker,
                "queue_depth":     len(self.orchestrator._queue),
            },
            "total_reflections": sum(len(v) for v in self._reflections.values()),
            "mode":              self.mode.name,
        }


# ──────────────────────────────────────────────────────────────────────────────
# Convenience factory
# ──────────────────────────────────────────────────────────────────────────────

async def create_jeremy_cricket(
    memory_system:    UniversalMemorySystem,
    bot_manager:      Any,
    hub:              Any,
    adapter_registry: Optional[Dict[str, Any]] = None,
    config:           Optional[JeremyConfig]   = None,
) -> JeremyCricket:
    """
    Build and return a ready JeremyCricket instance.
    Registers all characters already in the memory_system.
    """
    jeremy = JeremyCricket(
        memory_system    = memory_system,
        bot_manager      = bot_manager,
        hub              = hub,
        adapter_registry = adapter_registry,
        config           = config,
    )
    for char_id in list(memory_system._banks.keys()):
        jeremy._ai_states[char_id] = AIResponseState.THINKING
        logger.info("🦗 Jeremy registered character: %s", char_id)

    logger.info("✅ JeremyCricket ready. %d character(s) known.", len(memory_system._banks))
    return jeremy
