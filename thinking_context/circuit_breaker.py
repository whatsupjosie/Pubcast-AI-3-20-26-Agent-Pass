"""
circuit_breaker.py
═══════════════════════════════════════════════════════════════════════════
Circuit Breaker Pattern — Fault-tolerant service protection.
Thread-safe. CLOSED / OPEN / HALF_OPEN states.

Rear View Foresight LLC — Feic Mo Chroí
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, Optional, TypeVar

logger = logging.getLogger(__name__)
T = TypeVar("T")

_REGISTRY: Dict[str, "CircuitBreaker"] = {}
_REGISTRY_LOCK = threading.Lock()


class CircuitState(str, Enum):
    CLOSED    = "closed"
    OPEN      = "open"
    HALF_OPEN = "half_open"


@dataclass
class CircuitStats:
    total_calls:           int   = 0
    successful_calls:      int   = 0
    failed_calls:          int   = 0
    rejected_calls:        int   = 0
    last_failure_time:     float = 0.0
    last_success_time:     float = 0.0
    consecutive_failures:  int   = 0
    consecutive_successes: int   = 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "total_calls":           self.total_calls,
            "successful_calls":      self.successful_calls,
            "failed_calls":          self.failed_calls,
            "rejected_calls":        self.rejected_calls,
            "last_failure_time":     self.last_failure_time,
            "last_success_time":     self.last_success_time,
            "consecutive_failures":  self.consecutive_failures,
            "consecutive_successes": self.consecutive_successes,
            "success_rate": (
                self.successful_calls / self.total_calls
                if self.total_calls > 0 else 1.0
            ),
        }


class CircuitOpenError(Exception):
    """Raised when circuit is open and a request is rejected."""


class CircuitBreaker:
    """Thread-safe circuit breaker."""

    def __init__(
        self,
        failure_threshold: int   = 5,
        success_threshold: int   = 2,
        recovery_timeout:  float = 30.0,
        name:              str   = "breaker",
    ) -> None:
        self.failure_threshold = failure_threshold
        self.success_threshold = success_threshold
        self.recovery_timeout  = recovery_timeout
        self.name              = name

        self._state                 = CircuitState.CLOSED
        self._last_failure_time     = 0.0
        self._consecutive_failures  = 0
        self._consecutive_successes = 0
        self._lock                  = threading.RLock()
        self._stats                 = CircuitStats()

    def call(self, func: Callable[..., T], *args: Any, **kwargs: Any) -> T:
        with self._lock:
            if self._state == CircuitState.OPEN:
                if time.time() - self._last_failure_time > self.recovery_timeout:
                    self._state = CircuitState.HALF_OPEN
                    self._consecutive_successes = 0
                    logger.info("CircuitBreaker '%s': HALF_OPEN", self.name)
                else:
                    self._stats.rejected_calls += 1
                    raise CircuitOpenError(
                        f"CircuitBreaker '{self.name}' OPEN — service unavailable"
                    )
        try:
            result = func(*args, **kwargs)
            self._on_success()
            return result
        except Exception:
            self._on_failure()
            raise

    def _on_success(self) -> None:
        with self._lock:
            self._stats.total_calls += 1
            self._stats.successful_calls += 1
            self._stats.consecutive_successes += 1
            self._stats.consecutive_failures = 0
            self._stats.last_success_time = time.time()
            if (self._state == CircuitState.HALF_OPEN
                    and self._stats.consecutive_successes >= self.success_threshold):
                self._state = CircuitState.CLOSED
                logger.info("CircuitBreaker '%s': CLOSED — recovered", self.name)

    def _on_failure(self) -> None:
        with self._lock:
            self._stats.total_calls += 1
            self._stats.failed_calls += 1
            self._stats.consecutive_failures += 1
            self._stats.consecutive_successes = 0
            self._stats.last_failure_time = time.time()
            self._last_failure_time = time.time()
            if self._stats.consecutive_failures >= self.failure_threshold:
                self._state = CircuitState.OPEN
                logger.warning("CircuitBreaker '%s': OPEN — too many failures", self.name)

    @property
    def state(self)    -> CircuitState: return self._state
    @property
    def is_closed(self) -> bool:        return self._state == CircuitState.CLOSED
    @property
    def is_open(self)   -> bool:        return self._state == CircuitState.OPEN

    def get_stats(self) -> Dict[str, Any]:
        with self._lock:
            return {**self._stats.to_dict(), "state": self._state.value, "name": self.name}

    def reset(self) -> None:
        with self._lock:
            self._state = CircuitState.CLOSED
            self._consecutive_failures = 0
            self._consecutive_successes = 0


def get_breaker(name: str, **kwargs: Any) -> CircuitBreaker:
    """Get or create a named CircuitBreaker (global registry)."""
    with _REGISTRY_LOCK:
        if name not in _REGISTRY:
            _REGISTRY[name] = CircuitBreaker(name=name, **kwargs)
        return _REGISTRY[name]
