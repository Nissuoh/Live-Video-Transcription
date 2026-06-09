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
SPACED_YEAR_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])([12])\s+([0-9])\s+([0-9])\s+([0-9])(?![A-Za-z0-9])"
)
STANDALONE_YEAR_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])((?:1[0-9]{3})|(?:20[0-9]{2}))(?![A-Za-z0-9])"
)

GERMAN_UNDER_20 = {
    0: "",
    1: "eins",
    2: "zwei",
    3: "drei",
    4: "vier",
    5: "fünf",
    6: "sechs",
    7: "sieben",
    8: "acht",
    9: "neun",
    10: "zehn",
    11: "elf",
    12: "zwölf",
    13: "dreizehn",
    14: "vierzehn",
    15: "fünfzehn",
    16: "sechzehn",
    17: "siebzehn",
    18: "achtzehn",
    19: "neunzehn",
}
GERMAN_TENS = {
    20: "zwanzig",
    30: "dreißig",
    40: "vierzig",
    50: "fünfzig",
    60: "sechzig",
    70: "siebzig",
    80: "achtzig",
    90: "neunzig",
}


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
    if not target_language.lower().startswith("de"):
        return text
    if mode == "none":
        return text

    normalized = normalize_german_years(text)
    if _effective_mode(mode, tts_provider) == "none":
        return normalized

    normalized = DOTTED_INITIALISM_PATTERN.sub(
        lambda match: _pronounce_initialism(_letters_only(match.group(0))),
        normalized,
    )
    bare_pattern = _bare_initialism_pattern(english_initialisms or ENGLISH_INITIALISMS)
    return bare_pattern.sub(
        lambda match: _pronounce_initialism(match.group(0)),
        normalized,
    )


def normalize_german_years(text: str) -> str:
    normalized = SPACED_YEAR_PATTERN.sub(
        lambda match: _year_to_german_words(int("".join(match.groups()))),
        text,
    )
    return STANDALONE_YEAR_PATTERN.sub(
        lambda match: _year_to_german_words(int(match.group(1))),
        normalized,
    )


def _year_to_german_words(year: int) -> str:
    if year == 1000:
        return "tausend"
    if 1001 <= year <= 1099:
        rest = _german_under_100(year - 1000)
        return f"tausend {rest}".strip()
    if 1100 <= year <= 1999:
        century = _german_under_100(year // 100)
        rest = _german_under_100(year % 100)
        return f"{century} hundert {rest}".strip()
    if year == 2000:
        return "zweitausend"
    if 2001 <= year <= 2099:
        rest = _german_under_100(year - 2000)
        return f"zweitausend {rest}".strip()
    return str(year)


def _german_under_100(value: int) -> str:
    if value < 20:
        return GERMAN_UNDER_20[value]
    tens = (value // 10) * 10
    ones = value % 10
    if ones == 0:
        return GERMAN_TENS[tens]
    one_word = "ein" if ones == 1 else GERMAN_UNDER_20[ones]
    return f"{one_word}und{GERMAN_TENS[tens]}"


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
