from __future__ import annotations

import unittest

from backend.pronunciation import normalize_tts_pronunciation


class PronunciationTests(unittest.TestCase):
    def test_german_years_are_spoken_as_years_for_edge_tts_auto_mode(self) -> None:
        result = normalize_tts_pronunciation(
            "Im Jahr 1996 und im Jahr 2000.",
            target_language="de",
            tts_provider="edge_tts",
        )

        self.assertEqual(
            result,
            "Im Jahr neunzehn hundert sechsundneunzig und im Jahr zweitausend.",
        )

    def test_spaced_year_digits_are_joined_before_tts(self) -> None:
        result = normalize_tts_pronunciation(
            "Das war 1 9 9 6, nicht 2 0 0 0.",
            target_language="de-DE",
            tts_provider="openai",
        )

        self.assertEqual(
            result,
            "Das war neunzehn hundert sechsundneunzig, nicht zweitausend.",
        )

    def test_naturalizes_time_percent_currency_and_units(self) -> None:
        result = normalize_tts_pronunciation(
            "Um 18:05 waren es 3,5% bei 120 km/h und $12.50.",
            target_language="de",
            tts_provider="edge_tts",
        )

        self.assertEqual(
            result,
            "Um achtzehn Uhr null fünf waren es drei Komma fünf Prozent "
            "bei hundertzwanzig Kilometer pro Stunde und zwölf Dollar fünfzig Cent.",
        )

    def test_naturalizes_year_ranges_and_links(self) -> None:
        result = normalize_tts_pronunciation(
            "Mehr dazu 1996-2000 auf https://example.com/test.",
            target_language="de",
            tts_provider="edge_tts",
        )

        self.assertEqual(
            result,
            "Mehr dazu neunzehn hundert sechsundneunzig bis zweitausend auf Link.",
        )

    def test_explicit_none_mode_keeps_text_unchanged(self) -> None:
        result = normalize_tts_pronunciation(
            "Im Jahr 1996.",
            target_language="de",
            tts_provider="edge_tts",
            mode="none",
        )

        self.assertEqual(result, "Im Jahr 1996.")

    def test_non_german_target_keeps_text_unchanged(self) -> None:
        result = normalize_tts_pronunciation(
            "In 1996.",
            target_language="en",
            tts_provider="edge_tts",
        )

        self.assertEqual(result, "In 1996.")


if __name__ == "__main__":
    unittest.main()
