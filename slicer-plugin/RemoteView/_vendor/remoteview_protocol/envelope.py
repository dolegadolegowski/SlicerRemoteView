"""Building and parsing text frames (``docs/protocol.md`` §2, §3.2); mirror of ``parseEnvelope``.

:func:`parse` maps every failure to the §9.2 code the receiver answers with (``INVALID_MESSAGE``,
``UNSUPPORTED_TYPE``, ``UNSUPPORTED_VERSION``) and never carries the offending values (only JSON
Pointers and data-free messages), so a :class:`ParseError` is safe to log or to echo in
``error.details``.
"""

from __future__ import annotations

import json
import re
from typing import Any, Literal

from remoteview_protocol.schemas import (
    Issue,
    Validators,
    _default,
    _flatten,
    _issue,
    validate_message,
)

PROTOCOL_VERSION = "1.0"
PROTOCOL_MAJOR = 1
_VERSION = re.compile(r"^([0-9]+)\.([0-9]+)\Z")

ParseCode = Literal["INVALID_MESSAGE", "UNSUPPORTED_TYPE", "UNSUPPORTED_VERSION"]


class ParseError(ValueError):
    """A text frame the receiver must answer with ``error`` ``code`` (§9.2)."""

    def __init__(
        self, code: ParseCode, instance_path: str, message: str, issues: list[Issue] | None = None
    ) -> None:
        super().__init__(message)
        self.code: ParseCode = code
        #: JSON Pointer of the failing field; ``/type`` or ``/protocolVersion`` when unsupported.
        self.instance_path = instance_path
        #: Developer-facing English (§9.2 ``message``).
        self.message = message
        #: Every violation reported by the schema validator.
        self.issues: list[Issue] = issues or []

    def __repr__(self) -> str:
        return f"ParseError({self.code}, {self.instance_path!r}, {self.message!r})"


def make(type_: str, **fields: Any) -> dict[str, Any]:
    """A message dict with the envelope filled in: ``{"protocolVersion": "1.0", "type": ..., ...}``.

    Payload fields are flat in the envelope (§3.2); ``id``, ``reply_to`` and ``ts`` may be passed as
    keyword arguments (``reply_to`` is emitted as ``replyTo``). Does not validate — use
    :func:`remoteview_protocol.schemas.validate_message` or :func:`dumps` with ``validate=True``.
    """
    message: dict[str, Any] = {"protocolVersion": PROTOCOL_VERSION, "type": type_}
    for key, value in fields.items():
        if value is None and key in ("id", "reply_to", "ts"):
            continue
        message["replyTo" if key == "reply_to" else key] = value
    return message


def dumps(
    message: dict[str, Any], *, validate: bool = False, validators: Validators | None = None
) -> str:
    """Compact JSON for one text frame; with ``validate=True`` raises :class:`ParseError` first."""
    if validate:
        issues = validate_message(message, None, validators)
        if issues:
            raise ParseError(
                "INVALID_MESSAGE",
                issues[0].instance_path,
                f"message does not match the {message.get('type')!s} schema",
                issues,
            )
    return json.dumps(message, separators=(",", ":"), ensure_ascii=False)


def parse(text: str | bytes, validators: Validators | None = None) -> dict[str, Any]:
    """Receiver entry point for one text frame (§3.2); same order of checks as ``parseEnvelope``:

    1. not JSON / not an object → ``INVALID_MESSAGE``;
    2. ``protocolVersion`` is ``MAJOR.MINOR`` with major ≠ 1 → ``UNSUPPORTED_VERSION`` (§2);
    3. envelope shape → ``INVALID_MESSAGE``;
    4. ``type`` unknown in 1.x → ``UNSUPPORTED_TYPE`` (reply ``error``, do not close);
    5. the type's schema → ``INVALID_MESSAGE`` with the JSON Pointer of the first violation.
    """
    try:
        data = json.loads(text)
    except (ValueError, TypeError, UnicodeDecodeError) as exc:
        raise ParseError(
            "INVALID_MESSAGE",
            "",
            "text frame is not valid JSON (§3.2)",
            [Issue("", "json", "must be a JSON document")],
        ) from exc
    if not isinstance(data, dict):
        raise ParseError(
            "INVALID_MESSAGE",
            "",
            "a message is one JSON object (§3.2)",
            [Issue("", "type", "must be object")],
        )
    version = data.get("protocolVersion")
    if isinstance(version, str):
        match = _VERSION.match(version)
        if match and int(match.group(1)) != PROTOCOL_MAJOR:
            raise ParseError(
                "UNSUPPORTED_VERSION",
                "/protocolVersion",
                f"protocol major is not {PROTOCOL_MAJOR}; "
                f"this receiver speaks {PROTOCOL_VERSION} (§2)",
            )
    v = validators if validators is not None else _default()
    envelope_issues = _issues(v.envelope.iter_errors(data))
    if envelope_issues:
        raise ParseError(
            "INVALID_MESSAGE",
            envelope_issues[0].instance_path,
            "message envelope is invalid (§3.2)",
            envelope_issues,
        )
    type_ = data.get("type")
    if not isinstance(type_, str) or type_ not in v.by_type:
        raise ParseError("UNSUPPORTED_TYPE", "/type", "unknown message type for protocol 1.x (§2)")
    issues = validate_message(data, type_, v)
    if issues:
        raise ParseError(
            "INVALID_MESSAGE",
            issues[0].instance_path,
            f"message does not match the {type_} schema",
            issues,
        )
    return data


def _issues(errors: Any) -> list[Issue]:
    return sorted(
        {_issue(e) for e in _flatten(errors)},
        key=lambda i: (i.instance_path, i.keyword, i.message),
    )
