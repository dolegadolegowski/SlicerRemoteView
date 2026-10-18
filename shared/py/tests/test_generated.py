"""Generated TypedDicts (PRO-11): one per message type, `type` literals match the schemas."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Literal, get_args, get_type_hints

import pytest

from remoteview_protocol import generated, message_types
from remoteview_protocol.generated import AnyMessage, ErrorCode, SceneUpdate


def _members() -> list[type]:
    """TypedDicts of `AnyMessage`; `viewer.join` is an alias of two required-set variants (§5.1)."""
    members: list[type] = []
    for member in get_args(AnyMessage.__value__):
        value = getattr(member, "__value__", member)
        members.extend(get_args(value) or [value])
    return members


def test_any_message_has_one_typed_dict_per_message_type() -> None:
    discriminators = []
    for member in _members():
        literal = get_type_hints(member)["type"]
        assert get_args(literal), member
        discriminators.append(get_args(literal)[0])
    assert sorted(set(discriminators)) == sorted(message_types())
    assert discriminators.count("viewer.join") == 2


def test_error_message_is_not_named_error() -> None:
    assert not hasattr(generated, "Error")
    assert generated.ErrorMessage.__name__ == "ErrorMessage"


def test_envelope_fields_are_inlined_and_required_keys_match_the_schema() -> None:
    hints = get_type_hints(SceneUpdate, include_extras=False)
    assert set(hints) >= {"protocolVersion", "type", "sceneVersion", "baseVersion", "changes"}
    assert SceneUpdate.__required_keys__ == {
        "protocolVersion",
        "type",
        "sceneVersion",
        "baseVersion",
        "changes",
    }
    assert {"id", "replyTo", "ts"} <= SceneUpdate.__optional_keys__


def test_error_code_literal_lists_the_fifteen_codes() -> None:
    codes = get_args(ErrorCode.__value__)
    assert len(codes) == 15
    assert Literal["INTERNAL"] == Literal[codes[-1]]


@pytest.mark.skipif(shutil.which("node") is None, reason="drift check needs Node (generate.mjs)")
def test_generated_files_are_up_to_date() -> None:
    script = Path(__file__).resolve().parents[2] / "scripts" / "generate.mjs"
    result = subprocess.run(
        ["node", str(script), "--check"], capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stderr
