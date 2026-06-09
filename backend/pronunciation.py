from __future__ import annotations

import re
from collections.abc import Iterable


ENGLISH_LETTER_NAMES = {
    "A": "ey",
    "B": "bie",
    "C": "ssi",
    "D": "die",
    "E": "ieh",
    "F": "eff",
    "G": "dschie",
    "H": "eytsch",
    "I": "ai",
    "J": "dschey",
    "K": "key",
    "L": "ell",
    "M": "emm",
    "N": "enn",
    "O": "oh",
    "P": "pie",
    "Q": "kju",
    "R": "ar",
    "S": "ess",
    "T": "tie",
    "U": "ju",
    "V": "wie",
    "W": "dabbel ju",
    "X": "ex",
    "Y": "wai",
    "Z": "sie",
}

ENGLISH_INITIALISMS = {
    "ADHD",
    "AGI",
    "AI",
    "API",
    "AR",
    "BIOS",
    "CIA",
    "CPU",
    "CSS",
    "CTO",
    "FBI",
    "FPS",
    "GPU",
    "HTML",
    "HTTP",
    "HTTPS",
    "IT",
    "JSON",
    "LLM",
    "ML",
    "NATO",
    "NSA",
    "OS",
    "PDF",
    "RAM",
    "REST",
    "SQL",
    "UI",
    "UK",
    "URL",
    "US",
    "USA",
    "USB",
    "UX",
    "VPN",
    "VR",
    "XML",
}

DOTTED_INITIALISM_PATTERN = re.compile(
    r"(?<![A-Za-z])(?:[A-Z]\.){2,}[A-Z]?\.?(?![A-Za-z])"
)


def normalize_tts_pronunciation(
    text: str,
    *,
    target_language: str,
    tts_provider: str,
    enabled: bool = True,
    mode: str = "auto",
    english_initialisms: Iterable[str] | None = None,
) -> str:
    if not enabled:
        return text
    if _effective_mode(mode, tts_provider) == "none":
        return text
    if not target_language.lower().startswith("de"):
        return text

    normalized = DOTTED_INITIALISM_PATTERN.sub(
        lambda match: _pronounce_initialism(_letters_only(match.group(0))),
        text,
    )
    bare_pattern = _bare_initialism_pattern(english_initialisms or ENGLISH_INITIALISMS)
    return bare_pattern.sub(
        lambda match: _pronounce_initialism(match.group(0)),
        normalized,
    )


def _letters_only(value: str) -> str:
    return "".join(char for char in value.upper() if "A" <= char <= "Z")


def _pronounce_initialism(value: str) -> str:
    letters = _letters_only(value)
    names = [ENGLISH_LETTER_NAMES[letter] for letter in letters if letter in ENGLISH_LETTER_NAMES]
    return ", ".join(names) if names else value


def _effective_mode(mode: str, tts_provider: str) -> str:
    if mode == "none":
        return "none"
    if mode == "phonetic":
        return "phonetic"
    if tts_provider in {"openai", "elevenlabs", "edge_tts", "gemini"}:
        return "none"
    return "phonetic"


def _bare_initialism_pattern(initialisms: Iterable[str]) -> re.Pattern[str]:
    cleaned = sorted(
        {
            _letters_only(initialism)
            for initialism in initialisms
            if 2 <= len(_letters_only(initialism)) <= 12
        },
        key=len,
        reverse=True,
    )
    if not cleaned:
        return re.compile(r"(?!x)x")
    alternatives = "|".join(re.escape(initialism) for initialism in cleaned)
    return re.compile(rf"(?<![A-Za-z])(?:{alternatives})(?![A-Za-z])")
