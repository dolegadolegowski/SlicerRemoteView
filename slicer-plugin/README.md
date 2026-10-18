# slicer-plugin — 3D Slicer extension `SlicerRemoteView` (module `RemoteView`)

Part of **SlicerRemoteView**. Owned by the `slicer` workstream (branch `ws/slicer`, plan
`docs/plan/slicer.md`). Contract: `docs/protocol.md`. Rules: `CLAUDE.md`.

## Purpose

The `RemoteView` module shares the 3D Slicer scene with phones, tablets and Meta Quest headsets: after the user
clicks **Start session** it connects to the relay, shows a 5-character code and streams the visible models and
segments as GLB plus live appearance updates. **Nothing leaves the computer before that click** (Extension Index
opt-in rule, FR-02). Design: `docs/architecture.md` §6, ADR 0005; tasks: `docs/plan/slicer.md`.

## Layout

| Path | Content |
|---|---|
| `CMakeLists.txt` | extension (`project(SlicerRemoteView)`, category `Remote`) — Slicer 5.12.4 extension template |
| `RemoteView/CMakeLists.txt` | `slicerMacroBuildScriptedModule(... WITH_GENERIC_TESTS)`; **every** file under `RemoteView/` is listed (`.py` in `MODULE_PYTHON_SCRIPTS`, everything else in `MODULE_PYTHON_RESOURCES`) — `tests/test_skeleton.py` enforces it |
| `RemoteView/RemoteView.py` | thin Slicer adapter: `RemoteView`, `RemoteViewWidget`, `RemoteViewLogic`, `RemoteViewTest`; import-light (no network, subprocess, pip or runtime-dependency import at import or construction) |
| `RemoteView/remoteview_core/` | pure-Python core (Python 3.12 + numpy, `vtk` for geometry filters only); never imports `slicer`/`qt`/`ctk` — `tests/test_core_purity.py` enforces it; `__version__` lives in `__init__.py` |
| `RemoteView/remoteview_core/coords.py` | RAS mm → glTF m, +Y up (`[x,y,z] = [R,S,−A]·0.001`, protocol §7.1): points, normals, `C·M·C⁻¹` matrices, column-major `node.matrix`, TRS check, winding check |
| `RemoteView/remoteview_core/vendored.py` | the only entry to the protocol package: registers `RemoteView/_vendor/remoteview_protocol` from its file location without running its `__init__` (no `jsonschema` needed — FR-16), never touches `sys.path`, refuses any `remoteview_protocol` module loaded from elsewhere; exports `chunk_header` and `alphabet` |
| `RemoteView/_vendor/remoteview_protocol/` | **generated** copy of `shared/py/remoteview_protocol` with `VENDORED.json` (sha256 per file) — never edit; refresh with `scripts/vendor_shared.py` (ADR 0007 §3) |
| `RemoteView/Resources/Icons/RemoteView.png` | module icon (128×128), own work generated with a small Python script (no third-party artwork, MIT like the repository) |
| `tests/` | pytest suites run outside Slicer; `conftest.py` provides strict stub `slicer`/`qt`/`ctk` modules and puts `RemoteView/` on `sys.path` like Slicer does |
| `.gitattributes` | `RemoteView/_vendor/** -text`: the vendored bytes (and their hashes) survive Windows checkouts |
| `scripts/vendor_shared.py` | vendoring tool: wraps `node shared/scripts/vendor-py.mjs` (Node 22) and has a byte-identical pure-Python port (`--python`, used when Node is missing); `--check` exits 1 on drift |
| `pyproject.toml` | ruff and pytest configuration, direct dev pins (`dev` extra) — development only, Slicer never reads it |
| `requirements-dev.txt` | exact pins of every dev/test package (compiled from the `dev` extra) |

## Install in 3D Slicer (developer mode)

Requires 3D Slicer **5.12.x** (Python 3.12).

1. Clone the repository.
2. In Slicer: *Edit → Application Settings → Modules → Additional module paths → Add* and choose
   `<repo>/slicer-plugin/RemoteView` (the directory that contains `RemoteView.py`).
3. Restart Slicer. The module appears under *Modules → Remote → RemoteView*.
4. Optional: enable *Edit → Application Settings → Developer → Enable developer mode* to get the
   *Reload and Test* buttons in the module panel.

The manual checks are in `docs/testing/slicer.md` (§1 module loads).

## Vendored protocol package

The module must not import from `shared/` (it does not exist next to an installed extension), so
`shared/py/remoteview_protocol` is copied into `RemoteView/_vendor/` and committed. After `shared/py` changes on `main`:

```bash
python3 slicer-plugin/scripts/vendor_shared.py            # refresh the copy (Node 22, or add --python)
python3 slicer-plugin/scripts/vendor_shared.py --check    # exit 1 when the copy drifted (also run by pytest -k vendor)
```

New or removed vendored files must also be listed in `RemoteView/CMakeLists.txt` (`pytest -k skeleton` fails otherwise).
`jsonschema` is not installed in Slicer (FR-16): the core uses only `chunk_header` and `alphabet`; the tests import
`remoteview_protocol.schemas`/`envelope` explicitly (after `remoteview_core.vendored`) to validate messages.

## Development (outside Slicer)

The pure-Python core and the adapter (against stub modules) are tested with `pytest` in a local virtual
environment `slicer-plugin/.venv` (git-ignored). Use Python **3.12** to match Slicer 5.12.x. From the repository root:

```bash
python3.12 -m venv slicer-plugin/.venv
slicer-plugin/.venv/bin/python -m pip install -r slicer-plugin/requirements-dev.txt
slicer-plugin/.venv/bin/pytest slicer-plugin                  # all tests (or -k skeleton, -k purity, …)
slicer-plugin/.venv/bin/ruff check slicer-plugin
slicer-plugin/.venv/bin/ruff format --check slicer-plugin
```

`requirements-dev.txt` pins numpy, the `vtk` wheel (9.6.x like Slicer 5.12), `pygltflib` (test-only GLB reader),
`jsonschema` and `websockets`; none of these is installed into Slicer by these commands. To change a pin, edit the
`dev` extra in `pyproject.toml` and regenerate the file with the `uv pip compile` command in its header (a test
checks that every direct pin appears in it). It installs wheels only (`--only-binary :all:`) and carries no hashes —
the reasoning is in its header.

Anything that needs a running Slicer is a manual step in `docs/testing/slicer.md`; the sandbox never claims to
have run it (CLAUDE.md rule 10).
