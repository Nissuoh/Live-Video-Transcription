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
URL_PATTERN = re.compile(r"(?<![\w@])(?:https?://|www\.)[^\s<>()]+", re.IGNORECASE)
EMAIL_PATTERN = re.compile(
    r"(?<![\w.-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![\w.-])"
)
TIME_PATTERN = re.compile(r"(?<![A-Za-z0-9])([0-2]?\d):([0-5]\d)(?![A-Za-z0-9])")
CURRENCY_BEFORE_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])([$€£])\s*([0-9]{1,6}(?:[,.][0-9]{1,2})?)(?![A-Za-z0-9])"
)
CURRENCY_AFTER_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])([0-9]{1,6}(?:[,.][0-9]{1,2})?)\s*(€|EUR|USD|\$|GBP|£)(?![A-Za-z0-9])",
    re.IGNORECASE,
)
PERCENT_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])([0-9]{1,4}(?:[,.][0-9]{1,2})?)\s*%(?![A-Za-z0-9])"
)
UNIT_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])([0-9]{1,5}(?:[,.][0-9]{1,2})?)\s*"
    r"(km/h|mph|GHz|MHz|Hz|GB|MB|KB|TB|fps|kg|mg|cm|mm|km|m|g|ms|min|s)"
    r"(?![A-Za-z0-9])",
    re.IGNORECASE,
)
YEAR_RANGE_PATTERN = re.compile(
    r"(?<![A-Za-z0-9])((?:1[0-9]{3})|(?:20[0-9]{2}))\s*[-–]\s*"
    r"((?:1[0-9]{3})|(?:20[0-9]{2}))(?![A-Za-z0-9])"
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
UNIT_NAMES = {
    "cm": "Zentimeter",
    "fps": "Bilder pro Sekunde",
    "g": "Gramm",
    "gb": "Gigabyte",
    "ghz": "Gigahertz",
    "hz": "Hertz",
    "kb": "Kilobyte",
    "kg": "Kilogramm",
    "km": "Kilometer",
    "km/h": "Kilometer pro Stunde",
    "m": "Meter",
    "mb": "Megabyte",
    "mg": "Milligramm",
    "mhz": "Megahertz",
    "min": "Minuten",
    "mm": "Millimeter",
    "mph": "Meilen pro Stunde",
    "ms": "Millisekunden",
    "s": "Sekunden",
    "tb": "Terabyte",
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

    normalized = normalize_german_speech_text(text)
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


def normalize_german_speech_text(text: str) -> str:
    normalized = URL_PATTERN.sub(lambda match: _replace_url(match.group(0)), text)
    normalized = EMAIL_PATTERN.sub("E-Mail-Adresse", normalized)
    normalized = TIME_PATTERN.sub(
        lambda match: _time_to_german_words(int(match.group(1)), int(match.group(2))),
        normalized,
    )
    normalized = CURRENCY_BEFORE_PATTERN.sub(
        lambda match: _currency_to_german_words(match.group(2), match.group(1)),
        normalized,
    )
    normalized = CURRENCY_AFTER_PATTERN.sub(
        lambda match: _currency_to_german_words(match.group(1), match.group(2)),
        normalized,
    )
    normalized = PERCENT_PATTERN.sub(
        lambda match: f"{_number_to_german_words(match.group(1), one_as_ein=True)} Prozent",
        normalized,
    )
    normalized = UNIT_PATTERN.sub(
        lambda match: _unit_to_german_words(match.group(1), match.group(2)),
        normalized,
    )
    normalized = normalize_german_years(normalized)
    return re.sub(r"\s+", " ", normalized).strip()


def normalize_german_years(text: str) -> str:
    normalized = YEAR_RANGE_PATTERN.sub(
        lambda match: (
            f"{_year_to_german_words(int(match.group(1)))} bis "
            f"{_year_to_german_words(int(match.group(2)))}"
        ),
        text,
    )
    normalized = SPACED_YEAR_PATTERN.sub(
        lambda match: _year_to_german_words(int("".join(match.groups()))),
        normalized,
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


def _replace_url(value: str) -> str:
    trailing = ""
    while value and value[-1] in ".,;:!?":
        trailing = value[-1] + trailing
        value = value[:-1]
    return f"Link{trailing}"


def _time_to_german_words(hour: int, minute: int) -> str:
    if hour > 23:
        return f"{hour}:{minute:02d}"
    hour_text = _german_cardinal(hour)
    if minute == 0:
        return f"{hour_text} Uhr"
    minute_text = (
        f"null {_german_cardinal(minute)}" if minute < 10 else _german_cardinal(minute)
    )
    return f"{hour_text} Uhr {minute_text}"


def _currency_to_german_words(amount: str, currency: str) -> str:
    normalized_currency = currency.upper()
    if normalized_currency in {"$", "USD"}:
        unit = "Dollar"
    elif normalized_currency in {"£", "GBP"}:
        unit = "Pfund"
    else:
        unit = "Euro"

    integer, fraction = _split_number(amount)
    if fraction is None:
        return f"{_german_cardinal(integer, one_as_ein=True)} {unit}"

    cents = int(fraction.ljust(2, "0")[:2])
    if cents == 0:
        return f"{_german_cardinal(integer, one_as_ein=True)} {unit}"
    return (
        f"{_german_cardinal(integer, one_as_ein=True)} {unit} "
        f"{_german_cardinal(cents)} Cent"
    )


def _unit_to_german_words(amount: str, unit: str) -> str:
    unit_name = UNIT_NAMES.get(unit.lower(), unit)
    return f"{_number_to_german_words(amount, one_as_ein=True)} {unit_name}"


def _number_to_german_words(value: str, *, one_as_ein: bool = False) -> str:
    integer, fraction = _split_number(value)
    if fraction is None:
        return _german_cardinal(integer, one_as_ein=one_as_ein)
    decimals = " ".join(_german_cardinal(int(digit)) for digit in fraction)
    return f"{_german_cardinal(integer)} Komma {decimals}"


def _split_number(value: str) -> tuple[int, str | None]:
    normalized = value.replace(",", ".")
    if "." not in normalized:
        return int(normalized), None
    integer, fraction = normalized.split(".", 1)
    return int(integer), fraction


def _german_cardinal(value: int, *, one_as_ein: bool = False) -> str:
    if value == 1 and one_as_ein:
        return "ein"
    if value < 100:
        return _german_under_100(value)
    if value < 1000:
        hundreds = value // 100
        rest = value % 100
        prefix = "hundert" if hundreds == 1 else f"{_german_under_100(hundreds)}hundert"
        if rest == 0:
            return prefix
        return f"{prefix}{_german_under_100(rest)}"
    if value < 1_000_000:
        thousands = value // 1000
        rest = value % 1000
        prefix = "tausend" if thousands == 1 else f"{_german_cardinal(thousands)}tausend"
        if rest == 0:
            return prefix
        return f"{prefix} {_german_cardinal(rest)}"
    return str(value)


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
