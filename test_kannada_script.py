import unittest
from kannada_script import english_to_kannada, render_in_kannada_script


class KannadaScriptTests(unittest.TestCase):
    def test_english_is_rendered_not_translated(self):
        result = english_to_kannada("good morning")
        self.assertNotIn("ಶುಭೋದಯ", result)
        self.assertTrue(any("ಕ" <= char <= "ಹ" for char in result))

    def test_kannada_is_preserved(self):
        self.assertEqual(render_in_kannada_script("ನಮಸ್ಕಾರ", "kn"), "ನಮಸ್ಕಾರ")

    def test_hindi_is_transliterated_not_translated(self):
        self.assertEqual(render_in_kannada_script("नमस्ते", "hi"), "ನಮಸ್ತೇ")


if __name__ == "__main__":
    unittest.main()
