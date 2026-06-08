from __future__ import annotations

import hmac


class AuthTokenValidator:
    def __init__(self, valid_tokens: tuple[str, ...]) -> None:
        if not valid_tokens:
            raise ValueError("AuthTokenValidator requires at least one token")
        self._valid_tokens = valid_tokens

    def is_valid(self, token: str) -> bool:
        candidate = token.strip()
        if not candidate:
            return False
        return any(hmac.compare_digest(candidate, valid) for valid in self._valid_tokens)


class OriginMatcher:
    def __init__(self, patterns: tuple[str, ...]) -> None:
        self._patterns = patterns

    def is_allowed(self, origin: str | None) -> bool:
        if not self._patterns or "*" in self._patterns:
            return True
        if origin is None:
            return False
        normalized = origin.strip().rstrip("/")
        for pattern in self._patterns:
            if pattern == normalized:
                return True
            if pattern.endswith("*") and normalized.startswith(pattern[:-1]):
                return True
        return False
