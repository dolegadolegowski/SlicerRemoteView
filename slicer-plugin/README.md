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
| `RemoteView/Resources/Icons/RemoteView.png` | module icon (128×128), own work generated with a small Python script (no third-party artwork, MIT like the repository) |
| `tests/` | pytest suites run outside Slicer; `conftest.py` provides stub `slicer`/`qt`/`ctk` modules |

## Install in 3D Slicer (developer mode)

Requires 3D Slicer **5.12.x** (Python 3.12).

1. Clone the repository.
2. In Slicer: *Edit → Application Settings → Modules → Additional module paths → Add* and choose
   `<repo>/slicer-plugin/RemoteView` (the directory that contains `RemoteView.py`).
3. Restart Slicer. The module appears under *Modules → Remote → RemoteView*.
4. Optional: enable *Edit → Application Settings → Developer → Enable developer mode* to get the
   *Reload and Test* buttons in the module panel.

The manual checks are in `docs/testing/slicer.md` (§1 module loads).

## Development (outside Slicer)

The pure-Python parts and the adapter (against stub modules) are tested with `pytest` in a local virtual
environment `slicer-plugin/.venv` (git-ignored). Use Python **3.12** to match Slicer 5.12.x. From the repository root:

```bash
python3.12 -m venv slicer-plugin/.venv
slicer-plugin/.venv/bin/python -m pip install pytest==9.1.1 ruff==0.17.1
slicer-plugin/.venv/bin/pytest slicer-plugin
slicer-plugin/.venv/bin/ruff check slicer-plugin
slicer-plugin/.venv/bin/ruff format --check --line-length 100 slicer-plugin
```

Anything that needs a running Slicer is a manual step in `docs/testing/slicer.md`; the sandbox never claims to
have run it (CLAUDE.md rule 10).
