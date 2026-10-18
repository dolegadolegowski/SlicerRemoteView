"""PRO-10: ``envelope.parse`` maps failures to the same §9.2 codes as ``parseEnvelope`` in TS."""

from __future__ import annotations

import json
from typing import Any

import pytest

from remoteview_protocol import compile_schemas
from remoteview_protocol.envelope import PROTOCOL_VERSION, ParseError, dumps, make, parse

from .conftest import FIXTURES_DIR, read_json

STRICT = compile_schemas()


def _example(type_: str) -> dict[str, Any]:
    return read_json(FIXTURES_DIR / "messages" / type_ / "valid-example.json")


def _fail(text: str) -> ParseError:
    with pytest.raises(ParseError) as info:
        parse(text, STRICT)
    return info.value


def test_every_valid_fixture_parses_and_every_invalid_one_fails_like_typescript() -> None:
    expected = read_json(FIXTURES_DIR / "messages" / "expected.json")["fixtures"]
    for entry in expected:
        raw = read_json(FIXTURES_DIR / "messages" / entry["file"])
        if entry["valid"]:
            assert parse(json.dumps(raw), STRICT)["type"] == entry["type"], entry["file"]
            continue
        message = raw["message"]
        error = _fail(json.dumps(message))
        major = str(message.get("protocolVersion")).split(".", maxsplit=1)[0]
        if entry["file"].endswith("/invalid-type-const.json"):
            assert error.code == "UNSUPPORTED_TYPE", entry["file"]
        elif major.isdigit() and major != "1" and "." in str(message.get("protocolVersion")):
            assert error.code == "UNSUPPORTED_VERSION", entry["file"]
        else:
            assert error.code == "INVALID_MESSAGE", entry["file"]
            paths = {i.instance_path for i in error.issues}
            assert entry["instancePath"] in paths, (entry["file"], paths)


def test_envelope_failures_map_to_the_9_2_codes() -> None:
    ping = _example("ping")
    assert _fail("not json").code == "INVALID_MESSAGE"
    assert _fail("[1]").code == "INVALID_MESSAGE"
    assert _fail("null").code == "INVALID_MESSAGE"
    err = _fail(json.dumps({**ping, "protocolVersion": "2.0"}))
    assert (err.code, err.instance_path) == ("UNSUPPORTED_VERSION", "/protocolVersion")
    assert _fail(json.dumps({**ping, "protocolVersion": "0.9"})).code == "UNSUPPORTED_VERSION"
    err = _fail(json.dumps({**ping, "protocolVersion": "1"}))
    assert (err.code, err.instance_path) == ("INVALID_MESSAGE", "/protocolVersion")
    assert _fail(json.dumps({**ping, "protocolVersion": 1})).code == "INVALID_MESSAGE"
    # Same predicate as the TS regex: no trailing newline, ASCII digits only.
    assert _fail(json.dumps({**ping, "protocolVersion": "2.0\n"})).code == "INVALID_MESSAGE"
    assert _fail(json.dumps({**ping, "protocolVersion": "\u0662.0"})).code == "INVALID_MESSAGE"
    err = _fail(json.dumps({k: v for k, v in ping.items() if k != "protocolVersion"}))
    assert (err.code, err.instance_path) == ("INVALID_MESSAGE", "")
    err = _fail(json.dumps({**ping, "type": "scene.camera"}))
    assert (err.code, err.instance_path) == ("UNSUPPORTED_TYPE", "/type")
    assert _fail(json.dumps({**ping, "type": "Ping"})).code == "INVALID_MESSAGE"
    err = _fail(json.dumps({**ping, "id": "x" * 33}))
    assert (err.code, err.instance_path) == ("INVALID_MESSAGE", "/id")
    # Minor versions are additive (§2); unknown fields are accepted (§14).
    assert parse(json.dumps({**ping, "protocolVersion": "1.7"}), STRICT)["protocolVersion"] == "1.7"
    assert parse(json.dumps({**ping, "futureField": 1}), STRICT)["futureField"] == 1
    assert parse(json.dumps(ping))  # default validators
    assert PROTOCOL_VERSION == "1.0"


def test_errors_never_contain_the_offending_value() -> None:
    joined = {**_example("viewer.joined"), "viewerToken": "SECRET-not-base64url!"}
    err = _fail(json.dumps(joined))
    assert err.instance_path == "/viewerToken"
    assert (
        "SECRET" not in repr(err) and "SECRET" not in repr(err.issues) and "SECRET" not in str(err)
    )
    huge = _fail(json.dumps({**_example("ping"), "protocolVersion": "9" * 200 + ".0"}))
    assert huge.code == "UNSUPPORTED_VERSION" and "99" not in huge.message


def test_make_and_dumps_build_valid_frames() -> None:
    ping = make("ping", id="hb-102", ts=1792238445000)
    assert ping == {"protocolVersion": "1.0", "type": "ping", "id": "hb-102", "ts": 1792238445000}
    pong = make("pong", reply_to="hb-102", ts=1, serverTs=1, id=None)
    assert pong == {
        "protocolVersion": "1.0",
        "type": "pong",
        "replyTo": "hb-102",
        "ts": 1,
        "serverTs": 1,
    }
    text = dumps(pong, validate=True, validators=STRICT)
    assert text == '{"protocolVersion":"1.0","type":"pong","replyTo":"hb-102","ts":1,"serverTs":1}'
    assert parse(text, STRICT) == pong
    close = make("session.close", reason="USER_STOPPED")
    assert parse(dumps(close, validate=True), STRICT) == close
    with pytest.raises(ParseError) as info:
        dumps(make("session.close", reason="BECAUSE"), validate=True, validators=STRICT)
    assert info.value.code == "INVALID_MESSAGE" and info.value.instance_path == "/reason"
    assert dumps(make("error", code="INTERNAL", message="x")) == (
        '{"protocolVersion":"1.0","type":"error","code":"INTERNAL","message":"x"}'
    )
