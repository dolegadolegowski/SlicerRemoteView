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
| `RemoteView/RemoteView.py` | thin Slicer adapter: `RemoteView`, `RemoteViewWidget` (loads `Resources/UI/RemoteView.ui`, remembers the relay address and CA path in `QSettings`, shows the consent statement of `remoteview_core.consent` for the address being typed, starts sessions with `RemoteViewLogic.sceneApi` as the scene, renders `remoteview_core.panel` views, 50 ms `QTimer` pump, a single-shot flush `QTimer` and `makeWatcher` (SLC-34: the `SceneWatcher` of `remoteview_core.observers` on `slicer.mrmlScene` with the `slicer.vtkMRML*` event ids, made at each live session), flush and pump slots that log exception types only, closes a running session on unload and stops and disconnects both timers — a failed close is logged, so Reload finishes), `RemoteViewLogic` (`sceneApi()`: `remoteview_core.mrml_scene` over Slicer's `getNodesByClass` and folder display node; `installPackages()`: `slicer.packaging.pip_ensure`, SLC-10), the dependency dialog (`ensureDependencies`/`confirmInstall`, asked at the first *Start session* — SLC-10), the QR code of the join link painted dark on white, *Copy link* and the *Presentation window* (SLC-11; hidden and emptied when the session ends), `RemoteViewTest`; import-light: no network, subprocess, pip or runtime-dependency import at import or construction — the session code of `remoteview_core` is imported only when *Start session* is clicked |
| `RemoteView/remoteview_core/` | pure-Python core (Python 3.12 + numpy, `vtk` for geometry filters only); never imports `slicer`/`qt`/`ctk` — `tests/test_core_purity.py` enforces it; `__version__` lives in `__init__.py` |
| `RemoteView/remoteview_core/collect.py` | MRML collection (architecture §6.4): `collect_scene(scene_api)` → `Entity` per model node via an injectable `SceneApi` (the Slicer one is `mrml_scene.py`); VTK pipeline on a geometry-only deep copy whose cells are checked first (integer IDs in range — the filters do not bounds-check) (`vtkTriangleFilter` → triangles repeating a vertex dropped → `vtkPolyDataNormals`, `vtkmodules` imports), linear world matrix → `T.matrix`, names from `names.py`; triangles without area dropped; a non-linear or sheared world transform is baked into the vertices (SLC-13: `baked: true`, identity `T.matrix`, winding kept outward under a mirror); nodes without triangles, with non-finite data (also after a bake) or with a non-linear chain the scene cannot hand over are skipped and reported, never abort the snapshot; `mesh_from_triangles` (the same normals step, for `decimate.py`); `display_of`/`placement_of`/`BAKE`/`transform_to_bake`/`valid_model_id`/`raw_name` are the rules `changes.py` re-checks, and `SkippedNode.baked` says a mesh left out passes unbaked, so its baked transform is to blame; main thread only |
| `RemoteView/remoteview_core/consent.py` | the consent statement shown before *Start session* (SLC-22; R-06, NFR-16): what is sent to which relay host and who can see it; names only the host of the typed address (no user info, port, path or query), says when `ws://` is unencrypted and names a `ws://` host only on this computer (Start refuses others); standard library only; since SLC-32 it also says every later change and any scene opened or loaded is sent until Stop, and that hiding, deleting or renaming does not take back what was sent |
| `RemoteView/remoteview_core/coords.py` | RAS mm → glTF m, +Y up (`[x,y,z] = [R,S,−A]·0.001`, protocol §7.1): points, normals (`unit_normals`: a zero normal becomes +Y), `C·M·C⁻¹` matrices, column-major `node.matrix`, TRS check, winding check |
| `RemoteView/remoteview_core/glb_writer.py` | `write_glb(entities, RootExtras) -> bytes` (and `is_exportable_matrix`, its rule for `T.matrix`): one GLB per snapshot (protocol §7): root `SlicerRemoteView` with §7.1 extras, per entity `T` (extras §7.3, TRS `matrix`) + one mesh child `M`, float32 `POSITION`/`NORMAL`, uint16/uint32 indices, one PBR material; deterministic bytes; strict input validation (`GlbWriteError`). SLC-12: `quantize=True` writes `KHR_mesh_quantization` — `POSITION` as `SHORT` (one uniform step per mesh, largest extent / 65,534, around the bounding-box centre; the dequantisation is `M.matrix`), `NORMAL` as normalised `BYTE`, 4-byte strides — and `size_report(glb)` says where the bytes go |
| `RemoteView/remoteview_core/mrml_scene.py` | the Slicer `SceneApi` (SLC-22, `docs/research/slicer-scene.md`): `MrmlSceneApi(nodes_by_class, folder_display)` exports a model only if a 3D view shows it (exact class `vtkMRMLModelNode`, not hidden from editors, a non-slice model display node that is visible in 3D, in a view and in visible folders), colour/opacity like the 3D view ("apply to branch" folders, folder opacity), linear world matrix or `None`, and for a non-linear chain `world_transform` (`GetTransformToWorld` into a `vtkGeneralTransform`, as the 3D view, SLC-13); no `slicer` import (Slicer's functions are passed in); main thread only |
| `RemoteView/remoteview_core/names.py` | display names (protocol §7.3): `sanitize_name` (forbidden Unicode categories removed, whitespace collapsed, ≤ 64 UTF-16 units — always accepted by the writer), `NameAssigner` with the *Hide node names* substitutes `Model <n>`/`Segment <n>` |
| `RemoteView/remoteview_core/panel.py` | session panel logic (SLC-09; SLC-10: the `ensure_deps` hook installs the Python packages after the address is accepted, asking first, with the panel locked meanwhile): `PanelController` — Start/Stop, the transport events and the `ProtocolClient` → immutable `PanelView` (fixed texts, never relay free text; plain-text labels; SLC-11: `link`, live only and kept out of `repr`, or the `NO_LINK` note; SLC-14: the scene detail warns about models sent whole and a scene above the profile's recommended size); one transport per session; with a `scene` factory the first `session.created` hands the session to `live.py`'s `LiveUpdates` (SLC-32), and with a `watch` factory and a `flush_timer` the observers (`observers.py`) attach in the same main-thread call and go on Stop, at the session's end, when the transport ends and in `shutdown()` (a watcher that cannot be built or attached: nothing is sent); after events off the main thread the pump aligns the batch hold with Slicer's and asks for a re-sync (SLC-33); the status follows the scene — "Sending the scene", "Updating the scene", "Live", "Scene not up to date", "Session running without the scene" — with the reason and what happens next (a batch holding the first snapshot says so; a closed scene that cannot be cleared off the viewers ends the session, even if a text fails); a `session.create` the relay leaves unanswered for 15 s ends the attempt; `shutdown()` stops the transport and leaves the panel idle even when the close or the stop raises (with a plain `session.close` on an open connection when ending the session raised before the transport took it), and a `PanelView` never carries a link without its code (SLC-36); SLC-37: a connection lost after `session.created` is resumed — `Phase.RECONNECTING` keeps the code, link and Stop, each new connection starts with `session.resume`, and `session.resumed` goes back to Live with the same live updates and observers; the reconnect window (`min(graceS, 600) + 60 s` on the monotonic and the wall clock), the 15 s answer deadline, a refused resume (`RECONNECT_END_REASONS`) and Stop while offline end the session with fixed texts that say when the relay may still hold it; main thread only |
| `RemoteView/remoteview_core/protocol_client.py` | publisher protocol core (protocol §4, §6, §8, §9): `ProtocolClient` session state machine fed by parsed inbound messages, builders for `session.create`/`renew`/`close`, `ping` and the snapshot messages (`build_snapshot_messages`: `begin` + lazily encoded 12-byte-header chunk frames + `end`), `SceneVersionCounter`; scene updates (SLC-16): `NodeChange`, `send_changes`/`send_removed`/`announce_added` → `scene.update`/`scene.nodeRemoved`/`scene.nodeAdded` split at the relay's `maxChanges`/`maxTextBytes`, held while a snapshot is in flight or needed (and before the first snapshot) and released by its ack, `snapshot_needed` for the re-sync (SLC-29: `require_snapshot()` sets it without a message or a version); resume (SLC-17): `resume()` sends `session.resume` from `grace`, `session.resumed` is checked and applied by the pure `resume_plan` (versions continue from the larger of ours and the relay's; a snapshot cut by the drop is owed, one whose ack was lost is adopted; a drop owes a snapshot until the relay shows it is up to date), `SESSION_NOT_FOUND` closes so the caller can fall back to `start(profile, old code)`; stdlib-only inbound checks; the `publisherToken` lives in a redacting `Secret` and neither it nor the session code is ever logged. No sockets or threads (those are `transport.py`); main thread only |
| `RemoteView/remoteview_core/snapshot.py` | the snapshot of a live session (SLC-24, protocol §6, §7): `build_snapshot(scene_api, client, slicer_version=…)` → `collect_scene` → `decimate.fit_to_budget` for the session's profile (SLC-14) → `write_glb` (quantised, SLC-12) with root extras naming the `sceneVersion`/`profile` of the `begin` (`ProtocolClient.next_scene_version`) → `begin_snapshot` (1 MiB chunks); returns a `Snapshot` whose `frames()` the caller sends in order, plus the skipped nodes, the `reduced`/`unreduced` ones, `over_target` (SLC-14) and `sent` — the viewers' scene once it is in, for `changes.classify` (SLC-30); `announce=` builds the `scene.nodeAdded` hint (`announced`, sent before the frames) once the binary chunk is known to fit (SLC-29); `SnapshotTooLargeError` above the relay's `maxSnapshotBytes` before any version is used — before the GLB is written when its binary chunk alone is over (SLC-14); an empty scene is an empty snapshot; main thread only |
| `RemoteView/remoteview_core/links.py` | the join link and its QR code (SLC-11, FR-04, NFR-29/30, T6): `join_url(relay_url, code)` → `https://<relay host>/j#<CODE>` (`http://` for the loopback `ws://`; the relay must be at `/ws`; the code is the fragment only; ≤ 64 characters; ValueError, never echoing the input), `qr_modules(link)` (segno, error level M, no Micro QR, quiet zone of 4 modules; imported when a code is drawn), `qr_scale` (whole pixels per module for ≥ 240 px), `dark_runs` (the rectangles to paint); the Qt adapter paints them dark on white |
| `RemoteView/remoteview_core/changes.py` | live scene changes → what to send (SLC-30, protocol §7.3, §8, T7): `classify(drained, scene_api, sent, *, anonymize_names)` returns a `Plan` — `NodeChange` items and removed IDs for SLC-16's senders, or a re-export (`added` for the `scene.nodeAdded` hint, `reset` after a closed scene); `SentScene` is what the viewers hold (the export's nodes, the nodes it left out and why, its *Hide node names* setting), from `Snapshot.sent` and `apply(plan)`; reads display properties, world matrices and names, never a mesh (only the cell counts of a node left out without triangles); IDs reach updates only if the viewers hold them; the SLC-29 wiring contract is in its docstring; main thread only |
| `RemoteView/remoteview_core/debounce.py` | coalescing scene changes (SLC-15, FR-11/12, NFR-02, protocol §8.1): `Change` flags, `DirtySet` and a `Debouncer` on an injected single-shot timer and clock — 150 ms after the last appearance/transform/removal mark (at most 250 ms after the first), 750 ms while a re-export is pending — geometry, added, a rename — (at most 2 s); `hold`/`release` around batch processing (and SLC-29's other holds), `reset` for a closed scene, `pending`; pure, no Slicer/Qt/VTK (the observers are `observers.py`); main thread only (no locks) |
| `RemoteView/remoteview_core/live.py` | live scene changes during a session (SLC-29, protocol §6.2, §7.3, §8, T2, T7): `LiveUpdates` owns the debouncer, the viewers' `SentScene` and every export of the session (the first snapshot too) — observers' marks (`mark`, `mark_transform`: a baked held node takes the slow lane), counted batch `hold`/`release`, `reset`; a flush is classified (`changes.py`) and sent as updates or a re-export; held from each snapshot's `begin` until its ack, refusal or loss (no supersede but a reset, whose closed scene is replaced by an empty snapshot when the new one cannot be built, or the session ends); owed snapshots paced per error cause (shrinking change, `retryAfterS`, back-off 2…60 s, re-sync rule, a flush after 3 failures); `GRACE` holds, `CLOSED` stops; `set_anonymize_names`/`request_snapshot`; every entry point logs exception types only. `start(deferred=True)` leaves the first snapshot to the next `tick()` (the panel attaches the observers in between); `in_flight`, `owed`, `waits_for_change` and `batch_held` for the panel's texts. Across a resume (SLC-35): `LiveEventKind.LOST` for a snapshot lost with the connection, `ACKED` when the resume shows the relay had it, a clean resume owes nothing, a reset owed goes first and is never acknowledged by a snapshot of the closed scene, `reset_owed`; `request_resync(batch=)` (SLC-33): after events missed off the main thread the batch hold follows Slicer's again and a snapshot re-syncs the viewers, the flush and too-large gates lifted. The observers are `observers.py` (SLC-31), the panel wiring `panel.py` (SLC-32); main thread only |
| `RemoteView/remoteview_core/observers.py` | Slicer scene observers of a live session (SLC-31, `docs/research/slicer-live.md`): `SceneWatcher` marks `live.py`'s controller from MRML events — scene node added/removed (`calldata_type(VTK_OBJECT)`), batch start/end → hold/release, `EndCloseEvent` → reset; per exact-class model node `DisplayModifiedEvent` → appearance, `MeshModifiedEvent` → geometry, `TransformModifiedEvent` → transform unless the linear world matrix is unchanged, `ModifiedEvent` → name; nodes hidden from editors (slice planes) are not marked, and a *HideFromEditors* flip marks appearance and geometry (the viewers drop the node or get it whole); a 3D view node added or removed marks every model not hidden from editors; one bound method per event (Python sees every MRML event as `'NoEvent'`), its own observer tags (`detach` removes them all), handlers only mark and log exception types only (T7), events off the main thread only set a flag (`take_off_thread()` re-lists the models and forgets the poses, `detach()` clears it; SLC-33), `batch_processing()` reads `IsBatchProcessing()` and fails open; `MrmlEvents` holds the ids from `slicer.vtkMRML*` constants; `vtkmodules` only, main thread only |
| `RemoteView/remoteview_core/decimate.py` | decimation and budgets (SLC-14, protocol §7.5, FR-10, NFR-03): `PROFILES` (`mobile`/`quest2` 500k triangles, `quest3` 1M; 100k per node; 32/32/64 MiB recommended), `allocate` (a share in proportion to each node's triangles, 2k floor, never dropped), `decimate_entity` (`vtkQuadricDecimation`, then `vtkDecimatePro` keeping the topology, then its guaranteed defaults; normals recomputed, a zero one made +Y as in `coords.unit_normals`), `fit_to_budget` → `FitResult(entities, reduced, unreduced)`, `glb_binary_size` (exact) and `estimate_glb_size`; main thread only |
| `RemoteView/remoteview_core/deps.py` | runtime packages on first use (SLC-10, FR-16, T12): `PACKAGES` = `websockets==17.2`, `segno==1.6.6` (exact pins); `ensure_runtime_deps(install, confirm)` decides what is missing (another installed release counts as missing; `17.2.0` is `17.2`), asks the user first, installs through the injected callable (`RemoteView.py` passes `slicer.packaging.pip_ensure(…, prompt_install=False, prompt_restart=False)`; Slicer 5.12 only — an older build ends with the fixed "could not be installed" text), checks again, and reports a module already loaded in another release as *restart needed*; fixed failure texts, never pip's messages; no `slicer`, `websockets` or `segno` import — `docs/research/slicer-deps.md` |
| `RemoteView/remoteview_core/transport.py` | the publisher's WebSocket to the relay (ADR 0009, protocol §3, §9.1, §9.3): `RelayTransport` runs the `websockets` asyncio client on a private event loop in one daemon thread; the main thread calls `start()`/`send(frame, connection=…)`/`stop(final)` and drains a `queue.Queue` of `Connected`/`Received`/`Disconnected` events; TLS always verified (optional extra CA added, no key log for the relay connection, no redirects), application heartbeat (the pong deadline grows with the bytes written since the last answered ping, at 1 Mbit/s and at most 8 MiB — a snapshot on a slow uplink is not a dead connection; `docs/research/slicer-heartbeat.md`), `discard_queued(connection=…)` for the rest of a refused snapshot, backoff 0.5–30 s, errors classified by type with guidance text; imports `websockets` (17.2) only when used (`start()`, `classify()`) |
| `RemoteView/remoteview_core/vendored.py` | the only entry to the protocol package: registers `RemoteView/_vendor/remoteview_protocol` from its file location without running its `__init__` (no `jsonschema` needed — FR-16), never touches `sys.path`, refuses any `remoteview_protocol` module loaded from elsewhere; exports `chunk_header` and `alphabet` |
| `RemoteView/_vendor/remoteview_protocol/` | **generated** copy of `shared/py/remoteview_protocol` with `VENDORED.json` (sha256 per file) — never edit; refresh with `scripts/vendor_shared.py` (ADR 0007 §3) |
| `RemoteView/Resources/Icons/RemoteView.png` | module icon (128×128), own work generated with a small Python script (no third-party artwork, MIT like the repository) |
| `RemoteView/Resources/UI/RemoteView.ui` | Qt Designer panel: *Session* (relay address, consent statement, Start/Stop, code label ≥ 28 pt, status, detail), the QR code of the join link (≥ 240 px, shown while the session runs) with *Copy link* and *Presentation window*, *Shared nodes* placeholder, *Advanced* (additional CA certificate, `ctkPathLineEdit`); every label is plain text |
| `RemoteView/Resources/UI/PresentationWindow.ui` | the pop-out window for a projector (SLC-11): the session code at 64 pt (NFR-29 asks ≥ 48 pt), the QR code at ≥ 480 px, a hint line |
| `tests/validate_glb.mjs` | test helper: Khronos `gltf-validator` (devDependency of `shared/`, needs `npm ci`) + the §7.1 viewer pre-checks on GLBs written by the tests |
| `tests/` | pytest suites run outside Slicer; `conftest.py` provides strict stub `slicer`/`qt`/`ctk` modules (with `slicer.mrmlScene` on VTK's own dispatch and the MRML event ids, SLC-34) and puts `RemoteView/` on `sys.path` like Slicer does |
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

## Offline installation of the Python packages

On the first *Start session* the module asks before it installs `websockets==17.2` and `segno==1.6.6` from PyPI
(`remoteview_core/deps.py`). On a computer that cannot reach `pypi.org` and `files.pythonhosted.org` (a hospital
network), download the two wheels elsewhere — for Slicer 5.12 (Python 3.12) pick the platform of the Slicer computer:

```
python -m pip download websockets==17.2 segno==1.6.6 --only-binary :all: --python-version 3.12 \
    --platform win_amd64 --dest wheels
```

(`--platform`: `win_amd64`, `macosx_11_0_arm64`, `macosx_10_13_x86_64` or `manylinux2014_x86_64`), copy the `wheels` folder
to the Slicer computer and run in Slicer's Python console

```python
slicer.util.pip_install(
    [
        "--no-index",
        "--find-links",
        r"C:\path\to\wheels",
        "--only-binary",
        ":all:",
        "websockets==17.2",
        "segno==1.6.6",
    ]
)
```

then click *Start session*; no dialog follows because both packages are in place. Use the **list** form shown: Slicer
splits a plain string like a shell command line, which swallows the backslashes of a Windows path (`C:\Users\me\wheels`
becomes `C:Usersmewheels`) and breaks at spaces. On macOS and Linux the path is written as usual (`"/Users/me/wheels"`).
The wheels are carried between computers, so check them: in Slicer's Python console on the Slicer computer print the
SHA-256 of each file and compare it with the digest on the file's pypi.org page (*Download files*) for websockets 17.2
and segno 1.6.6 (a console works the same on every OS; `python -m pip hash <file>` or `certutil -hashfile <file>
SHA256` give the same digest):

```python
import hashlib, pathlib

for f in sorted(pathlib.Path(r"C:\path\to\wheels").glob("*.whl")):
    print(f.name, hashlib.sha256(f.read_bytes()).hexdigest())
```

A proxy for the normal installation is read from pip's usual settings (`HTTPS_PROXY`, `pip.conf`); Slicer prints pip's
output to its Python console.

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
`tests/test_panel.py`, `tests/test_snapshot.py`, `tests/test_panel_snapshot.py`, `tests/test_scene_updates.py` and
`tests/test_panel_live.py` also run the panel, a snapshot, scene updates and the live panel end to end against the relay stub of `tools/fake-slicer` (Node 22 and
`npm run build -w shared -w tools/fake-slicer` at the repository root; `tests/relay_stub.mjs` starts it); they are skipped
without them — set `REMOTEVIEW_REQUIRE_RELAY_STUB=1` (CI) to make them fail instead (the same variable covers the
Node-only `tests/test_throttle_proxy.py`). `tests/throttle_proxy.mjs`, a TCP
proxy that limits the bytes per second towards the relay (tested by `tests/test_throttle_proxy.py`), makes the
slow-uplink test (and manual §2 step 16) possible on any OS; `tests/support.py` holds the fakes and Node process helpers the test modules share (and `leaks`, the T7 check of the log, stdout/stderr and `sys.last_value`), `tests/mrml_fakes.py` the vtkObject MRML fakes of the observer and live-panel tests.

`requirements-dev.txt` pins numpy, the `vtk` wheel (9.6.x like Slicer 5.12), `pygltflib` (test-only GLB reader),
`jsonschema`, `websockets`, `segno` (the release users get) and `zxing-cpp` (a test-only QR decoder: the generated codes must scan back to the link); none of these is installed into Slicer by these commands. To change a pin, edit the
`dev` extra in `pyproject.toml` and regenerate the file with the `uv pip compile` command in its header (a test
checks that every direct pin appears in it). It installs wheels only (`--only-binary :all:`) and carries no hashes —
the reasoning is in its header.

Anything that needs a running Slicer is a manual step in `docs/testing/slicer.md`; the sandbox never claims to
have run it (CLAUDE.md rule 10).
