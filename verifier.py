"""Text normalisation and cross-source comparison for Bayan.

The Quran's Uthmani text is published by several independent projects. They agree
on the consonants, but differ in how marks, tatweel, hamza carriers and word
spacing are encoded. Comparing raw bytes therefore says nothing useful; comparing
the *consonantal skeleton* says exactly what a reader cares about - is this the
same verse?

Two levels are exposed:

  letters(s)      consonantal skeleton: marks dropped, tatweel dropped, hamza
                  carriers folded onto their base letter, whitespace dropped.
  compare(a, b)   per-source verdict against the canonical text, plus a
                  token-level diff so the UI can point at the differing word.
"""

from __future__ import annotations

import difflib
import re
import unicodedata

# Marks and symbols that carry no consonantal weight. U+06E5/U+06E6 (small waw /
# small yeh) are orthographic marks inside words such as إِبْرَٰهِۦمَ, not letters;
# U+0621 (standalone hamza) is folded away because editions disagree on whether a
# hamza sits on the line or on its carrier.
DROPPED = set("\u0640\u06dd\u06de\u06e9\u06e5\u06e6\u0621")

# Hamza carriers and alef variants fold onto the bare letter.
FOLD = {
    0x0623: "\u0627",  # أ
    0x0625: "\u0627",  # إ
    0x0622: "\u0627",  # آ
    0x0671: "\u0627",  # ٱ
    0x0672: "\u0627",  # ٲ
    0x0673: "\u0627",  # ٳ
    0x0624: "\u0648",  # ؤ
    0x0626: "\u064a",  # ئ
    0x0649: "\u064a",  # ى
}

BASMALA_RAW = "بِسْمِ ٱللَّهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ"


def _strip_marks(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    return "".join(
        ch
        for ch in text
        if unicodedata.category(ch) not in ("Mn", "Me", "Cf") and ch not in DROPPED
    )


def letters(text: str) -> str:
    """Consonantal skeleton: what must match for two editions to agree."""
    return re.sub(r"\s+", "", _strip_marks(text)).translate(FOLD)


BASMALA_LETTERS = letters(BASMALA_RAW)
BASMALA_STRIPPED = _strip_marks(BASMALA_RAW).strip()


def has_basmala(text: str) -> bool:
    return letters(text).startswith(BASMALA_LETTERS)


def verse_core(text: str) -> str:
    """Text with a leading basmala removed, every original mark preserved.

    Tanzil prints the basmala at the head of verse 1 in 112 surahs, while the
    APIs return it separately, so comparisons must drop it. It is always four
    whole words, which makes a word-boundary cut exact - and 1:1, where the
    basmala *is* the verse, is left untouched because nothing follows it.
    """
    tokens = text.split()
    if len(tokens) > 4 and letters(" ".join(tokens[:4])) == BASMALA_LETTERS:
        return " ".join(tokens[4:]).strip()
    return text.strip()


def split_basmala(text: str) -> tuple[str, str]:
    """-> (basmala, verse text). Basmala is '' when the verse does not carry one."""
    core = verse_core(text)
    return ("", core) if core == text.strip() else (BASMALA_RAW, core)


def _tokens(text: str) -> list[str]:
    """Raw word tokens, diacritics intact, so the results can be found in the text."""
    return verse_core(text).split()


def _tok_letters(token: str) -> str:
    return letters(token)


def compare(canonical: str, candidate: str) -> dict:
    """Compare one candidate edition against the canonical text.

    Returns a verdict with the letter-level match and, when they differ, the
    indices of the tokens that disagree (as raw token positions in each side).
    """
    a, b = letters(verse_core(canonical)), letters(verse_core(candidate))
    result = {
        "exact": _strip_marks(verse_core(canonical)).strip()
        == _strip_marks(verse_core(candidate)).strip(),
        "letters_equal": a == b,
        "canonical_len": len(a),
        "candidate_len": len(b),
        "diff_tokens": [],
    }
    if a == b:
        return result

    ta, tb = _tokens(canonical), _tokens(candidate)
    na, nb = [_tok_letters(t) for t in ta], [_tok_letters(t) for t in tb]
    sm = difflib.SequenceMatcher(a=na, b=nb, autojunk=False)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            continue
        result["diff_tokens"].append(
            {
                "op": tag,
                "canonical": " ".join(ta[i1:i2]),
                "candidate": " ".join(tb[j1:j2]),
                "canonical_index": i1,
                "candidate_index": j1,
            }
        )
    return result


def search_form(text: str) -> str:
    """What gets indexed for search: letters only, so diacritics never matter."""
    return letters(text)
