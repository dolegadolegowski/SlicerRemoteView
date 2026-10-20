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
| `RemoteView/RemoteView.py` | thin Slicer adapter: `RemoteView`, `RemoteViewWidget` (loads `Resources/UI/RemoteView.ui`, remembers the relay address and CA path in `QSettings`, shows the consent statement of `remoteview_core.consent` for the address being typed, starts sessions with `RemoteViewLogic.sceneApi` as the scene, renders `remoteview_core.panel` views, 50 ms `QTimer` pump, closes a running session on unload), `RemoteViewLogic` (`sceneApi()`: `remoteview_core.mrml_scene` over Slicer's `getNodesByClass` and folder display node), `RemoteViewTest`; import-light: no network, subprocess, pip or runtime-dependency import at import or construction — the session code of `remoteview_core` is imported only when *Start session* is clicked |
| `RemoteView/remoteview_core/` | pure-Python core (Python 3.12 + numpy, `vtk` for geometry filters only); never imports `slicer`/`qt`/`ctk` — `tests/test_core_purity.py` enforces it; `__version__` lives in `__init__.py` |
| `RemoteView/remoteview_core/collect.py` | MRML collection (architecture §6.4): `collect_scene(scene_api)` → `Entity` per model node via an injectable `SceneApi` (the Slicer one is `mrml_scene.py`); VTK pipeline on a geometry-only deep copy whose cells are checked first (integer IDs in range — the filters do not bounds-check) (`vtkTriangleFilter` → triangles repeating a vertex dropped → `vtkPolyDataNormals`, `vtkmodules` imports), linear world matrix → `T.matrix`, names from `names.py`; nodes without triangles or with a non-linear/sheared transform are skipped and reported, never abort the snapshot; main thread only |
| `RemoteView/remoteview_core/consent.py` | the consent statement shown before *Start session* (SLC-22; R-06, NFR-16): what is sent to which relay host and who can see it; names only the host of the typed address (no user info, port, path or query), says when `ws://` is unencrypted and names a `ws://` host only on this computer (Start refuses others); standard library only |
| `RemoteView/remoteview_core/coords.py` | RAS mm → glTF m, +Y up (`[x,y,z] = [R,S,−A]·0.001`, protocol §7.1): points, normals, `C·M·C⁻¹` matrices, column-major `node.matrix`, TRS check, winding check |
| `RemoteView/remoteview_core/glb_writer.py` | `write_glb(entities, RootExtras) -> bytes` (and `is_exportable_matrix`, its rule for `T.matrix`): one GLB per snapshot (protocol §7): root `SlicerRemoteView` with §7.1 extras, per entity `T` (extras §7.3, TRS `matrix`) + one mesh child `M`, float32 `POSITION`/`NORMAL`, uint16/uint32 indices, one PBR material; deterministic bytes; strict input validation (`GlbWriteError`) |
| `RemoteView/remoteview_core/mrml_scene.py` | the Slicer `SceneApi` (SLC-22, `docs/research/slicer-scene.md`): `MrmlSceneApi(nodes_by_class, folder_display)` exports a model only if a 3D view shows it (exact class `vtkMRMLModelNode`, not hidden from editors, a non-slice model display node that is visible in 3D, in a view and in visible folders), colour/opacity like the 3D view ("apply to branch" folders, folder opacity), linear world matrix or `None`; no `slicer` import (Slicer's functions are passed in); main thread only |
| `RemoteView/remoteview_core/names.py` | display names (protocol §7.3): `sanitize_name` (forbidden Unicode categories removed, whitespace collapsed, ≤ 64 UTF-16 units — always accepted by the writer), `NameAssigner` with the *Hide node names* substitutes `Model <n>`/`Segment <n>` |
| `RemoteView/remoteview_core/panel.py` | session panel logic (SLC-09): `PanelController` — Start/Stop, the transport events and the `ProtocolClient` → immutable `PanelView` (fixed texts, never relay free text; plain-text labels); one transport per session; with a `scene` factory the first `session.created` sends the scene (`snapshot.py`) and the status goes "Sending the scene" → "Live" on `scene.snapshot.ack` (a refused or too-large scene keeps the session with a fixed reason); a `session.create` the relay leaves unanswered for 15 s ends the attempt; no resume yet (SLC-17); main thread only |
| `RemoteView/remoteview_core/protocol_client.py` | publisher protocol core (protocol §4, §6, §8.4, §9): `ProtocolClient` session state machine fed by parsed inbound messages, builders for `session.create`/`renew`/`close`, `ping` and the snapshot messages (`build_snapshot_messages`: `begin` + lazily encoded 12-byte-header chunk frames + `end`), `SceneVersionCounter`; stdlib-only inbound checks; the `publisherToken` lives in a redacting `Secret` and neither it nor the session code is ever logged. No sockets or threads (those are `transport.py`); main thread only |
| `RemoteView/remoteview_core/snapshot.py` | the snapshot of a live session (SLC-24, protocol §6, §7): `build_snapshot(scene_api, client, slicer_version=…)` → `collect_scene` → `write_glb` with root extras naming the `sceneVersion`/`profile` of the `begin` (`ProtocolClient.next_scene_version`) → `begin_snapshot` (1 MiB chunks); returns a `Snapshot` whose `frames()` the caller sends in order, plus the skipped nodes; `SnapshotTooLargeError` above the relay's `maxSnapshotBytes` before any version is used; an empty scene is an empty snapshot; main thread only |
| `RemoteView/remoteview_core/transport.py` | the publisher's WebSocket to the relay (ADR 0009, protocol §3, §9.1, §9.3): `RelayTransport` runs the `websockets` asyncio client on a private event loop in one daemon thread; the main thread calls `start()`/`send(frame, connection=…)`/`stop(final)` and drains a `queue.Queue` of `Connected`/`Received`/`Disconnected` events; TLS always verified (optional extra CA added, no key log for the relay connection, no redirects), application heartbeat (the pong deadline grows with the bytes written since the last answered ping, at 1 Mbit/s and at most 8 MiB — a snapshot on a slow uplink is not a dead connection; `docs/research/slicer-heartbeat.md`), `discard_queued(connection=…)` for the rest of a refused snapshot, backoff 0.5–30 s, errors classified by type with guidance text; imports `websockets` (17.2) only when used (`start()`, `classify()`) |
| `RemoteView/remoteview_core/vendored.py` | the only entry to the protocol package: registers `RemoteView/_vendor/remoteview_protocol` from its file location without running its `__init__` (no `jsonschema` needed — FR-16), never touches `sys.path`, refuses any `remoteview_protocol` module loaded from elsewhere; exports `chunk_header` and `alphabet` |
| `RemoteView/_vendor/remoteview_protocol/` | **generated** copy of `shared/py/remoteview_protocol` with `VENDORED.json` (sha256 per file) — never edit; refresh with `scripts/vendor_shared.py` (ADR 0007 §3) |
| `RemoteView/Resources/Icons/RemoteView.png` | module icon (128×128), own work generated with a small Python script (no third-party artwork, MIT like the repository) |
| `RemoteView/Resources/UI/RemoteView.ui` | Qt Designer panel: *Session* (relay address, consent statement, Start/Stop, code label ≥ 28 pt, status, detail), *Shared nodes* placeholder, *Advanced* (additional CA certificate, `ctkPathLineEdit`); every label is plain text |
| `tests/validate_glb.mjs` | test helper: Khronos `gltf-validator` (devDependency of `shared/`, needs `npm ci`) + the §7.1 viewer pre-checks on GLBs written by the tests |
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

The GLB tests also run the Khronos glTF validator (`gltf-validator`, a devDependency of `shared/`): run `npm ci` once at
the repository root (Node 22). Without it those tests are skipped (`pytest -rs` lists them); set
`REMOTEVIEW_REQUIRE_GLTF_VALIDATOR=1` (CI) to make them fail instead.
The TLS tests of `test_transport.py` make self-signed certificates with the `openssl` CLI and are skipped without it;
set `REMOTEVIEW_REQUIRE_OPENSSL=1` (CI; report 2026-10-20-slicer-2) to make them fail instead.
`tests/test_panel.py`, `tests/test_snapshot.py` and `tests/test_panel_snapshot.py` also run the panel and a snapshot end to
end against the relay stub of `tools/fake-slicer` (Node 22 and
`npm run build -w shared -w tools/fake-slicer` at the repository root; `tests/relay_stub.mjs` starts it); they are skipped
without them — set `REMOTEVIEW_REQUIRE_RELAY_STUB=1` (CI) to make them fail instead (the same variable covers the
Node-only `tests/test_throttle_proxy.py`). `tests/throttle_proxy.mjs`, a TCP
proxy that limits the bytes per second towards the relay (tested by `tests/test_throttle_proxy.py`), makes the
slow-uplink test (and manual §2 step 16) possible on any OS; `tests/support.py` holds the fakes and Node process helpers the test modules share.

`requirements-dev.txt` pins numpy, the `vtk` wheel (9.6.x like Slicer 5.12), `pygltflib` (test-only GLB reader),
`jsonschema` and `websockets`; none of these is installed into Slicer by these commands. To change a pin, edit the
`dev` extra in `pyproject.toml` and regenerate the file with the `uv pip compile` command in its header (a test
checks that every direct pin appears in it). It installs wheels only (`--only-binary :all:`) and carries no hashes —
the reasoning is in its header.

Anything that needs a running Slicer is a manual step in `docs/testing/slicer.md`; the sandbox never claims to
have run it (CLAUDE.md rule 10).
