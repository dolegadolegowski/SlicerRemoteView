# Plan — `slicer` (3D Slicer extension `SlicerRemoteView`, module `RemoteView`)

| | |
|---|---|
| Component | `slicer` |
| Directories owned | `slicer-plugin/` (`CMakeLists.txt`, `RemoteView/` module, `RemoteView/remoteview_core/` pure package, `RemoteView/_vendor/` vendored `shared/py`, `scripts/`, `tests/`) |
| Branch | `ws/slicer` |
| Subagent | `slicer-dev` (+ `reviewer`) |
| Stack | Python 3.12 (Slicer 5.12.x), PythonQt, VTK 9.6, numpy; runtime deps installed on first use: `websockets==17.2` (exact pin, T12; `websockets.asyncio.client` in a worker thread, ADR 0009), `segno==1.6.6` (exact pin, SLC-10); dev: pytest, ruff, `vtk` wheel, `pygltflib` (test-only) |
| Contract | `docs/protocol.md` v1.0 ("§n" below) — §4 session, §6 snapshot, §7 GLB manifest, §8 updates |
| Design | `docs/architecture.md` §6 (Slicer pipeline), §8 (T4, T5, T7); ADR 0001, 0005, 0007 (vendoring), 0008 |
| Prompt | `prompts/04-slicer-plugin.md`; research `docs/research/slicer.md` |

**How to read this plan.** Tasks are ordered by dependency; `⚑` = critical path (`docs/plan/00-overview.md` §4).
Everything in `remoteview_core/` is pure Python + numpy (+ `vtk` for geometry filters) with **no `slicer`/`qt`
imports** and is tested with `pytest slicer-plugin` in the sandbox; `RemoteView.py` is the thin Slicer adapter
whose behaviour is verified manually (`docs/testing/slicer.md`, numbered sections referenced below) and by the
module self-test in Slicer. Rule 10 of `CLAUDE.md` applies: never claim a Slicer test ran in the sandbox.

## Tasks

