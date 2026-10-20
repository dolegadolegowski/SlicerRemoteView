# Manual tests — `slicer` (3D Slicer extension `SlicerRemoteView`, module `RemoteView`)

Owned by the `slicer` workstream (`docs/plan/slicer.md`). These steps need a real 3D Slicer **5.12.x** and cannot
run in the sandbox (CLAUDE.md rule 10). Record every run in the section's results table: date, Slicer version,
OS, result (`pass` / `fail` + note), tester. Automated checks run with `slicer-plugin/.venv/bin/pytest slicer-plugin`
(see `slicer-plugin/README.md`).

## §1 Module loads (SLC-01; FR-01, FR-02, NFR-24)

Preconditions: 3D Slicer 5.12.x installed (macOS and Windows both need a run); repository cloned; an empty scene
(nothing unsaved — the steps restart Slicer).

Steps:

1. Baseline: in *Edit → Application Settings*, turn off automatic update/extension checks if your build offers
   them, so Slicer's own traffic does not hide the module's. Start a network monitor on the process that loads the
   modules, `SlicerApp-real` (macOS: *Little Snitch* or `nettop -p SlicerApp-real`; Windows: *Resource Monitor →
   Network*, `SlicerApp-real.exe`; `[TODO verify]` the process name on each OS). Start Slicer **without** the module
   path, wait until the main window is idle and note the connections Slicer opens on its own. Quit Slicer.
2. With the monitor still running, start Slicer, open *Edit → Application Settings → Modules*, under
   *Additional module paths* click *Add* and choose `<repo>/slicer-plugin/RemoteView`. Click *OK* and restart Slicer
   when asked (the module is imported during this restart).
3. Open the Python console (*View → Python Console*) and keep it visible.
4. Open the module selector (*Modules* drop-down) → *Remote* → *RemoteView*.
5. In the Python console run `slicer.selfTests["RemoteView"]()`; alternatively enable developer mode
   (*Edit → Application Settings → Developer*, restart required) and click *Reload and Test* in the module panel.
6. Compare the monitor with the baseline of step 1 for the restart in step 2 and for steps 4–5.

Expected results:

- Step 2: no error about the module path; after the restart there is no traceback mentioning `RemoteView` in the
  Python console or in *Help → Report a bug → log*.
- Step 4: the category *Remote* contains *RemoteView* with the Wi-Fi-style blue icon; the panel opens with the
  sections *Session* ("Not connected.", *Start session*, *Stop session* greyed out), *Shared nodes* and a collapsed
  *Advanced* (since SLC-09; §2 tests them). The *Help & Acknowledgement* section says nothing is sent before *Start
  session* and lists what is sent afterwards; no error in the Python console.
- Step 5: the Python console shows "RemoteView load test passed" and no error dialog appears (*Reload and Test*
  shows a dialog only on failure); the scene is not cleared.
- Step 6: no connection beyond the baseline (opt-in rule — FR-02, Extension Index tier 1); no pip/installation
  dialog appears.

Re-run after SLC-03 (vendored protocol package in `RemoteView/_vendor/`): repeat steps 2–5 with the updated checkout and
additionally run in the Python console:

```python
from remoteview_core import vendored
print(vendored.PACKAGE_DIR)
print(vendored.chunk_header.CHUNK_HEADER_BYTES, vendored.alphabet.is_code("7KQ4X"))
import sys; print(hasattr(sys.modules["remoteview_protocol"], "compile_schemas"))
```

Expected: `<repo>/slicer-plugin/RemoteView/_vendor/remoteview_protocol`, then `12 True`, then `False` (the package
`__init__` with the schema layer never runs in the core, even where `jsonschema` is installed); no traceback; no
network connection beyond the baseline. For an
extension built with CMake/CPack the path is inside the extension's `qt-scripted-modules/` directory. `[TODO verify]`
that `RESOURCES` keep the `_vendor/remoteview_protocol/schema/` sub-directory: the 30 `*.schema.json` files must exist
there.

