"""Schema loading and message validation (``docs/protocol.md`` §3.2, §14).

Mirrors ``shared/ts/validate.ts``: one validator per message type, compiled once, with the same
§14 leniency switch for inbound relay messages on clients. Errors are reported as JSON Pointers
and keyword names only — never the offending values — so they are safe to log or to echo in
``error.details``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from importlib import resources
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import ValidationError
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

#: ``$id`` base of every schema file.
SCHEMA_BASE = "https://slicerremoteview.dev/schema/"
_NON_MESSAGE_FILES = ("envelope.schema.json", "defs.schema.json")

JsonObject = dict[str, Any]


def load_schemas() -> dict[str, JsonObject]:
    """Every ``schema/*.schema.json`` shipped with the package, keyed by file name, sorted."""
    root = resources.files(__package__).joinpath("schema")
    out: dict[str, JsonObject] = {}
    for entry in sorted(root.iterdir(), key=lambda e: e.name):
        if entry.name.endswith(".schema.json"):
            out[entry.name] = json.loads(entry.read_text(encoding="utf-8"))
    if not out:
        msg = "no schemas found in the package; run `npm run generate -w shared` (ADR 0007 §2)"
        raise RuntimeError(msg)
    return out


def message_types(schemas: dict[str, JsonObject] | None = None) -> list[str]:
    """Message types of v1.0 = the schema files other than envelope and defs, sorted."""
    files = schemas if schemas is not None else load_schemas()
    return sorted(f.removesuffix(".schema.json") for f in files if f not in _NON_MESSAGE_FILES)


def lenient_enum_definitions(defs: JsonObject) -> list[str]:
    """Definitions whose ``enum`` minor versions may extend (§14): errorCode and every *Reason.

    ``clientInfo.platform`` is already a plain string in the schema, so it needs no entry.
    """
    names = ["errorCode"]
    names.extend(n for n in defs["definitions"] if n.endswith("Reason"))
    return names


#: Same list as ``LENIENT_ENUM_DEFINITIONS`` in ``shared/ts/validate.ts``.
LENIENT_ENUM_DEFINITIONS: tuple[str, ...] = tuple(
    lenient_enum_definitions(load_schemas()["defs.schema.json"])
)


def _lenient_defs(defs: JsonObject) -> JsonObject:
    definitions = dict(defs["definitions"])
    for name in lenient_enum_definitions(defs):
        definition = definitions.get(name)
        if not definition or "enum" not in definition:
            continue
        opened = {k: v for k, v in definition.items() if k != "enum"}
        definitions[name] = {**opened, "type": "string", "minLength": 1, "maxLength": 64}
    return {**defs, "definitions": definitions}


@dataclass(frozen=True, slots=True)
class Issue:
    """One schema violation, in Ajv's vocabulary (same fields as ``ValidationIssue`` in TS)."""

    #: JSON Pointer of the offending value; ``""`` for the root (e.g. a missing required property).
    instance_path: str
    #: Schema keyword that failed (``required``, ``pattern``, ``const``, ``oneOf``, …).
    keyword: str
    #: jsonschema's message with the offending value removed where it would appear.
    message: str


@dataclass(frozen=True, slots=True)
class Validators:
    """Compiled validators: the envelope and one per message type."""

    envelope: Draft202012Validator
    by_type: dict[str, Draft202012Validator]
    tolerate_unknown_enums: bool


def compile_schemas(*, tolerate_unknown_enums: bool = False) -> Validators:
    """Compile every schema once (draft 2020-12, cross-file ``$ref`` via ``$id``).

    ``tolerate_unknown_enums`` is the §14 leniency for *inbound relay messages on clients*: the
    closed enums ``errorCode`` and every ``*Reason`` accept any 1-64-character
    string, so a newer relay's codes do not make a 1.0 client reject the message. The relay
    validates client messages with the strict default.
    """
    schemas = load_schemas()
    if tolerate_unknown_enums:
        schemas["defs.schema.json"] = _lenient_defs(schemas["defs.schema.json"])
    for schema in schemas.values():
        Draft202012Validator.check_schema(schema)
    registry: Registry[Any] = Registry().with_resources(
        (schema["$id"], Resource.from_contents(schema, default_specification=DRAFT202012))
        for schema in schemas.values()
    )

    def validator(file: str) -> Draft202012Validator:
        return Draft202012Validator(schemas[file], registry=registry)

    return Validators(
        envelope=validator("envelope.schema.json"),
        by_type={t: validator(f"{t}.schema.json") for t in message_types(schemas)},
        tolerate_unknown_enums=tolerate_unknown_enums,
    )


def _pointer(parts: list[str | int]) -> str:
    return "".join("/" + str(p).replace("~", "~0").replace("/", "~1") for p in parts)


def _issue(error: ValidationError) -> Issue:
    # jsonschema embeds the offending instance in most messages ("'7KQ0X' does not match …");
    # drop it so issues never carry codes, tokens or payload (CLAUDE.md rule 6, §9.2).
    message = error.message
    if error.validator == "required":
        text = message  # names the missing property, never a value
    elif error.validator == "additionalProperties":
        text = "must NOT have additional properties"
    elif error.validator == "const":
        text = "must be equal to constant"
    else:
        text = f"must satisfy {error.validator}" if error.validator else message
    return Issue(_pointer(list(error.absolute_path)), str(error.validator), text)


def _flatten(errors: Any) -> list[ValidationError]:
    out: list[ValidationError] = []
    for error in errors:
        out.append(error)
        if error.context:
            out.extend(_flatten(error.context))
    return out


def validate_message(
    message: object, type_: str | None = None, validators: Validators | None = None
) -> list[Issue]:
    """Validate a parsed message against the schema of ``type_`` (default: its own ``type``).

    Returns an empty list when the message is valid. Unknown or missing type → a single issue at
    ``/type`` with keyword ``type`` (the caller maps it to ``UNSUPPORTED_TYPE``, PRO-10
    ``envelope.py``). Sub-errors of ``oneOf``/``anyOf`` branches are included, as Ajv reports
    them with ``allErrors``.
    """
    v = validators if validators is not None else _default()
    if not isinstance(message, dict):
        return [Issue("", "type", "must be object")]
    target = type_ if type_ is not None else message.get("type")
    if not isinstance(target, str) or target not in v.by_type:
        return [Issue("/type", "type", "unknown message type for protocol 1.x (§2)")]
    errors = _flatten(v.by_type[target].iter_errors(message))
    issues = [_issue(e) for e in errors]
    # Stable order: by path, then keyword — jsonschema's order depends on dict iteration.
    return sorted(set(issues), key=lambda i: (i.instance_path, i.keyword, i.message))


_DEFAULT: Validators | None = None


def _default() -> Validators:
    global _DEFAULT  # noqa: PLW0603 — process-wide cache, same as `defaultSchemas()` in TS
    if _DEFAULT is None:
        _DEFAULT = compile_schemas()
    return _DEFAULT
