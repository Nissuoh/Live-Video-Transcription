from __future__ import annotations

import time
from collections import defaultdict, deque


class FixedWindowRateLimiter:
    def __init__(self, *, window_seconds: float = 60.0) -> None:
        self._window_seconds = window_seconds
        self._events: dict[str, deque[tuple[float, int]]] = defaultdict(deque)

    def allow(self, key: str, *, limit: int, cost: int = 1) -> bool:
        if cost > limit:
            return False
        now = time.monotonic()
        events = self._events[key]
        expires_before = now - self._window_seconds
        while events and events[0][0] <= expires_before:
            events.popleft()
        used = sum(event_cost for _timestamp, event_cost in events)
        if used + cost > limit:
            return False
        events.append((now, cost))
        return True