Re-run after SLC-06 and SLC-23 (pure core: coordinates, GLB writer, protocol client, names — Slicer's own Python and numpy): repeat
steps 2–3, then paste into the Python console:

```python
import sys
import numpy as np
from remoteview_core.coords import ras_to_gltf_points
from remoteview_core.glb_writer import Entity, RootExtras, write_glb
from remoteview_core.protocol_client import ProtocolClient, make_client_info
points = ras_to_gltf_points(np.array([[0, 0, 0], [100, 0, 0], [0, 0, 50]], dtype=float))
entity = Entity(node_id="vtkMRMLModelNode1", kind="model", name="Smoke", positions=points,
                normals=np.tile([0.0, 0.0, 1.0], (3, 1)), indices=np.array([[0, 1, 2]]),
                color=(1.0, 0.5, 0.0), opacity=1.0, visible=True, mrml_id="vtkMRMLModelNode1")
version = slicer.app.applicationVersion
glb = write_glb([entity], RootExtras(scene_version=1, profile="mobile", slicer_version=version))
client = ProtocolClient(make_client_info(version, sys.platform))
print(glb[:4], len(glb) % 4, client.start("mobile")["type"], client.state.value)
from remoteview_core.names import sanitize_name
print(sanitize_name("Patient\a Name  "), sanitize_name("\U0001F600" * 40) == "\U0001F600" * 32)
```

Expected: `b'glTF' 0 session.create connecting`, then `Patient Name True` (SLC-23 with Slicer's own `unicodedata`); no traceback (if `make_client_info` raises "≤ 64 characters", note the
`applicationVersion` string in the results table); no network connection beyond the baseline (the client only builds
messages — sockets arrive with SLC-08) and no pip dialog.

Re-run after SLC-07 (model collection with Slicer's own VTK): with any scene loaded (the snippet adds and then removes
one model), paste into the Python console:

```python
import numpy as np, vtk
from remoteview_core.collect import collect_scene
from remoteview_core.glb_writer import RootExtras, write_glb
sphere = vtk.vtkSphereSource(); sphere.SetCenter(100, 30, -20); sphere.SetRadius(10); sphere.Update()
model = slicer.modules.models.logic().AddModel(sphere.GetOutput())
class Api:  # minimal stand-in for the SLC-22 adapter
    def visible_model_nodes(self): return [model]
    def node_id(self, n): return n.GetID()
    def name(self, n): return n.GetName()
    def polydata(self, n): return n.GetPolyData()
    def display_props(self, n):
        d = n.GetDisplayNode(); return d.GetColor(), d.GetOpacity(), bool(d.GetVisibility() and d.GetVisibility3D())
    def world_matrix(self, n): return np.eye(4)
before = (model.GetPolyData().GetMTime(), model.GetPolyData().GetNumberOfPoints())
scene = collect_scene(Api())
print(len(scene.entities), scene.skipped, np.round(scene.entities[0].positions.mean(axis=0), 4))
print(before == (model.GetPolyData().GetMTime(), model.GetPolyData().GetNumberOfPoints()))
glb = write_glb(scene.entities, RootExtras(scene_version=1, profile="mobile", slicer_version=slicer.app.applicationVersion))
print(glb[:4]); slicer.mrmlScene.RemoveNode(model)
```

Expected: `1 () [ 0.1  -0.02 -0.03]` (RAS (100, 30, −20) mm → glTF metres, +Y up), `True` (the model's mesh is
untouched), `b'glTF'`; no traceback (in particular no `DeprecationWarning`/`ImportError` from `vtkmodules`) and no
network connection beyond the baseline.

Re-run after SLC-08 (transport: Slicer's own Python `ssl`/OpenSSL 1.1.1; Windows, macOS **and** Linux). Until SLC-10
installs it after consent, install the pinned client by hand in a **test** Slicer only: `slicer.util.pip_install(
"websockets==17.2")`. With internet access, paste into the Python console:

```python
import os, queue, ssl
from remoteview_core.transport import RelayTransport, Connected, Disconnected
print(ssl.OPENSSL_VERSION, os.environ.get("SSL_CERT_FILE"), ssl.create_default_context().cert_store_stats())
def attempt(url):
    events = queue.Queue(); t = RelayTransport(url, events); t.start()
    event = events.get(timeout=20); t.stop()
    error = getattr(event, "error", None)
    return type(event).__name__, error and error.kind.value, error and error.verify_code, getattr(event, "retry_in", None)
for host in ("self-signed.badssl.com", "expired.badssl.com", "wrong.host.badssl.com", "untrusted-root.badssl.com"):
    print(host, attempt(f"wss://{host}/"))
print("relay", attempt("wss://<relay-host>/ws"))  # the deployed relay (docs/deploy.md); skip if none yet
```

Expected: `OpenSSL 1.1.1…`, the path of `Slicer.crt`, `x509_ca` ≈ 119 on macOS/Linux (more on Windows: the system
store is added); then `('Disconnected', 'tls-certificate', 18, None)`, `(…, 10, None)`, `(…, 62, None)`,
`(…, 19 or 20, None)` — certificate errors are never retried; the relay line shows `('Connected', None, None, None)`
within 3 s (run that line 20 times: no 10-second stall, ADR 0009). No traceback, no code or token in the Python console
or the application log. Behind a TLS-inspecting proxy note the code shown on each OS (report
`docs/testing/reports/2026-10-20-slicer-1.md`).

| Date | Slicer version | OS | Result | Tester |
|---|---|---|---|---|
| | | | | |

## §2 Session panel: Start, code, Stop (SLC-09; US-01, FR-03, FR-13)

Preconditions: a **test** Slicer 5.12.x with the module path of §1; until SLC-10 installs it after consent, install the
pinned client once in that Slicer's Python console: `slicer.util.pip_install("websockets==17.2")`. Relays: (a) the
relay stub of `tools/fake-slicer` on the same machine — once, from the repository root (Node 22): `npm ci` and
`npm run build -w shared -w tools/fake-slicer`; then, in a terminal kept open next to Slicer,
`node slicer-plugin/tests/relay_stub.mjs --port 8787`, which prints `ws://127.0.0.1:8787/ws` and, when you end its
input (Ctrl-D; Ctrl-Z then Enter on Windows), two numbers — the `session.close` messages and the heartbeat `ping`s it
received (e.g. `1 4`) — then exits; (b) a deployed relay (`wss://<relay-host>/ws`, `docs/deploy.md`), needed for step
10 only (steps 3–8 work with either). For the CA steps keep any small non-certificate file and any PEM certificate at
hand (e.g. Slicer's own `Slicer.crt`, whose path the SLC-08 snippet prints).

Steps:

1. Start the test Slicer with no RemoteView settings (a fresh profile, or remove the `RemoteView/*` keys from its
   settings file) and open *RemoteView*. The panel shows *Session* (relay address, *Start session*, *Stop session*
   greyed out, "Not connected."), *Shared nodes* (placeholder text) and a collapsed *Advanced* section (additional CA
   certificate).
2. Type `wss://user:secret@relay.example.org/ws` and click *Start session*. Then restart Slicer and open *RemoteView*.
3. Type the relay address of the preconditions and click *Start session*.
4. Leave Slicer idle (no mouse/keyboard) for at least 70 s with the session running.
5. Click *Stop session*. For relay (a), end its input and note the two numbers it prints; start it again with the same
   command (same port).
6. Restart Slicer and open *RemoteView* again.
7. Click *Start session* (the remembered address), wait for the code, then reload the module (*Developer mode →
   Reload*). For relay (a), end its input and note the numbers.
8. With relay (a) still stopped (with relay (b): type `wss://127.0.0.1:9/ws`, where nothing listens), click *Start
   session*; after a few seconds click *Stop session*. Start relay (a) again (same command).
9. In *Advanced*, pick the non-certificate file as *Additional trusted CA certificate* and click *Start session*. Then
   reload the module and open *Advanced*.
10. Pick the PEM certificate instead and start a session with relay (b) (`wss://`; with relay (a) the connection uses no
    TLS, so the certificate plays no part); stop it. Restart Slicer and open *RemoteView*.

Expected results:

- Step 2: "Cannot start the session." and "relay URL must not carry user info, a query or a fragment (no secrets in
  URLs, §3.1)" — the address is never echoed; nothing is sent; after the restart the address field is **empty** (the
  refused address was not remembered).
- Step 3: "Connecting to …", then within 3 s a 5-character code in large letters (monospace, visibly letter-spaced —
  `[TODO verify]` the PythonQt `QFont` calls) and "Session running · no viewers yet."; *Start* and the address field are
  disabled, *Stop* enabled (US-01, FR-03).
- Step 4: the status stays "Session running" (the transport thread pings every 15 s and the relay answers, also with
  the GUI idle — the 50 ms pump yields the GIL; architecture §6).
- Step 5: "Stopping…", then "Not connected."; the code disappears; relay (a) prints `1 N` with N ≥ 4: one
  `session.close` (FR-13) and a heartbeat every 15 s after the code appeared (N is about the session's seconds / 15;
  fewer means the transport thread was starved — report it with the Slicer version and OS).
- Step 6: the relay address of step 3 is filled in (remembered in Slicer's settings); *Advanced* is collapsed.
- Step 7: after the reload the panel is idle and relay (a) prints `1 …` (first number 1): unloading the module closed
  the session.
- Step 8: "Relay unreachable — retrying in N s." with guidance; N is rounded up (at least 1) and grows (1, 1–2, 2–3, …
  up to 30 s); *Stop* returns to "Not connected." at once.
- Step 9: "Cannot start the session." and "the extra CA file holds no usable certificate (PEM or DER)"; nothing is
  sent; after the reload the CA field is **empty** (the refused file was not remembered).
- Step 10: while the session connects and runs, the line under the status reads "An additional CA certificate is
  trusted for this connection." (T5); after the restart the PEM path is still selected and *Advanced* is expanded, so
  the extra trust anchor stays visible.
- Throughout: no traceback in the Python console, no session code or token in the console or the application log.

| Date | Slicer version | OS | Result | Tester |
|---|---|---|---|---|
| | | | | |
