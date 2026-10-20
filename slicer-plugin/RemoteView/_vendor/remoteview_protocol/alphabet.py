"""Session-code alphabet and input normalisation (``docs/protocol.md`` §4.2, ADR 0008 §7).

Mirrors ``shared/ts/code.ts``: codes are 5 symbols from a 31-symbol alphabet without ``0 O 1 I L``.
Typed input is trimmed, stripped of ``-``/space separators and upper-cased; anything outside the
alphabet is rejected with a targeted hint — never mapped, because both members of each confusable
pair are absent from the alphabet.
"""

from __future__ import annotations

import re

ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
CODE_LENGTH = 5
#: Same expression as ``defs.schema.json#/definitions/code``.
CODE_PATTERN = re.compile(r"^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$")

#: User-facing hints of ADR 0008 §7, keyed as ``CODE_HINTS`` in TS (English; UIs localise).
CODE_HINTS: dict[str, str] = {
    "zeroOrO": "codes never contain 0 or O — check that character",
    "oneIorL": "codes never contain 1, I or L",
    "notInAlphabet": "codes use only the letters A–Z (except I, L, O) and the digits 2–9",  # noqa: RUF001 — same text as code.ts
    "length": f"codes have exactly {CODE_LENGTH} characters",
    "empty": "type the 5-character code shown in 3D Slicer",
}

# Separators users type or paste between symbols: whitespace, ASCII hyphen-minus, the Unicode
# dashes U+2010 (hyphen) to U+2015 (horizontal bar) and U+2212 (minus sign); same set as code.ts.
_SEPARATORS = re.compile("[\\s\\u002D\\u2010-\\u2015\\u2212]")


class InvalidCodeError(ValueError):
    """``INVALID_CODE`` with the ADR 0008 §7 hint; ``hint_key`` names the ``CODE_HINTS`` entry."""

    code = "INVALID_CODE"

    def __init__(self, hint_key: str, offending_char: str | None = None) -> None:
        super().__init__(CODE_HINTS[hint_key])
        self.hint_key = hint_key
        self.hint = CODE_HINTS[hint_key]
        self.offending_char = offending_char


def normalize_code(text: str) -> str:
    """``" 7kq4x "`` → ``"7KQ4X"``; ``"7KQ0X"`` → hint about 0/O; ``"7KQ1X"`` → hint about 1/I/L.

    The first offending character decides the hint; length is checked last so a misread symbol is
    reported before a miscount. Raises :class:`InvalidCodeError`.
    """
    stripped = _SEPARATORS.sub("", text).upper()
    if not stripped:
        raise InvalidCodeError("empty")
    for ch in stripped:
        if ch in ALPHABET:
            continue
        if ch in "0O":
            raise InvalidCodeError("zeroOrO", ch)
        if ch in "1IL":
            raise InvalidCodeError("oneIorL", ch)
        raise InvalidCodeError("notInAlphabet", ch)
    if len(stripped) != CODE_LENGTH:
        raise InvalidCodeError("length")
    return stripped


def is_code(value: str) -> bool:
    """True for a canonical code (already upper-case, no separators)."""
    return CODE_PATTERN.fullmatch(value) is not None
