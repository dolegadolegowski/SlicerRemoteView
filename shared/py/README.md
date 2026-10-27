# remoteview_protocol — SlicerRemoteView protocol contract for Python

Part of **SlicerRemoteView** `shared/` (owned by the `protocol` workstream, branch `ws/protocol`, plan
`docs/plan/protocol.md`). Contract: `docs/protocol.md` v1.1 (the library still announces `protocolVersion` `1.0`, which every receiver accepts; PRO-22). Mirrors `shared/ts/` so the Slicer extension and
the TypeScript components agree on every message.

## How it is consumed

Not installed from PyPI: the `slicer` workstream **vendors** this directory into
`slicer-plugin/RemoteView/_vendor/remoteview_protocol/` (ADR 0007 §3, SLC-03) and imports from the vendored path
only:

```bash
node shared/scripts/vendor-py.mjs slicer-plugin/RemoteView/_vendor/remoteview_protocol          # copy
node shared/scripts/vendor-py.mjs slicer-plugin/RemoteView/_vendor/remoteview_protocol --check  # exit 1 on drift
```

The copy is this package directory minus caches plus `VENDORED.json` (`source`, `files: {path: sha256}`), so a
pure-Python fallback can produce and check the same manifest; `--check` compares every file in both directions
(modified, missing and extra files are drift). The package therefore carries everything it needs:

| Path | Content |
|---|---|
| `remoteview_protocol/schema/*.schema.json` | **generated** byte-identical copy of `shared/schema/` (`npm run generate -w shared`; `--check` fails on drift) — package data, loaded with `importlib.resources` |
| `remoteview_protocol/generated.py` | **generated** (`npm run generate -w shared`, datamodel-code-generator 0.85.0): one `TypedDict` per message type (`SceneUpdate`, `ViewerJoin1`/`ViewerJoin2`, `ErrorMessage`, …) and `type AnyMessage = …`; type hints only, no runtime validation — `mypy --strict` clean, excluded from ruff |
| `remoteview_protocol/schemas.py` | `load_schemas()`, `message_types()`, `compile_schemas(tolerate_unknown_enums=False)` → `Validators`, `validate_message(message, type_=None, validators=None)` → `list[Issue]` (JSON Pointer `instance_path`, `keyword`, data-free `message`) |
| `remoteview_protocol/chunk_header.py` | mirror of `ts/chunk.ts` (§6.2-6.3): `encode_chunk_header`/`decode_chunk_header` (12-byte LE `SRVC`), `check_chunk` (receiver rules → `BadSequenceError.field` with the TS vocabulary `length`/`magic`/`sceneVersion`/`chunkIndex`/`payload`), `chunkify(glb, chunk_size)` (views, `ValueError` outside 64 KiB..1 MiB / 1024 chunks / 64 MiB), `encode_chunk_frame`, `chunk_count_for`, `expected_payload_length`, `sha256_hex` |
| `remoteview_protocol/alphabet.py` | mirror of `ts/code.ts` (ADR 0008 §7): `ALPHABET`, `CODE_PATTERN`, `CODE_HINTS` (same keys and English text as TS), `normalize_code(text)` → canonical code or `InvalidCodeError(hint_key, offending_char)`, `is_code` |
| `remoteview_protocol/envelope.py` | mirror of `parseEnvelope`: `parse(text, validators=None)` → dict or `ParseError(code ∈ INVALID_MESSAGE/UNSUPPORTED_TYPE/UNSUPPORTED_VERSION, instance_path, message, issues)` with the same order of checks as TS; `make(type_, **fields)` builds an envelope (`reply_to` → `replyTo`); `dumps(message, validate=False)` compact JSON |
| `remoteview_protocol/__init__.py` | `PROTOCOL_VERSION = "1.0"`, `PROTOCOL_MAJOR`, `__version__`, re-exports of everything above |
| `tests/` | pytest suites; `test_conformance.py` replays `shared/fixtures/messages/expected.json` (PRO-09); `test_generated.py` (PRO-11: one TypedDict per type, drift check via `node shared/scripts/generate.mjs --check`); `test_chunk_header.py`, `test_alphabet.py`, `test_envelope.py` replay the TS vectors of `shared/fixtures/blob`, `shared/fixtures/codes` and the `parseEnvelope` cases (PRO-10) |

Runtime dependency: `jsonschema` only (its `referencing` and `rpds-py` dependencies provide the `$ref` registry;
`rpds-py` has a compiled extension). Python ≥ 3.12 — the interpreter of Slicer 5.12.x (NFR-24, `docs/research/slicer.md`
§1). The vendored copy does **not** bundle `jsonschema`: the `slicer` workstream installs it at extension setup
(`slicer.util.pip_install`, never at import — ADR 0007), see SLC-02/SLC-03.

```python
from remoteview_protocol import compile_schemas, validate_message

validators = (
    compile_schemas()
)  # once per process; clients: compile_schemas(tolerate_unknown_enums=True) (§14)
issues = validate_message(message, validators=validators)
if issues:
    # issues[0].instance_path is a JSON Pointer ("/code"), issues[0].keyword the failed keyword ("pattern");
    # no issue ever contains the offending value, so the list is safe to log or to put in error.details
    ...
```

## Development (from the repository root)

The sandbox has no system `pytest`/`ruff`; use a local virtual environment under `shared/py/.venv`
(git-ignored). With [`uv`](https://docs.astral.sh/uv/) (installed via Homebrew on the dev Mac):

```bash
uv venv --python 3.12 shared/py/.venv
uv pip install --python shared/py/.venv/bin/python -e "shared/py[dev]"
shared/py/.venv/bin/pytest shared/py          # or: npm run test:py -w shared
shared/py/.venv/bin/ruff check shared/py && shared/py/.venv/bin/ruff format --check shared/py   # npm run lint:py -w shared
shared/py/.venv/bin/mypy -p remoteview_protocol --config-file shared/py/pyproject.toml           # strict (py.typed marker present)
```

Without `uv`: `python3.12 -m venv shared/py/.venv && shared/py/.venv/bin/pip install -e "shared/py[dev]"`.
The schemas in the package are regenerated by `npm run generate -w shared` (Node 22); `pytest` fails
(`test_packaged_schemas_equal_shared_schema_directory`) when they drift from `shared/schema/`.
