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
