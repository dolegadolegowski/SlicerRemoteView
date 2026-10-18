"""PRO-10: ``normalize_code`` reproduces the PRO-07 cases in ``shared/fixtures/codes``."""

from __future__ import annotations

from typing import Any

import pytest

from remoteview_protocol.alphabet import (
    ALPHABET,
    CODE_HINTS,
    CODE_LENGTH,
    InvalidCodeError,
    is_code,
    normalize_code,
)

from .conftest import FIXTURES_DIR, SCHEMA_DIR, read_json

CASES: list[dict[str, Any]] = read_json(FIXTURES_DIR / "codes" / "normalize-cases.json")["cases"]


@pytest.mark.parametrize("case", CASES, ids=lambda c: repr(c["input"]))
def test_normalize_cases(case: dict[str, Any]) -> None:
    if "code" in case:
        assert normalize_code(case["input"]) == case["code"]
        assert is_code(case["code"])
        return
    with pytest.raises(InvalidCodeError) as info:
        normalize_code(case["input"])
    assert info.value.code == case["error"] == "INVALID_CODE"
    assert info.value.hint_key == case["hint"]
    assert info.value.hint == CODE_HINTS[case["hint"]]
    assert info.value.offending_char == case.get("offendingChar")


def test_alphabet_matches_the_schema_pattern_and_has_no_confusables() -> None:
    defs = read_json(SCHEMA_DIR / "defs.schema.json")["definitions"]
    assert defs["code"]["pattern"] == f"^[{ALPHABET}]{{{CODE_LENGTH}}}$"
    assert len(ALPHABET) == 31
    assert not set("0O1IL") & set(ALPHABET)
    assert CODE_LENGTH == 5


def test_hints_mention_the_confusable_characters() -> None:
    assert "0" in CODE_HINTS["zeroOrO"] and "O" in CODE_HINTS["zeroOrO"]
    for ch in "1IL":
        assert ch in CODE_HINTS["oneIorL"]
    assert set(CODE_HINTS) == {"zeroOrO", "oneIorL", "notInAlphabet", "length", "empty"}


def test_unicode_separators_are_stripped() -> None:
    # U+2010 hyphen, U+2015 horizontal bar, U+2212 minus sign and NBSP between symbols (as code.ts).
    assert normalize_code("7\u20104\u2015X\u2212K\u00a0Q") == "74XKQ"