| ID | Task | Milestone | Depends on | Acceptance criteria | Test | Status |
|---|---|---|---|---|---|---|
| SLC-01 | Extension skeleton: `slicer-plugin/CMakeLists.txt` (`EXTENSION_NAME SlicerRemoteView`, homepage, category `Remote`, `add_subdirectory(RemoteView)`), `RemoteView/CMakeLists.txt` with `slicerMacroBuildScriptedModule(NAME RemoteView SCRIPTS RemoteView.py remoteview_core/... RESOURCES Resources/Icons/RemoteView.png WITH_GENERIC_TESTS)`, `RemoteView/RemoteView.py` with `RemoteView(ScriptedLoadableModule)`, `RemoteViewWidget`, `RemoteViewLogic`, `RemoteViewTest` placeholders; no network, no pip, no heavy import at module import (FR-02); `Resources/Icons/RemoteView.png`; README with developer-mode install (`Additional module paths`). `docs/testing/slicer.md` §1 "Module loads". | M0 | — | 1. Importing `RemoteView.py` with stub `slicer`/`qt`/`ctk` modules (pytest conftest) performs no network/subprocess/pip call (monkeypatched `socket`, `subprocess`, `slicer.util.pip_install` raise) — FR-02, R-06. 2. CMake lists every module file (test parses `CMakeLists.txt` and compares with the tree). 3. Manual §1: module appears under *Remote → RemoteView* in Slicer 5.12.x and its panel opens without errors in the Python console (FR-01, NFR-24). | `pytest slicer-plugin -k skeleton` · manual: `docs/testing/slicer.md` §1 | done |
| SLC-02 | Pure-Python test toolchain: `slicer-plugin/pyproject.toml` (ruff config, pytest `testpaths`, optional-dependencies `dev = [pytest, numpy, vtk, pygltflib, jsonschema, websockets]`), `requirements-dev.txt`, `RemoteView/remoteview_core/__init__.py` (`__version__`), `tests/conftest.py` with the `slicer`/`qt` stub modules (strict stubs created in SLC-01; SLC-02 extends them) and a `sys.path` shim so `remoteview_core` imports like in Slicer (the vendored protocol: SLC-03, via `remoteview_core.vendored`); guard test that `remoteview_core` never imports `slicer`, `qt`, `ctk`, `vtkmodules.qt` (AST scan). | M0 | SLC-01 | 1. `pip install -r slicer-plugin/requirements-dev.txt && pytest slicer-plugin` green in the sandbox (NFR-39). 2. AST test fails when any file under `remoteview_core/` imports a Slicer-only module (CLAUDE.md rule 10). 3. `ruff check slicer-plugin` clean; README documents the commands. | `pytest slicer-plugin && ruff check slicer-plugin` | done |
| SLC-03 ⚑ | Vendoring `shared/py`: `slicer-plugin/scripts/vendor_shared.py` wrapper calling `node shared/scripts/vendor-py.mjs slicer-plugin/RemoteView/_vendor/remoteview_protocol` (or a pure-Python copy with the same manifest when Node is absent), `_vendor/` committed with its schemas, listed in `RemoteView/CMakeLists.txt`; drift test running the `--check` mode; `remoteview_core` imports the protocol only through `remoteview_core.vendored`, which registers `RemoteView/_vendor/remoteview_protocol` from its file location (without running its `__init__`, which needs `jsonschema`; `_vendor` is never put on `sys.path`) and refuses any other `remoteview_protocol` module (never `shared/`; `RemoteView.py` is a module, not a package, so `RemoteView._vendor` cannot be imported). | M1 | SLC-02, PRO-10 | 1. `python slicer-plugin/scripts/vendor_shared.py --check` exits 0 on the tree and 1 after a one-byte change in `_vendor/` (ADR 0007 §3). 2. `from remoteview_protocol import envelope, chunk_header, alphabet` works via the vendored path in pytest with no `shared/` on `sys.path`. 3. CMake includes `_vendor/**` so the installed module is self-contained (manual §1 re-run: module still loads). | `pytest slicer-plugin -k vendor` · manual: `docs/testing/slicer.md` §1 (re-run) | done |
| SLC-04 ⚑ | GLB writer `remoteview_core/glb_writer.py`: pure function `write_glb(entities: list[Entity], root_extras: RootExtras) -> bytes` where `Entity` is a keyword-only frozen dataclass `(node_id, kind, name, positions [n,3], normals [n,3], indices [m,3], color, opacity, visible, mrml_id, segment_id=None, matrix=None, baked=False)` in glTF space — `matrix=None` means identity (omitted in the file), `triangle_count` is derived from `indices` — and `RootExtras(scene_version, profile, slicer_version, anonymized_names=False, source_app="3D Slicer")`; an empty entity list gives the root-only snapshot (§7.3 scene close); names appear only in `T.name`/`T.extras.name`; glTF 2.0 container (12-byte header, JSON chunk padded with spaces, BIN chunk padded with zeros, 4-byte alignment), one buffer, `POSITION` accessors with `min`/`max`, `UNSIGNED_SHORT` indices when `n ≤ 65,535` else `UNSIGNED_INT`, root node `SlicerRemoteView` with §7.1 extras, per entity a `T` node (extras §7.3, `matrix`) with one `M` child (one mesh, one primitive `TRIANGLES`, one material §7.4: `baseColorFactor=[r,g,b,opacity]`, `metallicFactor 0`, `roughnessFactor 0.6`, `alphaMode BLEND iff opacity<1`); `asset.generator = "SlicerRemoteView <version>"`; float positions in this task (quantization is SLC-12). | M1 | SLC-02 | 1. Output for two synthetic meshes parses with `pygltflib` and the shared TS fixture check (`shared/scripts` validator when available): header/chunk lengths correct, all byte offsets 4-aligned, `extensionsUsed` empty (§7.1, FR-05, FR-08). 2. `T.extras` round-trips all §7.3 keys; `M` has one mesh/primitive/material; a node with opacity 1 has `alphaMode: "OPAQUE"`, 0.5 → `"BLEND"` (§7.2–7.4). 3. Same input → byte-identical output (determinism, ADR 0005 consequences); writer has no `vtk`/`slicer` import. | `pytest slicer-plugin -k glb_writer` | done |
| SLC-05 ⚑ | Coordinate conversion `remoteview_core/coords.py`: `ras_to_gltf_points(arr)` (`[R,S,-A] × 0.001`), `ras_to_gltf_normals(arr)` (rotation part only, renormalised), `ras_matrix_to_gltf(M4x4)` = `C·M·C⁻¹` with `C = 0.001·[[1,0,0],[0,0,1],[0,-1,0]]` (rows act on `(R,A,S)`; the literal previously printed here and in ADR 0005 §4 is its transpose — report `docs/testing/reports/2026-10-18-slicer-1.md`), `gltf_matrix_column_major(M)` (16 floats as glTF `node.matrix`); winding check helper. | M1 | SLC-02 | 1. RAS `(+100, 0, 0)` → glTF `(+0.1, 0, 0)`; RAS `(0, +100, 0)` (anterior) → `(0, 0, −0.1)`; RAS `(0, 0, +100)` (superior) → `(0, +0.1, 0)` (FR-07, FR-65, ADR 0005 §4). 2. Determinant of the linear part of `C` is +1 and a CCW triangle stays CCW after conversion (winding preserved, §7.1). 3. A RAS translation of `(10, 20, 30)` mm becomes glTF translation `(0.010, 0.030, −0.020)` in the column-major matrix's last column (§8.1 `matrix` semantics). | `pytest slicer-plugin -k coords` | done |
| SLC-06 ⚑ | Protocol client core `remoteview_core/protocol_client.py` (pure): `SessionState` machine (`idle → connecting → created → active → grace → resuming → closed`) fed by parsed inbound messages; `build_session_create(client_info, profile, preferred_code)`, `build_snapshot_messages(glb_bytes, scene_version, *, chunk_size, profile, node_count, triangle_count) -> SnapshotMessages(begin, chunks, end)` (a named tuple; `chunks` is a one-shot iterator) using the vendored `chunk_header`/`sha256_hex`; `SceneVersionCounter` (§8.4); handlers for `session.created` (keep `publisherToken` in memory only), `session.expiring` → `session.renew`, `viewer.count`, `error`, `scene.snapshot.ack`, `pong`; outbound/inbound as plain dicts. Implemented as `ProtocolClient(client_info, *, validate=None, auto_renew=True)`: inbound messages always pass stdlib-only checks of the fields the handlers read (the Slicer runtime has no `jsonschema`, FR-16), and an injected `validate` callable (in the tests: the vendored `remoteview_protocol.schemas`) checks every outbound and inbound message as well; relay errors are matched to the in-flight snapshot by `replyTo` and `session.expired` by `sessionId`; `transport_lost(close_code)` enters `grace` except for the terminal close codes of §9.3 (4003/4011/…); `publisherToken` is held in a redacting `Secret`; main thread only. | M1 | SLC-03 | 1. Messages built by the client validate against the vendored schemas for `session.create`, `scene.snapshot.begin`, `scene.snapshot.end`, `ping`, `session.close`, `session.renew` (FR-03, FR-13, §4, §6). 2. Chunking `asymmetric-2nodes.glb` at 1 MiB and at 64 KiB produces the same `chunkCount`/headers as the TS fixtures in `shared/fixtures/blob` (§6.3 cross-language vectors). 3. State machine table test: `error PAYLOAD_TOO_LARGE` after `begin` → state `active` with `last_error` set; `session.closed` → `closed`; `publisherToken` is never included in `__repr__`/logs (T4, NFR-17). | `pytest slicer-plugin -k protocol_client` | done |
| SLC-23 ⚑ | Display names `remoteview_core/names.py`: `sanitize_name(raw)` removes the characters of `glb_writer.FORBIDDEN_NAME_CATEGORIES` (separators such as tab/newline become a space), collapses whitespace, trims and cuts to 64 UTF-16 code units (so both code-point and UTF-16 readings of §7.3 "≤ 64 chars" hold); `bytes` (what VTK returns for a non-UTF-8 name) are decoded as UTF-8 with U+FFFD; a cut never splits a flag pair or keeps marks of a combining sequence it cut; `anonymous_name(kind, n)` and `NameAssigner(anonymize=…)` give `Model <n>`/`Segment <n>` per kind in export order (also for a name that sanitises to empty). Split from SLC-07 after the SLC-04 review. | M1 | SLC-04 | 1. `"Patient\u0007 Name  "` → `"Patient Name"`; every category of `FORBIDDEN_NAME_CATEGORIES` is removed; 10,000 seeded random names all pass `glb_writer.is_valid_name`, fit 64 UTF-16 units and sanitise idempotently (§7.3). 2. With `anonymize=True` the names are `Model 1`, `Segment 1`, `Model 2`… and `write_glb` accepts them with `anonymizedNames: true`, the GLB containing no part of the original names (FR-15, T7). 3. No Slicer/Qt/VTK import (standard library + the writer's constants; checked on what the import really loads). | `pytest slicer-plugin -k names` | done |
| SLC-07 ⚑ | MRML collection via an injectable adapter `remoteview_core/collect.py`: `collect_entities(scene_api) -> list[Entity]` (and `collect_scene(...)` that also returns the skipped nodes with a reason) where `scene_api` is a small protocol (`visible_model_nodes()`, `polydata(node)`, `display_props(node) -> (color, opacity, visible)`, `world_matrix(node) -> (matrix or None if non-linear)`, `node_id`, `name`); VTK pipeline on a **copy**: `vtkTriangleFilter` → `vtkPolyDataNormals(SplittingOff, ConsistencyOn)` → owned numpy copies; linear world matrix → `T.matrix` (SLC-05); names from SLC-23 (`NameAssigner`, `anonymize_names` option; `assign` only for exported entities so the substitutes have no gaps; `scene_api.name` may return `str`, `bytes` or `None`); nodes without triangles, with a non-linear or non-TRS world transform (baked in SLC-13) are skipped and reported, never abort the snapshot; the real Slicer implementation of `scene_api` lives in `RemoteView.py` (SLC-09). Name sanitisation moved to SLC-23 (split after the SLC-04 review). Implemented as `collect_scene(scene_api, *, anonymize_names=False) -> CollectedScene(entities, skipped, anonymized_names)` with `SkippedNode(node_id, reason, index)`: the working copy holds only points, polygons and strips (`_geometry_copy`), whose cells must be stored as integers and whose point IDs and offsets are checked before any VTK filter runs (the filters do not bounds-check — a crafted file would crash Slicer); triangles that repeat a vertex are dropped between `vtkTriangleFilter` and `vtkPolyDataNormals` (they made `ConsistencyOn` turn meshes inside out); arrays are copied out with `_owned` (`vtk_to_numpy` assigns `.shape` in place, deprecated in numpy 2.5); the writer's own `glb_writer.is_exportable_matrix` decides keep-or-skip for `T.matrix`; with *Hide node names* only IDs of the generated shape `vtkMRMLModelNode<N>` are exported (T7). Sources: `docs/research/slicer-collect.md`. | M1 | SLC-04, SLC-05, SLC-23 | 1. With a fake `scene_api` returning a `vtkCubeSource`/`vtkSphereSource` polydata offset along R, A and S and known display props, `collect_entities` yields entities whose positions are converted (SLC-05) and whose normals have unit length (§7.4 `NORMAL` required). 2. With `anonymize_names=True` the names are `Model 1…` and the entities write with root extras `anonymizedNames: true` (§7.3, FR-15, T7); an empty polydata, a `vtkLineSource` model and a node with a non-linear transform next to a valid sphere are skipped and reported while the sphere is written. 3. Input polydata object is not modified (pipeline on a copy; ADR 0005 §3 "never harden"). | `pytest slicer-plugin -k collect` | done |
| SLC-08 ⚑ | Transport thread `remoteview_core/transport.py`: `RelayTransport(url, inbound_queue, outbound_queue)` running `websockets.sync.client.connect` in a `threading.Thread` with `ssl.create_default_context()` (no option to disable verification — T5, NFR-14), sends text/bytes from the outbound queue, puts parsed inbound frames into the inbound queue, application `ping` every 15 s / `pong` timeout 10 s, exponential backoff 0.5–30 s with jitter on drop, clean `close(1000)`; distinguishes TLS errors for the UI (R-10). The main-thread pump (`qt.QTimer` 50 ms draining the inbound queue) is implemented in `RemoteView.py` as a 20-line adapter. Implemented as `RelayTransport(url, events, *, extra_ca_file=None)` with `start()`, thread-safe `send(frame, *, connection)` and `stop(final=None)`, and events `Connected(connection)`, `Received(connection, message)`, `Disconnected(connection, error, retry_in)`: the `websockets` **asyncio** client on a private event loop in one daemon thread instead of the sync client (ADR 0009: the sync client stalls on ~10–15 % of TLS 1.3 connects and its `send` can block for ever); a fresh default TLS context per attempt with an optional extra CA (PEM or DER) *added*, no key log, redirects refused, lower-case `wss://` (or `ws://` to loopback, never through a proxy), no user info/query/fragment in the URL; the heartbeat lives in the transport thread and starts after the connection's first text message (§3.1); `TransportError`/`TlsError` with a kind, numbers and fixed guidance — never exception text; certificate, proxy, HTTP 3xx/4xx (except 408/429) and close codes 1000/1008/1009/4000–4003/4011 stop reconnecting, 4008 retries after 0–3 s, after 4005/4006 the `retryAfterS` of the relay's last `error` is the minimum delay; frames name their connection, so nothing queued for a dropped connection is sent on the next one; `stop()` sends the final message, closes 1000 and aborts a stuck send after 2 s (the last event says whether the final message went out: `final_sent`). The tests shorten `ping_interval`/`pong_timeout` instead of patching the clock. Sources: `docs/research/slicer-transport.md`. | M1 | SLC-06 | 1. pytest spins a local `websockets.sync.server` echoing frames: text and 1 MiB binary frames round-trip in order; closing the server triggers a reconnect attempt after ≈ 0.5 s then ≈ 1 s (patched sleep) — FR-14 groundwork, NFR-21. 2. Missing `pong` for 10 s (patched clock) closes the socket and schedules a reconnect. 3. Connecting to a server with a self-signed certificate fails with a `TlsError` carrying guidance text, and there is no code path that sets `check_hostname=False`/`CERT_NONE` (grep test) — T5, R-10. | `pytest slicer-plugin -k transport` | done |
| SLC-09 ⚑ | UI panel v1 (`RemoteView.py` + `Resources/UI/RemoteView.ui`): relay URL field (default constant, remembered in `QSettings`), **Start session** / **Stop session**, code label (monospace, letter-spaced, ≥ 28 pt), status label, node list preview placeholder; the 50 ms `qt.QTimer` pump draining the transport's inbound queue (SLC-08 adapter); a pure `PanelController` (in `remoteview_core/`) that maps `SessionState` + inbound messages to label texts and button states; on Start: `session.create` via the transport → `session.created` → code shown, status "Connected"; on Stop: `session.close{reason:"USER_STOPPED"}`. Consent text, the Slicer `scene_api` and the first snapshot are SLC-22 (split in the pre-implementation review). Implemented as `remoteview_core/panel.py` — `PanelController(slicer_version, platform)` with `start(url, extra_ca_file=…)`, `stop()` and `pump()` returning an immutable `PanelView` (status, detail, code, enabled flags) and `shutdown()` returning whether the transport ended; it owns one `ProtocolClient` and one `RelayTransport` per session, sends `session.create` on `Connected`, maps `session.created`/`viewer.count`/`error`/`session.expired`/`session.closed` and the transport's `Disconnected` (guidance, `final_sent`) to fixed texts — relay free text is never shown and every label is plain text; no resume yet (a drop after `session.created` ends the session, SLC-17), a drop before it is retried, and a `session.create` left unanswered for 15 s ends the attempt; after a fatal relay `error` on a live session it sends `session.close` itself (§11: the relay may keep the socket); after the user's Stop the panel says "Session ended." only with something to add (the stop message was lost and the relay did not end the session itself), otherwise "Not connected."; an additional CA certificate is named under the status while a `wss://` connection uses it (T5). `RemoteView.py` loads `Resources/UI/RemoteView.ui` (`ctkCollapsibleButton` sections *Session*, *Shared nodes* placeholder, *Advanced* with the additional CA `ctkPathLineEdit`), remembers the relay address and CA path in `QSettings` only after the transport accepted them, runs the 50 ms pump (`time.sleep(0.001)` per tick for the GIL) and closes a running session on module unload (`cleanup`, ≤ 3 s). The default relay address is empty until `deploy` names the production host. The texts are the panel's own: "Session running · N viewers" for criterion 1's "Connected" and "Not connected." for "Idle"; the tests use `session.expired` (§11 sends a publisher only `expired`) next to `session.closed`. The client is built with `auto_renew=False` until `release` decides (branch-audit follow-up), so an unused session ends after the idle TTL. Sources: `docs/research/slicer-panel.md`. | M1 | SLC-06, SLC-08 | 1. Manual §2: Start against a relay (fake-slicer stub or `relay-server`) shows a code within 3 s; Stop sends `session.close` and the status returns to "Idle" (US-01, FR-03, FR-13). 2. Unit: the `.ui` file parses and every widget name the adapter looks up exists (XML test with the `qt` stub). 3. Unit: `PanelController` maps `session.created`/`error`/`session.closed`/`viewer.count` to texts and enabled states without any `slicer`/`qt` import. | `pytest slicer-plugin -k panel` · manual: `docs/testing/slicer.md` §2 | done |
| SLC-22 ⚑ | Consent text and the Slicer scene adapter (the first snapshot is SLC-24, split before this task started): consent text in the panel naming the relay host and what leaves the PC — the surface meshes of the models the 3D view shows, their names (until *Hide node names*, SLC-18) and MRML node IDs, colours, opacity, visibility, position, the Slicer/RemoteView/OS versions (NFR-16, R-06, SLC-04 follow-up) — shown before Start and following the address field; the Slicer `scene_api` (`slicer.util.getNodesByClass('vtkMRMLModelNode')`, the display-node and folder rules of the 3D view, `GetPolyData`, the linear world matrix via `GetMatrixTransformToWorld` or `None` when non-linear — architecture §6.4, `docs/research/slicer-collect.md` §3). Implemented as `remoteview_core/consent.py` (`consent_text(url)`: names only the host of the typed address — a `ws://` host only on this computer, as Start refuses others — says when `ws://` is unencrypted and that clipping is not applied; standard library only, so the panel's `consentLabel` follows every keystroke without loading the session code) and `remoteview_core/mrml_scene.py` (`MrmlSceneApi(nodes_by_class, folder_display)`: the calls Slicer's model displayable manager makes, `docs/research/slicer-scene.md`; no `slicer` import), built by `RemoteViewLogic.sceneApi()` from `slicer.util.getNodesByClass` and `slicer.vtkMRMLFolderDisplayNode`. Hidden models are left out (privacy default; ADR 0005 Decision 6 differs — asked of `release` in `docs/testing/reports/2026-10-20-slicer-5.md`). | M1 | SLC-09, SLC-07 | 1. Unit: the scene adapter against fake MRML nodes with a `vtkSphereSource` mesh — exact class, `HideFromEditors`, slice display nodes, `Visibility`/`Visibility3D`, folders, views, colour and opacity like the 3D view, linear and non-linear world matrix; `collect_scene` over it yields the sphere entity. 2. Unit: the consent text names the relay host and every exported data item, and never more of the address than the host (string test); the panel shows it before Start without starting anything. 3. Manual §12: with `MRHead`, models in folders and a transform, the console check lists exactly the models the 3D view shows; the consent text names the typed host. | `pytest slicer-plugin -k "consent or mrml_scene"` · manual: `docs/testing/slicer.md` §12 | done |
| SLC-24 ⚑ | Snapshot core (split before it started: the panel wiring is SLC-25, the slow-uplink heartbeat SLC-26): `remoteview_core/snapshot.py` `build_snapshot(scene_api, client, *, slicer_version, anonymize_names=False)` → `collect_scene` → `write_glb` with root extras whose `sceneVersion`/`profile` are those of the next `begin` (`ProtocolClient.next_scene_version`, SLC-06 follow-up) → `client.begin_snapshot` (1 MiB chunks) → the frames to send plus the skipped nodes; the relay's size limits and an empty scene have fixed outcomes. Implemented as `remoteview_core/snapshot.py` (`build_snapshot` → `Snapshot` with `frames()` = begin, chunk frames, end, and the skipped nodes; `SnapshotTooLargeError` above `maxSnapshotBytes` before any version is used; an empty scene is an empty snapshot so viewers do not keep an old one) and `ProtocolClient.next_scene_version`; `tests/relay_stub.mjs` also prints the SHA-256 of each snapshot's reassembled chunks for the end-to-end test. The client is `active` from the `begin`; the ack sets `accepted_version` and clears `snapshot_in_flight`, which SLC-25's "Live" keys on. | M1 | SLC-22 | 1. Unit: the GLB of a sphere scene passes the glTF validator and its root extras match the `begin` (`sceneVersion`, `profile`), whose `nodeCount`, `triangleCount`, `sha256` and `chunkCount` match the GLB; skipped nodes are reported; a scene over `maxSnapshotBytes` is refused before anything is sent. 2. End to end: the real client and transport send a sphere snapshot to the relay stub; the reassembled chunks match the `begin` checksum and the stub's `scene.snapshot.ack` makes the client `active`. | `pytest slicer-plugin -k snapshot` | done |
| SLC-25 ⚑ | First snapshot from the panel (split from SLC-24): on `session.created` the panel builds the snapshot with `RemoteViewLogic.sceneApi()` and sends it through the transport, shows "Live" on `scene.snapshot.ack` and maps snapshot errors (`PAYLOAD_TOO_LARGE`, `CAPACITY`, `BAD_SEQUENCE`, a refused checksum) to fixed texts; Slicer exit closes the session through `cleanup()` (`docs/research/slicer-scene.md` §2). Implemented as `PanelController(scene=…)`: the first `session.created` calls `build_snapshot` with the scene factory (`RemoteViewLogic.sceneApi` in `RemoteView.py`) and sends its frames; the status reads "Sending the scene · …" until the ack of that version, then "Live · …"; a scene over `maxSnapshotBytes` (nothing sent), a refusal (`PAYLOAD_TOO_LARGE`, `CAPACITY`, other codes by their enum value) or a failure to collect (logged by exception type only) leaves the session running with "Session running without the scene" and a fixed reason; models left out are counted under the status. Manual §2 gained steps 11–15 (viewer, Stop, Slicer exit, orientation phantom). | M1 | SLC-24 | 1. Manual §2: with `MRHead` + a model loaded, Start shows a code within 3 s and the status becomes "Live"; a phone (or `web-viewer` on the same machine) joining with the code shows the model within 10 s (US-01, FR-05, FR-08). 2. Manual §2: Stop and Slicer exit each make the viewer show "presentation ended" within 5 s (US-03). 3. Unit/end to end: against the relay stub the panel shows "Live" after the ack of a sphere scene's snapshot. | `pytest slicer-plugin -k "panel and snapshot"` · manual: `docs/testing/slicer.md` §2 | done |
| SLC-26 | Heartbeat on a slow uplink (split from SLC-24; SLC-08 follow-up): while snapshot chunks are written, a `pong` delayed by the queued bytes must not end a live connection — start the `pong` deadline when the `ping` reaches the socket, or extend it while sends make progress (§9.1); a throttled-uplink manual step. Implemented as a pong deadline of `pong_timeout + unread / 125 000 B/s` in `RelayTransport` (`unread` = bytes written since the last answered ping, less what a 1 Mbit/s link has read since, between 0 and 8 MiB; `min_uplink` for tests; `docs/research/slicer-heartbeat.md` has the measurements and the deviation from NFR-21's 25 s — reports `2026-10-20-slicer-6` and `-7`), `RelayTransport.discard_queued(connection=…)` — the panel calls it when the relay refuses the snapshot, so the rest is not uploaded — `tests/throttle_proxy.mjs` (a bandwidth-limiting TCP proxy for the end-to-end test and manual §2 step 16, itself tested in `tests/test_throttle_proxy.py`) and `tests/support.py` (the fakes and Node helpers the test modules shared by importing each other). | M1 | SLC-08 | 1. Unit: with a socket that drains slowly and a 1 MiB chunk queued before the `ping`, the connection stays open, and the heartbeat still closes a connection whose peer stops answering. 2. Manual §2: the first snapshot over a throttled uplink (about 1 Mbit/s) reaches the phone without a reconnect. | `pytest slicer-plugin -k heartbeat` · manual: `docs/testing/slicer.md` §2 | done |
| SLC-10 | Dependencies on first use: `remoteview_core/deps.py` `ensure_runtime_deps(installer)` with a pure decision function (`needed = [p for p in ("websockets==17.2", "segno>=1.6") if not importable]` (the exact version the transport is tested with — ADR 0009, T12; decide here what to do when another version is already installed)), the adapter calling `slicer.packaging.pip_ensure(...)` only after the user clicks Start and confirms (dialog text explains why); no network at import (FR-16, FR-02); error path when PyPI is unreachable (hospital network) shows guidance. Implemented as `remoteview_core/deps.py` (`PACKAGES` = `websockets==17.2`, `segno==1.6.6`, both exact — T12; `missing_packages`, `stale_modules`, `consent_text`, `ensure_runtime_deps(install, confirm)` → `DepsResult(Outcome, detail)`; releases compare like pip's `==`, so `17.2.0` and `17.2+local` are `17.2`) and `PanelController(ensure_deps=…)`: the hook runs after the address and CA file are accepted and before the transport thread starts, so a refused address never prompts; while it runs (Qt's event loop turns inside pip's progress window) the controller's view locks Start and the settings, a second click changes nothing, and an error in a dialog or the installer leaves the panel as it was. **Another installed release counts as missing**: the dialog names it and says *replaced* or *downgraded*; a module already imported in another release ends in *restart Slicer*. The adapter's dialog is `slicer.util.confirmOkCancelDisplay` with the packages in its details, the install `slicer.packaging.pip_ensure(…, prompt_install=False, prompt_restart=False)` (skipped in testing mode like `pip_ensure`; Slicer 5.12 only, no fallback for older builds); failures show a fixed text (pip's message may hold a proxy password; Slicer prints pip's output to its own console). README section *Offline installation* (list form: Windows paths); `docs/research/slicer-deps.md` has the verified Slicer 5.12.4 facts. | M1 | SLC-22 | 1. Decision function returns the exact requirement list for missing packages and an empty list when both import (unit test with patched `importlib`). 2. Manual §3: fresh Slicer → Start → confirmation dialog → packages installed once; second Start asks nothing (FR-16). 3. Manual §3: with network blocked, a clear error with next steps is shown and nothing else is attempted (US-01 "no network" case, NFR-31). | `pytest slicer-plugin -k deps` · manual: `docs/testing/slicer.md` §3 | done |
| SLC-11 | QR code, copy link and presentation window: `remoteview_core/links.py` `join_url(relay_url, code) -> "https://<host>/j#<CODE>"` (fragment only, never path/query; `[TODO verify]` base URL from relay `clientInfo`/config), `segno.make(url, error='m').save(..., scale)` rendered to a `QPixmap` ≥ 240×240 px with ≥ 2-module quiet zone, "Copy link" to clipboard, pop-out "Presentation" window with the code at ≥ 48 pt and the QR (FR-04, NFR-29, NFR-30). Implemented as `remoteview_core/links.py` (`join_url(relay_url, code)`: the relay's own host — ADR 0006 serves the viewer from the relay's origin — `https://` for `wss://`, `http://` for the loopback `ws://`, a non-default port kept, the code as the fragment only, at most 64 characters; `qr_modules`: `segno.make(link, error="m", micro=False, boost_error=False)` with a quiet zone of 4 modules; `qr_scale`, `dark_runs`), `PanelView.link` (held out of `repr`; empty unless the session is live; a link over 64 characters gives no QR code and a note to read the code out), and the adapter: `qrLabel` (≥ 240 px, painted with `QPainter` dark on white from the module matrix, cached per link), *Copy link* (`QApplication.clipboard()`, "Link copied" for 1.5 s), *Presentation window* (`Resources/UI/PresentationWindow.ui`: code at 64 pt, QR ≥ 480 px; hidden and emptied when the session ends or the module unloads). The tests decode the generated QR with `zxing-cpp` (dev pin; `segno==1.6.6` joined the dev pins). The link and the code never reach a log. **Plan correction**: the criterion said "version ≤ 3"; a 64-character link is QR version 5 at level M (V4-M holds 62 bytes) — NFR-30's own "fits version ≤ 4" has the same slip, reported in `docs/testing/reports/2026-10-21-slicer-1.md`. Without a QR code (a link over 64 characters or a relay not at `/ws`, or a code that cannot be drawn — then the panel says so) the Presentation window still shows the code, with a "type the code" hint; the QR labels never shrink below the code (a cropped quiet zone does not scan). | M2 | SLC-09, SLC-10 | 1. `join_url("wss://relay.example/ws", "7KQ4X") == "https://relay.example/j#7KQ4X"`; the QR URL is ≤ 64 characters (NFR-30; `join_url` raises for longer links — a 64-character link is QR version 5 at level M, which phone cameras read); unit test decodes the generated QR (`segno` → PNG → `pyzbar` if available, else compare against a stored matrix). 2. Manual §4: a stock phone camera scans the QR from 1 m and opens the viewer, which joins automatically (US-07). 3. Manual §4: the presentation window's code is readable from 2 m on a 24" screen (NFR-29). | `pytest slicer-plugin -k links` · manual: `docs/testing/slicer.md` §4 | done |
| SLC-12 | Quantization in the writer: option `quantize=True` → `POSITION` as `SHORT` (non-normalised) with per-mesh scale/offset in `M.matrix`, `NORMAL` as normalised `BYTE` padded to a 4-byte stride, `extensionsUsed`/`extensionsRequired = ["KHR_mesh_quantization"]`, `min`/`max` on quantized accessors; size report helper. Implemented as `write_glb(entities, root_extras, *, quantize=False)`: positions quantised from the float64 input with one uniform step per mesh (largest bounding-box extent / 65,534, at least 1e-9 m) around the bounding-box centre, so `M.matrix` (uniform scale ⊕ offset) is TRS and `T.matrix` keeps only the world transform (§7.2); normals `round(n × 127)`; 8- and 4-byte strides, 4-byte aligned views; the extension is declared only when there is a mesh; `size_report(glb) -> SizeReport(total, json, positions, normals, indices)`; `snapshot.build_snapshot` writes quantised snapshots (FR-09). | M2 | SLC-04 | 1. Dequantised positions differ from the originals by ≤ 1e-5 m (half a quantum of the bounding box / 65,534 — the int16 range ±32,767) and normals by ≤ 1° (FR-09, §7.2). 2. Output validates (`pygltflib` + the shared validator check) with 4-byte aligned accessor offsets (web.md §1.3). 3. Quantized vertex data of a 100k-triangle sphere is ≥ 40 % smaller and the whole GLB ≥ 30 % smaller than the float version (size report asserted). **Plan correction (SLC-12):** the criterion said the whole output ≥ 40 % smaller. Measured: the vertex data halves (24 → 12 bytes per vertex; the 4-byte stride rule allows no less); the indices do not change and protocol v1 allows no other extension, so the file shrinks by about a third (−33 % with uint16 indices, −25 % with uint32) — 40 % is out of reach for a closed mesh, which has about twice as many triangles as vertices. | `pytest slicer-plugin -k quantize` | done |
| SLC-13 | Transforms baked into the vertices (split after the SLC-07 review; segments → SLC-27): `SceneApi.world_transform(node) -> vtkAbstractTransform | None` (Slicer: `GetTransformToWorld` into an identity `vtkGeneralTransform`, the transform the 3D view's `vtkTransformFilter` applies); a non-linear chain (`world_matrix` → `None`, `GetMatrixTransformToWorld` returns 0) or a linear world matrix that is not glTF-TRS (`glb_writer.is_exportable_matrix` false: shear, zero scale) → points moved by it on a copy, before the normals, `baked: true`, identity `T.matrix` (§7.3; FR-06, FR-12 part, slicer.md §2, SLC-05 follow-up); a mirroring transform keeps the front faces outside; a node that cannot be baked is skipped and reported, never aborts the snapshot. Implemented in `collect.py`: `_placement` → identity, `T.matrix` or bake (the writer's own `is_exportable_matrix` decides); a sheared matrix is baked as a `vtkTransform`, a non-linear chain with the scene's `world_transform` (asked only then); the points are moved with `TransformPoints` into double-precision points after triangulation; a negative Jacobian (`InternalTransformDerivative`) at the first triangle — the one `ConsistencyOn` orients from — reverses the winding; triangles without area are dropped (as `ConsistencyOn`'s seed they turned real triangles over); a node whose vertices are not finite or overflow float32 after the bake is skipped (`invalid-geometry`, the arithmetic runs without warnings), a chain without a transform `non-linear-transform`; `SkipReason.NON_TRS_TRANSFORM` removed. `MrmlSceneApi.world_transform`. Sources: `docs/research/slicer-bake.md`. | M2 | SLC-07 | 1. Unit with fake `scene_api`: a linear parent transform of +10 mm R appears as `T.matrix` translation `+0.010` X; a `vtkThinPlateSplineTransform` parent leads to `baked: true`, identity matrix and vertices moved by the spline (§7.3); a sheared world matrix is baked, not skipped. 2. A mirroring bake keeps unit normals and outward front faces; the input polydata is unchanged (ADR 0005 §3). 3. Manual §5: models under a sheared, a mirrored and a non-linear transform in Slicer appear on the viewer as in Slicer's 3D view — US-02. | `pytest slicer-plugin -k "collect or mrml_scene"` · manual: `docs/testing/slicer.md` §5 | done |
| SLC-14 | Decimation and budgets `remoteview_core/decimate.py` (split after the SLC-07 review; preparing the scene one node per tick → SLC-28): profile table (`mobile`/`quest2` 500k, `quest3` 1M total; 100k per node; snapshot targets 32/32/64 MiB — §7.5, NFR-04), per-node share proportional to input triangles with a 2k floor, `vtkQuadricDecimation` then `vtkDecimatePro(PreserveTopologyOn)` fallback when the result is degenerate (zero cells or non-finite points), nodes never dropped, one node per call (`decimate_entity`); `estimate_glb_size(entities)`; `build_snapshot` fits the scene to the session's profile, refuses above `MAX_SNAPSHOT_BYTES` (`limits` from `session.created`) and flags a GLB above the profile target, which the panel shows as a warning (FR-10, FR-17 part, NFR-03, NFR-23, R-05). Implemented as `allocate` (largest `λ` by bisection for `min(count, cap, max(floor, λ·count))`), `decimate_entity` with three filters — quadric, `vtkDecimatePro(PreserveTopologyOn)`, and `vtkDecimatePro`'s defaults, under which VTK guarantees the reduction — each result kept only with ≥ 1 triangle, ≤ the share, finite normals (a zero one repaired to +Y, `coords.unit_normals`) and positions within float32 (`collect.mesh_from_triangles`); indices out of range or repeating a vertex are refused before any filter; `fit_to_budget` → `FitResult(entities, reduced, unreduced)`; `glb_binary_size` exact, `estimate_glb_size` with measured JSON sizes; `build_snapshot` refuses without writing when the binary chunk alone is over the relay's limit, else measures the file; `Snapshot.reduced/unreduced/over_target`; `panel.budget_text`. Sources: `docs/research/slicer-decimate.md`. | M2 | SLC-07, SLC-12 | 1. A 400k-triangle sphere under the `quest2` profile with three other nodes is reduced so the total ≤ 500k and no node > 100k (FR-10). 2. Degenerate `vtkQuadricDecimation` output (forced by a mocked filter) triggers the `vtkDecimatePro` fallback. 3. `estimate_glb_size` is within 10 % of the real `write_glb` size for three fixtures; a scene estimated above the relay's limit raises `SnapshotTooLarge` with guidance text (NFR-23). **Plan correction (SLC-14):** the refusal before writing uses the exact size of the binary chunk (the estimate can be a few percent high and would refuse scenes that fit); otherwise the written file is measured. | `pytest slicer-plugin -k "decimate or snapshot"` · manual: `docs/testing/slicer.md` §14 | done |
| SLC-15 | Change observers and debounce: `remoteview_core/debounce.py` `DirtySet` (`mark(node_id, flags)`, `drain()`, with `appearance`/`transform`/`geometry`/`removed`/`added` flags) and a pure `Debouncer` (restart single-shot timer: 150 ms appearance, 750 ms geometry) driven by an injected timer; adapter in `RemoteView.py` using `slicer.util.VTKObservationMixin` for scene `NodeAddedEvent`/`NodeRemovedEvent` (`@vtk.calldata_type(vtk.VTK_OBJECT)`), `DisplayModifiedEvent`, `MeshModifiedEvent`, `TransformModifiedEvent`, segmentation `SegmentAdded/Removed/Modified/RepresentationModified`; skip while `IsImporting()`/`IsBatchProcessing()`, flush on `EndImportEvent`/`EndBatchProcessEvent`; `EndCloseEvent` → full reset (architecture §6, slicer.md §3). | M2 | SLC-25 | 1. 50 `mark()` calls within 100 ms produce one `drain()` after 150 ms; a geometry flag extends the wait to 750 ms (fake timer) — FR-11. 2. Marks during an "importing" window are buffered and drained once at end-import. 3. Manual §6: toggling visibility of 5 nodes quickly in Slicer produces one `scene.update` (relay log counter or fake-slicer stub counter) — NFR-02. | `pytest slicer-plugin -k debounce` · manual: `docs/testing/slicer.md` §6 | todo |
| SLC-16 | Change classifier and senders `remoteview_core/changes.py`: `classify(drained) -> Plan` where appearance/linear-transform flags → `scene.update{changes[]}` (colour/opacity/visible/matrix via SLC-05), `removed` → `scene.nodeRemoved{nodeIds}`, `added`/`geometry`/non-linear transform/scene reset → `scene.nodeAdded{nodes, snapshotFollows:true}` + full re-export and new snapshot; split `changes` above 1,000 or 256 KiB (§3.3); `sceneVersion`/`baseVersion` from `SceneVersionCounter` (§8.1–8.4, FR-11, FR-12); while a snapshot is **in flight** (`scene.snapshot.begin` sent, `scene.snapshot.ack` not yet received) `scene.update`/`scene.nodeRemoved` plans are **queued** and flushed after `ack` with fresh versions and `baseVersion` = the new snapshot version (§6.2 in-flight rule — the relay answers `BAD_SEQUENCE` otherwise). | M2 | SLC-15, SLC-06, SLC-13, SLC-27, SLC-28 | 1. A drained set `{A: appearance, B: transform(linear), C: removed}` yields exactly one `scene.update` (two changes) and one `scene.nodeRemoved`, versions `n+1`, `n+2` with matching `baseVersion`s (§8.4). 2. `{D: geometry}` yields `scene.nodeAdded` then a snapshot plan with a higher version (§8.2). 3. 1,500 appearance changes are split into two `scene.update` messages each ≤ 1,000 changes and ≤ 256 KiB when serialised (§3.3). 4. A plan produced while `snapshot_in_flight` is true is held; after `scene.snapshot.ack` it is emitted once with `baseVersion` equal to the snapshot's `sceneVersion`, and nothing is sent between `begin` and `ack` (§6.2). | `pytest slicer-plugin -k changes` | todo |
| SLC-17 | Resume and reconnect policy: on transport reconnect send `session.resume{sessionId, publisherToken, lastSceneVersion}`; `session.resumed` → compare `snapshotVersion` with the current one and re-send the snapshot if `null` or older; `error SESSION_NOT_FOUND` → `session.create{preferredCode: <old code>}`, restart versions at 1, re-export and re-send; `UNAUTHORIZED` → stop and show "session lost"; close `4008` → immediate retry 0–3 s; `session.expiring{reason:"IDLE"}` → auto `session.renew` while the panel is open (§4.3, §4.4, §9.3, FR-14, FR-27 client side). | M2 | SLC-08, SLC-06 | 1. State-machine test: `grace` + `session.resumed{snapshotVersion:null}` → plan "send snapshot"; `SESSION_NOT_FOUND` → `session.create` with the previous code as `preferredCode` and counter reset (§13 step 9, US-05, NFR-20). 2. Fake-slicer relay stub scenario (`PRO-13` stub reused from Python via subprocess, or a Python `websockets` stub): server restart → publisher back online within 5 s with the same code when free. 3. Manual §7: disable Wi-Fi for 40 s during a session → code unchanged, viewers resume (FR-14). | `pytest slicer-plugin -k resume` · manual: `docs/testing/slicer.md` §7 | todo |
| SLC-18 | Node list, "Hide node names", viewer count and errors in the panel: pre-send list of nodes (name, kind, triangles after decimation, colour swatch, checkbox to exclude), "Hide node names" toggle (→ `anonymize_names`), viewer count from `viewer.count` with per-platform breakdown, exported triangle count and GLB size, device profile selector (`mobile`/`quest2`/`quest3`) with the Quest 2 suggestion when a `quest2` platform joins, actionable error messages for `PAYLOAD_TOO_LARGE`, `CAPACITY`, `RATE_LIMITED`, TLS failure, relay unreachable (FR-15, FR-17, US-04, US-16, US-17). | M2 | SLC-22, SLC-14, SLC-16 | 1. Unit: the panel model (pure `PanelModel` class) maps `viewer.count{platforms:{quest2:1}}` to the suggestion flag and `error` codes to the message catalogue (every §9.2 code has a text — NFR-31). 2. Manual §8: with "Hide node names" on, the phone lists `Model 1…`, colours unchanged (US-04); 3 phones → panel shows "3 viewers" (US-16). 3. Manual §8: a scene above the `quest2` budget shows the triangle count and a warning before sending (US-17). | `pytest slicer-plugin -k panel_model` · manual: `docs/testing/slicer.md` §8 | todo |
| SLC-19 | Module self-test and consolidated manual checklist: `RemoteViewTest.runTest()` creating a `vtkMRMLModelNode` from a sphere, running `collect_entities` + `write_glb` with the real Slicer `scene_api`, parsing the GLB back (`json` chunk) and asserting node count, extras, bounds in metres; `slicer_add_python_unittest` wiring; `docs/testing/slicer.md` consolidated into numbered scenarios §1–§9 with date/version/result columns (prompt 07 §6). | M2 | SLC-22, SLC-13, SLC-27, SLC-14, SLC-28 | 1. Manual §9: *Reload and Test* in Slicer passes the module self-test (ScriptedLoadableModuleTest) on macOS and Windows (NFR-24, NFR-39). 2. `ctest -R py_RemoteView` is documented for an extension build. 3. Every earlier manual step (§1–§8) has expected results and a results table. | manual: `docs/testing/slicer.md` §9 | todo |
| SLC-20 | Packaging for the Extension Index: `SlicerRemoteView.json` extension description (category, `scm_url`, `[TODO verify]` current schema of `Slicer/ExtensionsIndex`), `LICENSE.txt`, screenshot, README data-flow statement (what leaves the PC, where, retention = TTL, EU region — NFR-16), `scripts/package.py` producing `SlicerRemoteView-<version>.zip` of the module tree for manual install and for the release workflow (DEP-11); version in one place (`RemoteView/remoteview_core/__init__.py`). | M4 | SLC-19 | 1. `python slicer-plugin/scripts/package.py` creates a zip containing `RemoteView/**` including `_vendor/` and no tests/caches (unit test lists the archive). 2. README passes the Tier-1 checklist items that can be checked offline (license, README, icon, consent statement) — slicer.md §1, R-06. 3. Manual: install the zip via *Additional module paths* on a clean Slicer and run §2. | `pytest slicer-plugin -k package` · manual: `docs/testing/slicer.md` §10 | todo |
| SLC-21 | Localisation PL/EN: `Resources/UI` strings via `qt.QCoreApplication.translate`/Slicer `.ts` files for the module, consent text and error messages in both languages, language from the Slicer application setting (FR-18, NFR-33). | M4 | SLC-18 | 1. A pure test asserts every message key in `remoteview_core/messages.py` has PL and EN entries. 2. Manual §11: switching Slicer to Polish shows the panel in Polish after restart. 3. No untranslated string in the panel (manual visual check). | `pytest slicer-plugin -k i18n` · manual: `docs/testing/slicer.md` §11 | todo |
| SLC-27 | Segments (split from SLC-13 after the SLC-07 review): `scene_api` extension for segmentations (`CreateClosedSurfaceRepresentation()`, `vtkSlicerSegmentationsModuleLogic.GetSegmentClosedSurfaceRepresentation(segNode, segmentId, polyData, False)`, colour via `GetSegmentColor`, `GetSegmentOpacity3D × Opacity3D`, `GetSegmentVisibility3D`), nodeId `<segNodeID>/<segmentID>`, `kind: "segment"`; the segmentation's parent transform as for models (SLC-13); segment IDs under *Hide node names* (T7, SLC-07 follow-ups) and the consent text naming segments (SLC-22 follow-up) (FR-06, FR-64, ADR 0005 §6, slicer.md §2). | M2 | SLC-13, SLC-22 | 1. Unit with fake `scene_api`: a segmentation with two segments yields two entities with nodeIds `vtkMRMLSegmentationNode1/Segment_1`, `/Segment_2` and effective opacity = product (FR-06, FR-64, ADR 0005 §6). 2. A segmentation under a non-linear transform is baked like a model (§7.3). 3. Manual §13: `MRHead` → Segment Editor (two segments) → Start: viewer lists both segments with Slicer colours; moving a model with a linear transform in Slicer shows the new pose on the viewer (after SLC-16) — US-02. | `pytest slicer-plugin -k segments` · manual: `docs/testing/slicer.md` §13 | todo |
| SLC-28 | Scene preparation in steps (split from SLC-14 after the SLC-07 review): a per-node entry point to `collect_scene` and `fit_to_budget` (keeping the `seen` set and the `NameAssigner` across calls) so the adapter processes one node per `QTimer` tick with a progress dialog (FR-10), the code shown first with "Preparing the scene" (SLC-25 follow-up) and Stop honoured between ticks; a cap on the points of one polygon before `vtkTriangleFilter` (skip as `invalid-geometry`, SLC-07 follow-up); the SHA-256 and chunking revisited if a 64 MiB scene still blocks the main thread (SLC-06/SLC-08 follow-up). | M2 | SLC-14, SLC-25 | 1. Unit: preparing a three-node scene step by step gives the same GLB bytes as `build_snapshot` in one call; a Stop between steps sends nothing and leaves no version used. 2. A polygon of 100k points is skipped as `invalid-geometry` in < 0.1 s; any single node is prepared in < 10 s — tested with an unsmoothed, flat-capped 427k-triangle segmentation surface, a flat 0.1 m plane of 180k triangles, a small flat plane (28.8k triangles → 2k) and a non-manifold 3,000-page "book" (the quadric alone takes minutes on the first two, SLC-14 follow-up; ADR 0005 erratum, report `2026-10-21-slicer-4`). 3. Manual §15: a scene of five 400k-triangle models shows the code at once, then a progress dialog, and Slicer's 3D view stays responsive (FR-10). | `pytest slicer-plugin -k prepare` · manual: `docs/testing/slicer.md` §15 | todo |

## Follow-ups / later milestones

- Linear-transform **delta** updates for baked nodes (ADR 0005 §3) are covered by `matrix` on `T` for non-baked
  nodes; baked nodes always re-export in v1 — measure how often this happens on teaching scenes.
- Scalar/vertex colouring, textures: out of scope v1 (§7.4); revisit with protocol v1.1.
- `doubleSided` default vs Slicer backface rendering `[TODO verify]` (ADR 0005 §6).
- Confirm `Opacity3D × SegmentOpacity3D` matches the displayable manager `[TODO verify]` (ADR 0005 follow-ups).
- Measure export time and GLB size on `MRHead`/`CTChest` segmentations and record in `docs/testing/slicer.md`
  (sets whether 64 MiB is generous — architecture §10 open points).
- v1.1: receive `viewer.command` (toggle visibility from a device) and send `scene.camera` (ADR 0004).
- (SLC-01 review, low) Hide node names: `nodeId` still carries the `segmentId`, which importers/scripts may
  derive from a name (current Slicer generates random IDs, older scenes may not) — handle in SLC-07/SLC-27 and
  report the protocol side (§7.3) in `docs/testing/reports/`.
- (SLC-01 review, low) The help text and `DISCLOSURE_WORDS` in `tests/test_skeleton.py` describe UI that arrives
  in SLC-09/18/22 (relay host in the panel, *Hide node names*, PyPI prompt); update text and test together.
- (SLC-01 review, low) The import-time AST scan of `RemoteView.py` sees `import` statements only; a literal
  `__import__("…")` at module level would pass while the package is not installed in the venv.
- (SLC-02 review, decision) `jsonschema` stays a **test-only** dependency: FR-16, architecture §8 T12 and the
  consent text limit Slicer's runtime installs to `websockets` and `segno`, while `shared/py/README.md` says the
  slicer workstream installs `jsonschema` (+ native `rpds-py`). Until `release` reconciles them,
  `remoteview_core.vendored` never runs the package `__init__` and the core uses only the stdlib-only
  `chunk_header`/`alphabet`; schema validation runs in pytest only (report: `docs/testing/reports/2026-10-18-slicer-2.md`).
- (SLC-02 review, low) `RemoteView/_vendor` is excluded from this ruff config and `shared/py` does not select the
  bandit rules (`S`); the vendored code ships into Slicer without a security lint — ask `protocol` to add `S`.
- (SLC-02 review, low) `requirements-dev.txt` has exact pins without hashes (see its header); switch to a hashed
  lock when a CI job holding secrets installs it.
- (SLC-02 review, low) The opt-in guard compares `sys.modules` at runtime, so a core module with
  `try: import segno / except ImportError` at module level passes while `segno` is not in the dev venv; pin `segno`
  in the `dev` extra with SLC-11 (or scan core modules for guarded lazy imports).
- (SLC-05 review, medium) Sheared linear transforms are not glTF-TRS: SLC-13/SLC-16 must treat a world matrix
  for which `coords.is_trs_decomposable` is false like a non-linear one (bake, identity `T.matrix`, `baked: true`,
  re-export on change); protocol note requested in `docs/testing/reports/2026-10-18-slicer-4.md`. *Bake done in
  SLC-13; re-export on change: SLC-16.*
- (SLC-05 review, low, *phone part done in SLC-25: manual §2 step 15; the Quest placement is still open*) Orientation
  end to end: SLC-07 tests must use meshes offset along R, A and S (centred
  cubes/spheres hide axis flips; an LPS/RAS mix-up has determinant +1 and passes winding checks); after SLC-25 add a
  manual phantom check to `docs/testing/slicer.md` (markers at R+100, A+100, S+100 with their expected place on the
  phone and Quest).
- (SLC-03 review, low) SLC-06 and later core modules must not use `remoteview_protocol.envelope`/`schemas` at Slicer
  runtime (they need `jsonschema`); the runtime inbound path needs its own stdlib-only checks (protocolVersion major,
  known type, field types) with schema validation as test-only verification — or `protocol` makes the `schemas`
  import in `envelope.py`/`__init__.py` lazy (report `2026-10-18-slicer-2.md`). Core tests should also run once with
  `sys.modules["jsonschema"] = None`.
- (SLC-03 review, low) `shared/py` has no `.gitattributes`: on a Windows checkout with `core.autocrlf` its files get
  CRLF and the vendoring hashes differ; `slicer-plugin/.gitattributes` protects only `_vendor/` (report `-2.md`).
- (SLC-04 review, low) `tests/validate_glb.mjs` copies the §7.1 pre-check of `shared/test/glb.test.ts`; ask `protocol`
  to export it (e.g. a `shared/scripts` CLI) so both stay one implementation.
- (SLC-04 review, low) §7.3 "name ≤ 64 chars" counts code points here; JS viewers count UTF-16 units (an astral
  name of 64 code points is 128 units) — clarify with `protocol` before SLC-07's sanitiser truncates names.
  *Done in SLC-23:* names are cut to 64 UTF-16 units, which satisfies both readings; the protocol wording is asked in
  `docs/testing/reports/2026-10-19-slicer-5.md`.
- (SLC-04 review, low, *done in SLC-22 for models; segments are SLC-27's*) SLC-22's consent text must also name the
  MRML node/segment IDs and the Slicer version that leave the PC (root `extras.source`, `T.extras`).
- (SLC-04 review, low, *done in SLC-23*) SLC-07's name sanitiser removes exactly `glb_writer.FORBIDDEN_NAME_CATEGORIES` and checks
  its result with `glb_writer.is_valid_name`, so a sanitised name can never be rejected by the writer.
- (SLC-04 review, low, *done in SLC-07*) `write_glb` rejects an entity without triangles (glTF accessors need `count ≥ 1`), so one
  empty segment or a line-only model (centerline) would abort the whole snapshot: SLC-07's `collect_entities` must skip
  entities with 0 points or 0 triangles after `vtkTriangleFilter` and report them as skipped (test with an empty
  `vtkPolyData` and a `vtkLineSource` model next to a valid sphere).
- (SLC-04 review, low) SLC-04 is ~1,100 changed lines (writer + a long negative-case table) against the ~300-line
  guideline; cut SLC-07 and SLC-12 into smaller rows before starting them. *SLC-07 split:* names → SLC-23. *SLC-12
  kept whole: ≈ 200 code lines.*
- (SLC-04 review, low, *done in SLC-07: `glb_writer.is_exportable_matrix`*) the writer requires `T.matrix` to be TRS-decomposable in float64 **and** after rounding to
  float32 (what GPUs/glTFast see); SLC-13/SLC-16 must decide "bake or keep the matrix" with the same predicate (expose
  it from `glb_writer`), otherwise a rare near-shear matrix (cosine ≈ 1e-6) aborts the snapshot instead of being baked.
- (SLC-04 review, low) `RootExtras.scene_version` must be a Python `int` (numpy integers are rejected with
  `GlbWriteError`); the counter of SLC-06 produces Python ints.
- (SLC-04 review, low) CI for `slicer-plugin` (owned by `deploy`) should set `REMOTEVIEW_REQUIRE_GLTF_VALIDATOR=1`
  after `npm ci`, so the Khronos validator tests fail instead of being skipped (request in
  `docs/testing/reports/2026-10-19-slicer-1.md`).
- (SLC-06 review, low) `ProtocolClient.begin_snapshot` copies the GLB and computes its SHA-256 on the calling (main)
  thread — ≈ 0.2 s for 64 MiB — while architecture §6 puts the hash on the IO thread; SLC-08 decides (hash in the
  transport before `begin` is sent, or build the snapshot messages in a worker). *Decided in SLC-08:* it stays on the
  main thread (the transport sends finished frames only; ≈ 0.1 s for the 32 MiB mobile budget, next to ≈ 0.75 s of
  collection per 1M triangles); SLC-28 revisits it with the per-node collection (*not in SLC-24: `build_snapshot`
  collects and hashes in one call*).
- (SLC-06 review, low, *decided in SLC-08: the transport thread — see the SLC-08 follow-up on `build_ping`*) Heartbeat
  ownership: `build_ping`/`ping_outstanding` exist for a main-thread heartbeat; SLC-08 either drives them from the pump
  or keeps ping/pong timing in the transport thread (then they stay unused).
- (SLC-06 review, low) Stop during `grace` sends nothing (no socket) and the relay frees the code only when grace ends
  (≤ 120 s, `PUBLISHER_GONE`); SLC-17 may resume and then close so the code is freed at once.
- (SLC-06 review, low, *SLC-09: the panel maps codes and close reasons to fixed texts and never shows the message;
  the diagnostic line remains SLC-18*) `ErrorInfo.message` is relay free text: SLC-18 maps `ErrorInfo.code` to UI text and never shows
  or logs the message; `ProtocolClient.invalid_inbound`/`last_invalid_type` count ignored malformed messages (not a
  §9.2 code) for a diagnostic line.
- (SLC-06 review, low, *SLC-09 builds the client with `auto_renew=False` until `release` decides*) `auto_renew=True` answers every `session.expiring`, so a forgotten session with no viewers
  keeps its code (and the cached GLB on the relay) until `SESSION_MAX_LIFETIME_S` (12 h) instead of the 30 min idle TTL
  (NFR-11, T1); SLC-17/SLC-18 should renew only while the panel is open and the user was recently active (or ask), and
  `release` should record the trade-off.
- (SLC-06 review, low, *done in SLC-08: one FIFO queue per connection, frames of an ended connection dropped*) An
  `error` without `replyTo` is attributed to the newest snapshot; SLC-08 must never send chunks of a superseded snapshot
  after the next `begin` (an in-order outbound queue does this), or the newer snapshot's ack would be ignored.
- (SLC-06 review, low) The client ignores unknown inbound types (§11, §14) although §2 says a receiver MUST reply
  `UNSUPPORTED_TYPE`; wording question for `protocol` in `docs/testing/reports/2026-10-19-slicer-2.md`.
- (SLC-06 review, *done in SLC-09: every label of the panel is `Qt::PlainText`*) `viewer.count` platform names outside the §5.1 set (`web`, `quest-browser`, `quest2`, `quest3`,
  `other`) are counted as `other` (§14), so viewer-chosen strings never reach the panel; SLC-09 still renders every
  relay-derived text with `Qt.PlainText`.
- (SLC-06 review, low, *done in SLC-09: on a live session the panel sends `session.close` and stops the transport at
  once*) When the client becomes `closed` while the socket is still open (fatal `error`, e.g. a
  first-offence `UNAUTHORIZED` that the relay answers without closing — §11), the SLC-08/SLC-09 adapter ends the
  session explicitly, so the relay frees the code and the cached GLB instead of waiting for the grace period (a plain
  close 1000 would only start the grace period, §9.1).
- (SLC-06 review, low, *done in SLC-24: `ProtocolClient.next_scene_version`; `build_snapshot` writes it and the
  profile into the root extras and checks that the `begin` carries the same version*) `begin_snapshot` chooses the
  `sceneVersion` (and announces the session profile) after the GLB
  was written; SLC-24/SLC-16/SLC-18 need a read-only "next snapshot version" (and a `profile=` argument) so the root
  `extras.sceneVersion`/`profile` written by `write_glb` match the `begin` — or `protocol` confirms they need not
  (the shared `large-synthetic` fixture pairs begin version 3 with root version 1).
- (SLC-06 review, low) SLC-06 is ~1,850 changed lines (≈ 730 core, ≈ 1,080 tests); split SLC-16 and SLC-17 into smaller rows
  (builders/counter vs state machine/handlers) before starting them.
- (branch audit, medium) Segment IDs outside the §3.3 `nodeId` set (spaces, non-ASCII, parentheses, > ~100
  characters — Slicer keeps caller-supplied IDs) make `write_glb` reject the whole snapshot. Until `protocol` answers
  `docs/testing/reports/2026-10-19-slicer-3.md`, SLC-07/SLC-27 skip such segments and report them as skipped (tests:
  `"left lung"`, `"Läsion"`, `"Tumor(1)"`, a 110-character ID); then relax the writer's `nodeId == mrmlId/segmentId`
  rule for the agreed alias. The same alias closes `2026-10-18-slicer-3` (raised to medium): with *Hide node names* the
  segment ID must not carry a name — gate for SLC-27.
- (branch audit, low, *partly done in SLC-24: `build_snapshot` writes the root `sceneVersion`/`profile` and checks the
  `sceneVersion` of the `begin`; `begin_snapshot` itself still trusts its arguments*) `begin_snapshot` should check the
  GLB root `extras.sceneVersion`/`profile` and the entity and triangle totals against `begin` (the JSON chunk is already parsed); rule requested in
  `docs/testing/reports/2026-10-19-slicer-4.md` (extends the SLC-06 follow-up on the next snapshot version).
- (branch audit, low) Contract bounds copied into `protocol_client.py` (`PROFILES`, `ALLOWED_EXTENSIONS`, token and
  `sessionId` lengths, `limits`, `viewerLimit`) are not compared with the vendored `defs.schema.json` by a test (only
  `KNOWN_PLATFORMS`, `PROTOCOL_VERSION` and the writer's `PROFILES` are); add one with the next change to the client, so
  a widened bound in a protocol minor cannot make the runtime checks drop valid relay messages.
- (branch audit, low) Relay text still kept in client state: `ErrorInfo.reply_to` (any ≤ 32-character string, in its
  `repr`) and unknown keys copied with `ttl`/`limits`; keep `reply_to` only when it is an id this client issued and copy
  only the schema keys.
- (branch audit, low) `make_client_info` promises "no device identifiers or user names" but checks only the length;
  enforce `sys.platform`-style values (`[a-z0-9_.-]{1,16}`) and a version grammar, with tests for a newline and a
  hostname-like value.
- (branch audit, low, *done in SLC-08: `test_core_purity_import_starts_nothing` imports every core module in a fresh
  interpreter — no runtime dependency, Slicer/Qt, socket or thread*) The FR-02 import guard in `tests/test_skeleton.py`
  covers what `RemoteView.py` imports, which is no core module yet; parametrise it over every `remoteview_core/*.py`
  before SLC-08 adds the transport.
- (branch audit, low) SLC-06 criterion 3 names `session.closed`, but §11 sends only `session.expired` to a publisher;
  the client handles both — SLC-17/SLC-18 tests should target `session.expired`.
- (branch audit, *SLC-09: the panel passes `auto_renew=False`; the default and activity-gated renewal stay open for
  `release`/SLC-17/SLC-18*) The security audit leans to **medium** for the `auto_renew=True` default (NFR-11 idle TTL, T1); the
  one-line change to `False` with SLC-17/SLC-18 opting in on user activity is `release`'s call before SLC-08/SLC-09
  use the client.
- (SLC-23 review, low) A name made only of invisible but allowed characters (U+3164 HANGUL FILLER, U+2800 BRAILLE
  PATTERN BLANK, U+034F, lone combining marks) gives a blank-looking label instead of the substitute; treating such
  names as empty needs an explicit default-ignorable set (Python's `unicodedata` has no such property).
- (SLC-23 review, low) `FORBIDDEN_NAME_CATEGORIES` removes all of `Cf`, including U+200C/U+200D (ZWNJ/ZWJ) that Persian
  or Indic names and emoji sequences need; allowing those two (while still removing bidi controls) changes the writer
  and `names.py` together.
- (SLC-07, decision for SLC-22, *decided in SLC-22: left out until `release` answers
  `docs/testing/reports/2026-10-20-slicer-5.md`*) `visible_model_nodes()` returns the nodes to export; whether hidden models are left
  out (FR-05 "visible model nodes", less possibly-PHI geometry leaves the PC) or exported with `visible: false` so a
  later toggle is a cheap `scene.update` (ADR 0005 Decision 6) is decided with the consent text in SLC-22 (ask `release`).
- (SLC-07, *done in SLC-22: `mrml_scene.py`; the two-level chain is checked in manual §12, an unstructured-grid model
  is reported as `no-triangles`*) The Slicer adapter (SLC-22) follows `docs/research/slicer-collect.md` §3: exact class `vtkMRMLModelNode`, not
  `HideFromEditors` (slice planes), first `vtkMRMLModelDisplayNode` that is not a slice display node, folder hierarchy
  visibility/opacity like the displayable manager, `world_matrix` via `IsTransformToWorldLinear` (never call
  `GetMatrixTransformToWorld` on a non-linear chain — it logs errors), a two-level transform chain test; an
  unstructured-grid model (`GetPolyData()` is `None`) could get its own skip reason for the panel.
- (SLC-07 review) VTK's filters do not bounds-check point IDs: `collect` checks every polygon/strip ID against the point
  count, and that cells are stored as integers (VTK 9.6 keeps a legacy file's `OFFSETS bit`/`float`), before filtering
  (a corrupt or crafted file is skipped as `invalid-geometry` instead of crashing Slicer or aborting the snapshot); with
  *Hide node names* only IDs of the generated shape `vtkMRMLModelNode<N>` are exported, because a hand-edited `.mrml` ID
  could carry a name into every `scene.update` (T7). Segment IDs need their own rule in SLC-27 (Slicer keeps a caller's
  segment ID unchanged, so a name-derived ID passes any shape check) — e.g. a pseudonymous `segmentId` under *Hide node
  names*, which is the protocol decision asked in `2026-10-18-slicer-3`/`2026-10-19-slicer-3`.
- (SLC-07 review, low) `collect_scene` processes every node in one call (≈ 0.75 s for a 1M-triangle mesh on the main
  thread); SLC-28 needs a per-node entry point (*not in SLC-24*) (one node per `QTimer` tick, keeping the `seen` set and the
  `NameAssigner` across ticks). `PassVertsOff`/`PassLinesOff` are now redundant with the geometry-only copy (kept as
  defence in depth).
- (SLC-07 review, low) SLC-07 is ~1,500 changed lines (≈ 415 code, ≈ 940 tests); split SLC-13 (segments vs baking
  transforms) before starting it. *Split: SLC-13 (baking transforms) and SLC-27 (segments); SLC-14
  (decimation and budgets) and SLC-28 (preparing the scene one node per tick).*
- (SLC-07) The dev venv pins numpy 2.5.4 while Slicer 5.12.4 ships numpy 2.4.6; `numpy_support.vtk_to_numpy` warns
  under numpy 2.5 (in-place `.shape`), so `collect._owned` copies without it. Consider pinning the dev venv to Slicer's
  numpy so tests run on the same version.
- (SLC-07 review, low) With *Hide node names* the `nodeId` is still free text inside the generated shape: a hand-edited
  `vtkMRMLModelNode1950010112` passes (up to 10 digits). A pseudonymous `nodeId`/`mrmlId` per session under *Hide node
  names* closes this and the segment-ID gap above together — part of the same protocol question.
- (SLC-07 review, low) `vtkTriangleFilter` triangulates one n-point polygon in roughly O(n²) on the main thread
  (measured: 2,000 / 4,000 / 8,000 points → 0.006 / 0.022 / 0.10 s): a crafted file with a single polygon of a million
  points freezes Slicer. SLC-28 should cap the cell size (*not in SLC-24*) (skip as
  `invalid-geometry`) or measure the cost, together with the per-node entry point above.
- (SLC-07 review, low) `ConsistencyOn` orients each component like its lowest-id cell: a reversed duplicate face
  `(a, c, b)` or a zero-area triangle on distinct point IDs as cell 0 turns the rest of a closed mesh inside out
  (reproduced: 448 of 449 / 211 of 449 faces). Drop exact and reversed duplicate triangles before the normals
  filter, and/or flip a closed component whose signed volume is negative; test with such a face as cell 0.
  *Zero-area part done in SLC-13; reversed duplicate faces remain.*
- (SLC-08) The heartbeat runs in the transport thread (ADR 0009), so `ProtocolClient.build_ping`/`ping_outstanding`
  are unused: SLC-09 removes them (and the `pong` handler) or keeps them for a main-thread liveness display.
  *SLC-09: kept, unused by the panel; SLC-17 removes them unless resume needs them.*
- (SLC-08, *setting and guidance done in SLC-09; the user-guide part remains*) SLC-09 adds the *Additional trusted CA certificate* setting (`extra_ca_file`; store the path, never the
  PEM, in `QSettings`) and shows `Disconnected.error.guidance` when `retry_in` is `None`; the user guide lists the
  unsupported proxy setups (PAC/WPAD, NTLM/Kerberos, SOCKS) and the `wss_proxy` work-around.
- (SLC-08) After a pong timeout the transport aborts the TCP connection without a close frame (the peer is presumed
  gone); §9.3 defines no client close code for it — ask `protocol` only if the relay needs to tell this apart.
- (SLC-08) `RelayTransport` counts dropped frames (`dropped_inbound`, `dropped_outbound`) but nothing shows them yet;
  SLC-18's node list/diagnostics can.
- (SLC-08 review, low, *done in SLC-26: the pong deadline counts the bytes written ahead of the ping; manual §2 step 16*) On a slow uplink the `ping` waits behind up to several MiB of queued chunks, so a live connection
  can miss the 10 s `pong` (reproduced scaled down: 2 of 3 runs). §9.1 is followed literally; options for `protocol`/
  SLC-26: start the deadline when the ping reaches the socket, or extend it while sends make progress; add a
  throttled-uplink manual step to SLC-26's testing.
- (SLC-08 review, low, *done in SLC-09*) When `Disconnected.final_sent` is `False` after Stop (the final `session.close` did not go out
  within 2 s), SLC-09/SLC-22 tell the presenter that the relay keeps the session for its grace period (120 s).
- (SLC-08 review, low, *done in SLC-09*) When `Disconnected.retry_in` is `None` with an error (certificate, proxy, HTTP 4xx, close 1000/
  1009…), SLC-09 also ends the `ProtocolClient` (close it, or add `transport_stopped()`): `transport_lost` alone leaves a
  created/active client in `grace`, waiting for a reconnect that never comes.
- (SLC-08 review, low, *done in SLC-09: the pump yields — a unit test pins the sleep on every tick; manual §2 counts the relay stub's heartbeat pings after ≥ 70 s with the GUI idle*) The transport thread needs the GIL like any Python thread: SLC-09's 50 ms pump yields
  (`time.sleep(0.001)`, architecture §6 step 6), and its manual step checks the heartbeat with the GUI idle through a
  `QTimer`, not with a blocking `queue.get`.
- (SLC-08 review, low, *done in SLC-09: Stop never blocks; module unload waits ≤ 3 s; Slicer exit: `cleanup()` runs inside `aboutToQuit` — manual §2 step 14, SLC-25*) `stop()` joins the worker for up to 3 s (a dead connection waits for the 2 s abort): SLC-09's
  Stop button calls `stop(final, timeout=0)` and updates the panel on the final `Disconnected`; only
  `slicer.app.aboutToQuit` waits.
- (SLC-08 review, low) SLC-08 is ~2,050 changed lines (≈ 730 code, ≈ 1,080 tests, ≈ 245 docs); split SLC-17
  (resume) before starting it.
- (SLC-08 review, low, *done in SLC-09: the panel stops the session with a protocol-violation text*) `Received` also carries binary frames (criterion 1 echoes them), but §3.2 lets only publishers
  send binary: SLC-09's pump treats a binary frame from the relay as a protocol violation (stop and report) instead of
  letting the unbounded event queue grow.
- (SLC-08 review, low) Through an `https://` proxy, `websockets` builds the proxy's TLS context itself, so
  `SSLKEYLOGFILE` still logs the keys of the proxy hop (CONNECT line, a `Proxy-Authorization` password), not of the
  relay connection; passing `proxy_ssl` with `keylog_filename = None` needs the proxy resolved first — revisit if
  https proxies show up.
- (SLC-08 review, low, for SLC-10, *done in SLC-10*) `segno` is pinned exactly; `--require-hashes` is not used
  (`pip_ensure` takes no hashes — `docs/research/slicer-deps.md`); `RelayTransport.start()` keeps its floor of
  `websockets` ≥ 15 and the exact pin is enforced where packages are installed.
- (SLC-08, for `release`) `docs/architecture.md` §6 step 6 still names `websockets.sync.client`; ADR 0009 replaces it
  with the asyncio client in one worker thread — filed for `release` in `docs/testing/reports/2026-10-20-slicer-3.md`
  (update §6, add ADR 0009 to `docs/adr/README.md`).
- (SLC-09) The relay address has no default yet (`DEFAULT_RELAY_URL = ""` in `RemoteView.py`): a built-in host would
  send data to whoever controls that name, so the constant waits for `deploy` to name the production relay (DEP-07) and
  `release` to confirm it.
- (SLC-09) A refused `session.create` (`RATE_LIMITED`, `CAPACITY`) stops the transport and shows the reason instead of
  waiting `retryAfterS` (up to 10 min) behind an unchanged panel; the user retries.
- (SLC-09) `QFont.setLetterSpacing(QFont.PercentageSpacing, 130)` and `setStyleHint(QFont.Monospace)` on the code label
  are standard Qt 5.15/6.8 API; their PythonQt binding and the look are checked manually (§2) `[TODO verify]`.
- (SLC-09 review, low) The panel shows "the relay keeps the session for up to 2 minutes" after a lost stop message
  unless a valid `session.expired`/`session.closed` for this session arrived first (`ProtocolClient.ends_session`,
  T11); a fatal `error` racing the Stop (or the relay's close code, which the transport does not report after
  `stop()`) still gets that conservative text — revisit with SLC-17/SLC-18 if testers report it. The opposite gap:
  when the panel ends a live session itself (fatal `error`, binary frame) and its own `session.close` is lost, it
  shows only the reason, not the 2-minute warning (T1; the write must stall for 2 s) — SLC-18 can append it.
- (SLC-09 review, low) After a relay restart (close `4008`, §9.3) a live session ends with the 2-minute text, but a
  restarted relay keeps no sessions (§13 step 9); SLC-17 re-creates with `session.create{preferredCode}` per §9.3 and
  replaces the text.
- (SLC-09) SLC-09 is ~1,890 changed lines (≈ 350 controller, ≈ 100 adapter, ≈ 215 `.ui` XML, ≈ 20 `ends_session`,
  ≈ 1,070 tests and stubs, ≈ 135 docs) against the ~300-line guideline; *done: SLC-22 (consent, Slicer
  `scene_api`) and SLC-24 (first snapshot) were split before SLC-22 started*; a future panel should land as core +
  tests first, then `.ui` + adapter + manual section.
- (SLC-22 review, low) Hidden models are left out of the snapshot (`2026-10-20-slicer-5`), so SLC-15/SLC-16 must
  classify a node that turns visible but is not in the last snapshot as `added` (`scene.nodeAdded{snapshotFollows}` +
  a snapshot — §8.1: viewers ignore updates for unknown nodes), with a unit test; hiding stays
  `scene.update{visible:false}`.
- (SLC-22 review, low) SLC-22 is ~800 changed lines (≈ 200 code, ≈ 420 tests, ≈ 180 docs) against the ~300-line
  guideline; *done: SLC-24 was split into SLC-24 (snapshot core), SLC-25 (panel, manual §2) and SLC-26
  (slow-uplink heartbeat) before it started*.
- (SLC-09 post-review, low) `test_panel_texts_are_plain_and_complete` does not stop a fixed duration returning to the
  `MAX_LIFETIME` text (assert no digits in `END_REASONS`), and the `repr(ctl.view)`/`repr(ctl)` checks in
  `test_panel_never_logs_or_prints_the_code_or_token` run on an idle view — take the repr of the live view instead.
- (SLC-22 post-review, low) Consent text: show `ENCRYPTED` only for `wss://` and no encryption sentence for addresses
  Start refuses (`WS://…`, `http://…`, a bare host); `wss://[::]/ws` and zone-ID IPv6 hosts fall back to the generic
  receiver. Tests: the stdlib-only AST check must also fail on relative imports (`ImportFrom.level > 0`); assert
  `relay_host("ws://[::1]:8787/ws") == "::1"` and that `consent._LOOPBACK` equals `transport._LOOPBACK`. Docs: the
  consent text covers clipping, not opacity 0 (`mrml_scene.py` docstring, `slicer-scene.md` §1 and its accepted
  differences) until `release` answers `2026-10-20-slicer-5`.
- (SLC-24 review, low) SLC-24 is ~450 changed lines (≈ 120 code, ≈ 290 tests, ≈ 40 docs) against the ~300-line
  guideline. The test helpers shared across modules moved to `tests/support.py` in SLC-26.
- (SLC-25 review, low, *refused frames done in SLC-26: `discard_queued`; the stop during an upload stays*) The frames
  of a snapshot the relay refuses are already queued and still leave the PC. On a slow uplink a Stop or Slicer exit
  during the upload waits behind the bytes already written — the buffers hold ≈ 4 MB, about 35 s at 1 Mbit/s — so the
  stop message misses the 2 s abort (reproduced: `final_sent` false, no `session.close` at the relay) and the relay
  keeps the code and the cached scene for its grace period (the panel says so; manual §2 step 16 stops and quits during
  an upload; US-03/FR-13 are not met in that window — `2026-10-20-slicer-6`). A smaller `chunkSize` alone does not
  help; limiting the bytes written ahead of the next frame (e.g. no more than a few MiB before the last `ping` is
  answered) would — revisit with SLC-28/SLC-16.
- (SLC-25 review, low) The code is painted only after the scene was collected (`build_snapshot` runs in the same pump
  tick as `session.created`); SLC-28's per-node collection should show the code first ("Preparing the scene").
- (SLC-25 review, low) SLC-25 is ~560 changed lines (≈ 110 code, ≈ 370 tests, ≈ 80 docs) against the ~300-line
  guideline. Its test module imported helpers from three sibling test modules — *done in SLC-26: `tests/support.py`*.
  The too-large text reads "accepts 0.0 MB" for a relay limit under 100 kB (no real relay; show "less than
  0.1 MB" then), and the scene state could become an `enum.Enum` like `Phase`.
- (SLC-26) The pong deadline assumes an uplink of at least 1 Mbit/s (`MIN_UPLINK_BYTES_PER_S`) and at most 8 MiB unread
  ahead of a ping; a slower link with a large backlog is taken for dead after 10 s + backlog / 1 Mbit/s and ends the
  session (no resume before SLC-17; measured with timers scaled 1:25: a 1.4 MB snapshot at 60 KB/s is cut after 12.9 s). The same rule makes a
  dead peer behind a full backlog take up to ≈ 77 s to detect instead of NFR-21's 25 s (`release`:
  `2026-10-20-slicer-6`), and the relay's own WS ping must count inbound frames (`server`: `2026-10-20-slicer-7`).
  The 4.3 MB / 8 MiB buffer figures are Linux loopback; Windows and macOS are `[TODO verify]` in manual §2 step 16. The
  pong deadline is checked between sends only. SLC-26 changes about 60 lines of code; the rest of its ~1300 added lines are
  tests, the Node proxy and docs, with ~430 lines of shared test helpers moved into `tests/support.py`.
- (SLC-26 review, low) The credit for what a minimum link has read since the last answered `ping` starts at that
  `pong`, not at the first byte written after it: after an idle spell a burst written shortly before the next `ping`
  is credited with reading that never happened (at most `ping_interval − pong_timeout` = 5 s of deadline), so a link
  within a few percent above 1 Mbit/s can be cut while a later snapshot (SLC-16) goes out. Start the clock when the
  oldest unconfirmed byte is written (in `_send`), with a scaled test (idle 0.7 s, then a chunk, link at 1.1× the
  minimum).
- (SLC-26 review, low) `_written` counts `len(data)`: characters for a text frame, while `_encode` keeps non-ASCII
  (`ensure_ascii=False`), so up to 4× fewer bytes than are on the wire; negligible for control frames, not for
  SLC-16's `scene.update` frames with node names (≤ 256 KiB). Count `len(data.encode())` for `str`; test with a large
  text frame ahead of a `ping`, and tighten the cap test's upper bound (≈ 0.8 s) so that a doubled cap fails.
- (SLC-26 review, low) `discard_queued(connection=…)` drops every frame queued for the connection, not only the refused
  snapshot's; correct while nothing else is queued behind a snapshot. When SLC-15/16/17 queue `session.renew`,
  `scene.update` or a resume reply, restrict it to the snapshot's frames (a predicate or the scene version) and test
  what is kept.
- (SLC-26 review, low) Timing margins of a few tests are tighter than needed (`ping_interval` 0.05 assumes the chunk is
  queued within 50 ms of the create; the discard test assumes the buffers hold under 32 MiB); they passed 3× sequential
  and 3× in parallel on 4 cores. If CI shows a flake, queue the chunk together with the create and scale the
  intervals.
- (SLC-26 review, low) The panel text `FINAL_NOT_SENT` could say that the code stays valid and the scene stays visible
  for up to 2 minutes. The SLC-26 commit also carries the move of the shared test helpers into `tests/support.py`
  (verbatim apart from `FakeTransport.discarded`); it could have been a preparatory commit.
- (SLC-10) The exact pin refuses a working hand-installed `websockets` 16.x or 17.3 until the user accepts the
  replacement (`docs/research/slicer-deps.md` decision 4); relax to a range if hospitals complain. `segno` is
  installed (and named in the dialog) before SLC-11 uses it — SLC-11 follows at once. Hashes and wheels-only (`--require-hashes --only-binary :all:`
  through `pip_install`; `pip_ensure` cannot pass either) and a Windows run of manual §3 step 6 (replacing a loaded extension file) are open. SLC-10
  is ~1100 changed lines (≈ 300 code, ≈ 690 tests and fixtures, ≈ 180 docs) against the ~300-line guideline.
- (SLC-11) The link takes the viewer host from the relay URL; a separate viewer domain would need a setting or the
  relay's `clientInfo` (`[TODO verify]` with `deploy`, DEP-07). The clipboard keeps the link (and so the code) after the
  session ends — the *Copy link* tooltip says so; clearing it is the user's choice (`release` is asked to name the
  clipboard in T6, report `2026-10-21-slicer-2`). The "Link copied" timer is a bare `QTimer.singleShot` that can fire
  after the module was unloaded (it only resets a button text). The Qt calls of the QR painting and the
  clipboard are verified only against stubs and `[TODO verify]` in manual §4. A link over 64 characters (a host over 48)
  gives no QR code; the panel says to read the code out. SLC-11 is ~1250 changed lines (≈ 260 code, ≈ 740 tests and
  stubs, ≈ 250 `.ui` and docs) against the ~300-line guideline; split UI tasks along the core/adapter seam next time.
  Without a QR code the window says "type the code" but not where the viewer is (the origin without the code would
  help); a relay that is not at `/ws` gets no link (`release`/`deploy` to confirm whether sub-paths are supported).
- (SLC-11 review, low) Criterion 2 is checked only up to the camera's link banner: re-run manual §4 step 4 (scan, then
  automatic join) with relay (b) once the viewer's deep link (WEB-11) and the relay's `/j` route (SRV-16) are deployed.
- (SLC-11 review, low) `PanelView` carries a link only in `LIVE`, like the code, but nothing enforces "no link without a
  code": add `PanelView.__post_init__` raising for `link and not code` (or a panel test that leaves `LIVE` during
  `_show`) before SLC-17 adds another caller that passes a code.
- (SLC-11 review, low) Windows clipboard history (Win+V) and cloud clipboard keep a copied link after the session ends;
  besides the two options of report `2026-10-21-slicer-2`, the copy could carry the Windows formats
  `CanIncludeInClipboardHistory` = 0 and `CanUploadToCloudClipboard` = 0 through `QMimeData`
  (`application/x-qt-windows-mime;value="…"`) — `[TODO verify]` against Microsoft's clipboard-format and Qt's
  `QMimeData` docs.
- (SLC-11 review, low) Adapter gaps: `cleanup()` raises `AttributeError` when `setup()` never ran (guard on `self.ui`);
  the `self.ui is not None` guard in `resetCopyLinkText` never triggers (set `self.ui = None` at the end of
  `cleanup`); the Presentation window is never `deleteLater()`-ed and its attributes are set before its font setup
  succeeds; no test that the 64 pt font is assigned back to the label, nor of `painter.end()` after a failing
  `fillRect`; the window's hint is in the `.ui` and in `SCAN_HINT` (empty the `.ui` text or test they match).
- (SLC-12) One quantisation step per mesh: the error is at most extent / 131,068, so criterion 1's 1e-5 m holds up to a
  1.3 m extent (a 1.8 m whole-body model: 14 µm; `docs/research/slicer-quantize.md`). SLC-14's `estimate_glb_size`
  counts quantised bytes (12 per vertex, plus the indices and the JSON chunk). The two relay-stub tests of
  `test_snapshot.py` needed larger spheres to keep their sizes (> 2 chunks, > 1 MB) once snapshots are quantised, and
  manual §2 step 16 now uses five spheres of 95,920 triangles (5.8 MB quantised, within the `mobile` budget so that
  SLC-14 will not decimate them). FR-09 says "16-bit normals" while §7.4 and the writer use 8-bit — report
  `2026-10-21-slicer-3` (with the measured 1M-triangle size for architecture §4). SLC-12 is ~600 changed lines
  (≈ 200 code, ≈ 290 tests, ≈ 110 docs); kept whole — the code part is one cohesive writer change.
- (SLC-14) The profile is still the panel's default `mobile` (the selector is SLC-18), and a 400k-triangle node takes
  ≈ 3 s of the main thread, up to ≈ 8 s when all three filters run, ≈ 11 s for a 700k quadric (SLC-28: one node per
  tick with a progress dialog). `vtkQuadricDecimation` is roughly cubic on edges shared by many triangles (a
  "book" of 3,000 pages: 73 s, `vtkDecimatePro` 2.7 s): SLC-28 should skip the quadric for non-manifold input or
  refuse such edges as `invalid-geometry`. The size estimate is within 0.1 % for
  meshes of thousands of triangles and +4 % for 40 tiny cubes (measured JSON sizes; the binary part is exact). The
  too-large text still says "Hide models in 3D": with SLC-18's profile selector it should also offer a smaller
  profile (NFR-23 "guidance to raise decimation"). Decimation preserves the winding; a node that changes size
  between snapshots gets a new share — SLC-16's re-export must reuse `fit_to_budget` over the whole scene. Mutants:
  40 (incl. 20 after the reviews: GLB written from the unfitted scene, the profile ignored, the total ignored, no
  normal repair, normals rotated twice or inward, no float32 check, no bounds or repeated-vertex check, one
  triangle over the share, the pre-write check on the unfitted or float scene, `T.matrix`/`baked` dropped), 39
  killed; `sum(floors) >= total` vs `>` is equivalent (both
  give the floors). SLC-14 is ~1,250 changed lines (≈ 380 code, ≈ 700 tests, ≈ 170 docs): kept whole after the
  split, since the budgets, the filters and the size estimate are tested together by criteria 1 and 3.
- (SLC-14 review, medium → documented) `vtkQuadricDecimation` is super-linear on dense, exactly flat regions (tied
  zero-error collapses): a flat 0.1 m plane of 180k triangles takes 57 s to reach 100k and 237 s / 2.3 GB to reach
  2k; an unsmoothed segmentation-like surface of 427k triangles with flat caps (cut by the volume border) took 437 s /
  3 GB to reach 100k, where `vtkDecimatePro(PreserveTopologyOn)` needs ≈ 3 s; with Slicer's default smoothing (0.5)
  the same input takes ≈ 8 s. `AbortExecuteOn` from a progress observer stops it only after ≈ 16 s (7 progress
  events). Slicer is frozen meanwhile, with unsaved work open. SLC-28 must bound one node's time (its criterion 2):
  e.g. `vtkDecimatePro` first for large coplanar regions (a size threshold alone does not help: a 28.8k-triangle
  flat plane is slow too) — a change of ADR 0005's filter order (erratum requested in report `2026-10-21-slicer-4`,
  which also covers SLC-14's third filter). Not one-node-per-tick: a single node is the problem. Meshes whose
  triangles share no points (a "triangle soup" STL) come out of the filters with holes; merging coincident points
  (`vtkCleanPolyData`, tolerance 0) before decimating is for SLC-28 too.
- (SLC-14 review, low) §7.5's "max visible nodes" (120/60/120) is neither modelled nor warned about, and when the
  2k floors alone exceed the total the scene goes out above the profile's triangle total without a warning: SLC-18's
  panel warnings should cover both (a `FitResult.over_total` flag, `Budget.max_nodes`). `glb_binary_size` repeats
  the writer's index-width rule (tested at 65,535/65,536 points; one shared helper would remove the copy).
- (SLC-13) Orientation after a bake is judged at the first triangle: a warp that mirrors only part of a mesh (a
  folding grid transform) may leave that part facing inwards — per-component signed volume (closed meshes) would
  catch it, together with the reversed-duplicate-face case of the SLC-07 `ConsistencyOn` follow-up, whose
  zero-area part SLC-13 closed. §7.3 names non-linear transforms only; sheared and zero-scale matrices are baked
  too (report `2026-10-18-slicer-4` asks `protocol` to say so). A change of a baked node's transform needs a
  re-export, not a `scene.update` matrix — SLC-16 must classify it as geometry. Mutants: 15, 13 killed (one more
  test after the review: a warp that mirrors at the mesh but not at the origin); the `Identity()` before
  `GetTransformToWorld` is equivalent for a new transform (kept: the 3D view does the same) and the
  first-vs-last-triangle seed is equivalent for transforms that mirror everywhere or nowhere. SLC-13 is ~600 changed
  lines (≈ 130 code, ≈ 330 tests, ≈ 140 docs); kept whole — one cohesive change to the collection pipeline.
- (SLC-13 review, low) A bake that leaves no triangle with an area (a zero scale on two axes, a spline with
  coincident landmarks) is reported as `no-triangles`, and `diag(1e-50, …)` is now baked to an invisible point mesh
  that is still sent: SLC-18's node list should say "transform collapses the model" (a reason of its own, or
  `invalid-transform`). Main-thread cost (SLC-28): the zero-area check takes ≈ 0.5 s and ≈ 300 MB peak on a
  2M-triangle model; a bake is one `TransformPoints` call — decimate before baking or chunk it, and debounce re-bakes
  in SLC-16. The suite now sets `filterwarnings = ["error"]` in `pyproject.toml`.
- (SLC-13 review, low) The bake writes double-precision points, while the 3D view's `vtkTransformFilter` keeps the
  input's precision (float for most models): the positions can differ in the last float32 bit, far below the GLB's
  quantisation step.
- (SLC-12 review, low) `MIN_POSITION_STEP` is tested only at zero extent (add a 1 µm mesh); `size_report`'s per-view
  dedupe is defensive (`write_glb` gives each accessor its own view) and untested; `add_view` builds its dict in two
  steps — tidy when the writer is next touched.
- (SLC-22) The consent text describes models only: SLC-27 (segments) and SLC-18 (*Hide node names*) extend the text and
  its string test together with what they add to the export.
- (SLC-22) *Reload* re-executes only `RemoteView.py`; `remoteview_core` stays imported (`docs/research/slicer-scene.md`
  §2), so a developer restarts Slicer after changing the core — SLC-19/SLC-20 may add an `onReload` that re-imports
  it, as Slicer's WebServer module does.
- (SLC-08) Whether the Railway edge sends TLS 1.3 session tickets and which CA issues `*.up.railway.app` is
  `[TODO verify]` (`openssl s_client -connect <relay-host>:443 -showcerts`); the asyncio client does not depend on it.
- (SLC-07) Determinism of `vtkPolyDataNormals` under Slicer's TBB backend is supported by the source only (the wheel has
  no TBB); the manual SLC-19 check should compare two exports of the same scene byte for byte.

## Manual verification needed

Everything touching `slicer.*`/`qt.*` runs only in a real 3D Slicer 5.12.x (macOS and Windows — NFR-24):
module load (§1), Start/Stop and first snapshot with a phone (§2), dependency install dialog and offline error
(§3), QR scan from 1 m and code readability from 2 m (§4), baked transforms (§5), segments (§13), debounce
behaviour (§6), Wi-Fi drop and relay redeploy resume (§7), hide names / viewer count / budgets (§8), module
self-test (§9), zip install (§10), Polish UI (§11), consent text and scene adapter (§12). Each section of
`docs/testing/slicer.md` records date, Slicer version, OS and result.
