"""Render recognized speech in Kannada script without changing its meaning."""
import re


VOWELS = {
    "a": "", "ɑ": "ಾ", "æ": "ಾ", "e": "ೇ", "ɛ": "ೆ", "i": "ೀ", "ɪ": "ಿ",
    "o": "ೋ", "ɔ": "ಾ", "u": "ೂ", "ʊ": "ು", "ə": "", "ɜ": "ರ್", "ʌ": "ಅ",
}
CONSONANTS = {
    "p": "ಪ್", "b": "ಬ್", "t": "ಟ್", "d": "ಡ್", "k": "ಕ್", "ɡ": "ಗ್", "g": "ಗ್",
    "f": "ಫ್", "v": "ವ್", "s": "ಸ್", "z": "ಜ್", "ʃ": "ಶ್", "ʒ": "ಝ್", "h": "ಹ್",
    "m": "ಮ್", "n": "ನ್", "ŋ": "ಂಗ್", "ɲ": "ಞ್", "l": "ಲ್", "r": "ರ್", "ɹ": "ರ್",
    "j": "ಯ್", "w": "ವ್", "tʃ": "ಚ್", "dʒ": "ಜ್", "θ": "ತ್", "ð": "ದ್",
}
VIRAMA = "್"


def english_to_kannada(text: str) -> str:
    """Phonetically render English words; this is transliteration, never translation."""
    try:
        import eng_to_ipa as ipa
    except ImportError as error:
        raise RuntimeError("The local phonetic rendering component is not installed.") from error
    words = []
    for token in re.findall(r"[A-Za-z']+|[^A-Za-z']+", text):
        if not token or not token[0].isalpha():
            words.append(token)
            continue
        pronunciation = ipa.convert(token)
        # The package returns an asterisk for an unknown word. Preserve a useful,
        # clearly phonetic fallback rather than translating or inventing meaning.
        if not pronunciation or "*" in pronunciation:
            words.append(_latin_fallback(token))
        else:
            words.append(_ipa_to_kannada(pronunciation))
    return "".join(words)


def _ipa_to_kannada(ipa: str) -> str:
    output = []
    index = 0
    while index < len(ipa):
        pair = ipa[index:index + 2]
        char = pair if pair in CONSONANTS else ipa[index]
        if char in CONSONANTS:
            output.append(CONSONANTS[char])
            index += len(char)
            continue
        if char in VOWELS:
            sign = VOWELS[char]
            if output and output[-1].endswith(VIRAMA):
                output[-1] = output[-1][:-1] + sign
            elif sign:
                output.append({"ಾ": "ಆ", "ೇ": "ಏ", "ೆ": "ಎ", "ೀ": "ಈ", "ಿ": "ಇ", "ೋ": "ಓ", "ೂ": "ಊ", "ು": "ಉ"}.get(sign, "ಅ"))
            else:
                output.append("ಅ")
        elif char in "ˈˌ.ː":
            pass
        else:
            output.append(char)
        index += 1
    return "".join(output)


def _latin_fallback(word: str) -> str:
    mapping = {"a": "ಅ", "b": "ಬ", "c": "ಕ", "d": "ಡ", "e": "ಇ", "f": "ಫ", "g": "ಗ", "h": "ಹ", "i": "ಇ", "j": "ಜ", "k": "ಕ", "l": "ಲ", "m": "ಮ", "n": "ನ", "o": "ಒ", "p": "ಪ", "q": "ಕ", "r": "ರ", "s": "ಸ", "t": "ಟ", "u": "ಉ", "v": "ವ", "w": "ವ", "x": "ಕ್ಸ", "y": "ಯ", "z": "ಜ"}
    return "".join(mapping.get(char.lower(), char) for char in word)


def render_in_kannada_script(text: str, source_language: str) -> str:
    if source_language == "en":
        return english_to_kannada(text)
    if source_language == "kn":
        return text
    try:
        from aksharamukha import transliterate
        script = {
            "hi": "Devanagari", "mr": "Devanagari", "ne": "Devanagari", "sa": "Devanagari",
            "bn": "Bengali", "as": "Bengali", "gu": "Gujarati", "pa": "Gurmukhi",
            "ta": "Tamil", "te": "Telugu", "ml": "Malayalam", "or": "Oriya", "si": "Sinhala",
        }.get(source_language)
        if script:
            return transliterate.process(script, "Kannada", text)
    except ImportError:
        pass
    # Never change meaning by translating. For a script that cannot be safely
    # transliterated locally, preserve the recognized words.
    return text
