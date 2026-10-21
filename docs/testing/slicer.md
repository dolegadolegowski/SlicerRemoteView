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

Re-run after SLC-08 (transport: Slicer's own Python `ssl`/OpenSSL 1.1.1; Windows, macOS **and** Linux). Install the pinned
client first, by a first *Start session* (§3) or by hand in a **test** Slicer only: `slicer.util.pip_install(
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

## §2 Session panel: Start, code, scene, Stop (SLC-09, SLC-25; US-01, US-03, FR-03, FR-05, FR-08, FR-13)

Preconditions: a **test** Slicer 5.12.x with the module path of §1; the first *Start session* asks before installing the
pinned client (§3); or install it once in that Slicer's Python console: `slicer.util.pip_install("websockets==17.2 segno==1.6.6")`. Relays: (a) the
relay stub of `tools/fake-slicer` on the same machine — once, from the repository root (Node 22): `npm ci` and
`npm run build -w shared -w tools/fake-slicer`; then, in a terminal kept open next to Slicer,
`node slicer-plugin/tests/relay_stub.mjs --port 8787`, which prints `ws://127.0.0.1:8787/ws` and, when you end its
input (Ctrl-D; Ctrl-Z then Enter on Windows), two numbers — the `session.close` messages and the heartbeat `ping`s it
received (e.g. `1 4`), then one `v<sceneVersion>:<sha256>` per scene snapshot it received — then exits; (b) a deployed
relay (`wss://<relay-host>/ws`, `docs/deploy.md`) with its viewer page (ADR 0006); (c) `relay-server` and `web-viewer`
from `main` on this machine — in a checkout of `main`, `npm ci`, then `ALLOWED_ORIGINS=http://localhost:5173
TRUST_PROXY=false npm run dev -w relay-server` and `npm run dev -w web-viewer` (relay address
`ws://127.0.0.1:8787/ws`, viewer `http://localhost:5173`; in PowerShell set the two variables first:
`$env:ALLOWED_ORIGINS='http://localhost:5173'; $env:TRUST_PROXY='false'`) — it listens unencrypted on every interface, so use sample
data only or a host firewall. Step 10 needs (b); steps 11–14 need (b) or (c); the others
work with any. For the CA steps keep any small non-certificate file and any PEM certificate at
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
11. With relay (b) or (c): load *MRHead* (*Sample Data*) and a model — e.g. the spheres of §12 — and click *Start
    session*.
12. Open the viewer (a phone with relay (b), or `http://localhost:5173` with relay (c)) and join with the code.
13. Click *Stop session* while the viewer shows the scene.
14. Start again, join with the viewer, then quit Slicer (*File → Exit*, confirm).
15. Orientation phantom (SLC-05 follow-up): in a new scene, run in the Python console

    ```python
    import vtk
    for name, center, color in (("R+100", (100, 0, 0), (1, 0, 0)), ("A+100", (0, 100, 0), (0, 1, 0)),
                                ("S+100", (0, 0, 100), (0, 0, 1)), ("Origin", (0, 0, 0), (1, 1, 1))):
        source = vtk.vtkSphereSource()
        source.SetRadius(10 if name == "Origin" else 15)
        source.SetCenter(center)
        source.Update()
        model = slicer.modules.models.logic().AddModel(source.GetOutput())
        model.SetName(name)
        model.GetDisplayNode().SetColor(color)
    ```

    start a session, join with the viewer, and turn Slicer's 3D view and the viewer to look from the front (Slicer:
    *Anterior* view).
16. Slow uplink (SLC-26): with relay (c) — its viewer shows the result; relay (a) works too, without a viewer. In a
    second terminal start the throttle proxy, `node slicer-plugin/tests/throttle_proxy.mjs --target 127.0.0.1:8787
    --rate 125000 --listen 8788` (1 Mbit/s towards the relay; end its input like the relay's to see how many bytes it
    passed), and enter `ws://127.0.0.1:8788/ws` as the relay address. In a new scene run in the Python console

    ```python
    import vtk
    def big(n):  # a sphere of 2·n² triangles: n=370 is about 6.5 MB of scene, n=520 about 13 MB
        source = vtk.vtkSphereSource()
        source.SetRadius(40)
        source.SetThetaResolution(n)
        source.SetPhiResolution(n)
        source.Update()
        slicer.modules.models.logic().AddModel(source.GetOutput())
    big(370)
    ```

    click *Start session*, join with the viewer and wait. Then click *Stop session*, clear the scene
    (`slicer.mrmlScene.Clear()`), run `big(520)`, start again, join, and click *Stop session* about 20 s into the upload.
    Repeat once more and quit Slicer (*File → Exit*) about 20 s into the upload instead.

Expected results:

- Step 2: "Cannot start the session." and "relay URL must not carry user info, a query or a fragment (no secrets in
  URLs, §3.1)" — the address is never echoed; nothing is sent; after the restart the address field is **empty** (the
  refused address was not remembered).
- Step 3: "Connecting to …", then within 3 s a 5-character code in large letters (monospace, visibly letter-spaced —
  `[TODO verify]` the PythonQt `QFont` calls) and "Sending the scene · no viewers yet.", then "Live · no viewers yet."
  (the scene loaded, possibly empty, was sent and the relay acknowledged it); *Start* and the address field are
  disabled, *Stop* enabled (US-01, FR-03).
- Step 4: the status stays "Live" (the transport thread pings every 15 s and the relay answers, also with the GUI
  idle — the 50 ms pump yields the GIL; architecture §6).
- Step 5: "Stopping…", then "Not connected."; the code disappears; relay (a) prints `1 N v1:…` with N ≥ 4: one
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
- Step 11: "Sending the scene · no viewers yet.", then within 3 s of the code "Live · no viewers yet." (a large scene
  takes longer: Slicer collects it on the main thread); a model that cannot be shared is counted under the status.
- Step 12: the viewer shows the model within 10 s, in the colours and position of Slicer's 3D view, and nothing of
  *MRHead* (a volume); Slicer shows "Live · 1 viewer." (US-01, FR-05, FR-08).
- Step 13: the viewer shows "presentation ended" within 5 s (US-03, FR-13).
- Step 14: Slicer exits without waiting more than 3 s; the viewer shows "presentation ended" within 5 s — the panel's
  `cleanup()` runs while Slicer quits and sends `session.close` (`docs/research/slicer-scene.md` §2). This assumes the
  scene had finished uploading ("Live"); during an upload on a slow link the stop message can be late (step 16).
- Step 15: both show the same picture — red (R+100) on the patient's right, i.e. the left of the screen when looking
  from the front, blue (S+100) at the top, green (A+100) nearest to the camera. A mirror image or a swapped pair is an
  axis error (protocol §7.1, ADR 0005): report it with a screenshot of both.
- Step 16, `big(370)`: the status stays "Sending the scene · …" for about 50 s (6.5 MB at 1 Mbit/s), then "Live";
  the viewer then shows the sphere; the panel never shows "Relay unreachable" or "Session ended" on the way, the console
  shows no reconnect, and the proxy passed about 6.5 MB. With the old fixed 10 s deadline the first `ping` (at 15 s)
  would have been late and the connection cut about 25 s in ("Relay unreachable"). A relay that closes the connection on its own
  WebSocket ping (SRV-14, report `2026-10-20-slicer-7`) would show as a reconnect here: note it.
- Step 16, stop during `big(520)`: the panel leaves "Sending the scene". The stop message waits behind the bytes already
  written (several MB at 1 Mbit/s), so after 2 s the connection is aborted and the panel says the relay keeps the
  session for up to 2 minutes; the viewer shows the frozen scene as offline until the relay expires it. Quitting Slicer
  behaves the same and Slicer exits within 3 s. Expected, not a defect (`docs/research/slicer-heartbeat.md`).
- Throughout: no traceback in the Python console, no session code or token in the console or the application log.

| Date | Slicer version | OS | Result | Tester |
|---|---|---|---|---|
| | | | | |

## §3 Dependencies on first use (SLC-10; FR-16, FR-02, US-01, NFR-31)

Preconditions: a 3D Slicer 5.12.x profile in which neither package is installed — a fresh installation, or in the
Python console `slicer.util.pip_uninstall("websockets segno")` and a restart. The module path of §1, relay (a) of §2
(any relay works), and the network monitor of §1 step 1 running on `SlicerApp-real`. Check the starting point in the
console: `import importlib.metadata as m; m.version("websockets")` raises `PackageNotFoundError`.

Steps:

1. Open *RemoteView*. Type `wss://user:secret@relay.example.org/ws` and click *Start session*.
2. Type the relay address of the preconditions and click *Start session*. Read the dialog, then click *Cancel*.
3. Click *Start session* again and click *OK*. Wait for Slicer's installation window to close.
4. Click *Stop session*, then *Start session* once more. Restart Slicer, open *RemoteView*, click *Start session*.
5. Replace case: *Stop session* and quit Slicer; start it again and, **before** opening *RemoteView* (nothing has
   imported `websockets` yet), run `slicer.util.pip_install("websockets==16.0")` in the console and restart Slicer; open
   *RemoteView*, click *Start session*, read the dialog, click *OK*. Repeat with `websockets==17.3` (a newer release).
6. Restart case: quit Slicer; start it, run `slicer.util.pip_install("websockets==16.0")` before opening *RemoteView*
   and restart; then run `import websockets; print(websockets.__version__)` in the console (16.0 is now loaded), open
   *RemoteView*, click *Start session*, click *OK*. Then restart Slicer and click *Start session* again.
7. Offline case: uninstall as in the preconditions, restart, disconnect the computer from the network, click *Start
   session*, click *OK*. Repeat with the network *dropping* packets (a firewall rule for `pypi.org` and
   `files.pythonhosted.org`) instead of refusing. Reconnect, follow the README section *Offline installation* on a
   second computer (download the wheels, copy them over, run the `slicer.util.pip_install([...])` line with the real
   path — on Windows one with a space in it too), then click *Start session*.
8. While the dialog of step 2 or Slicer's installation window is open, click the greyed-out *Start session* button and
   try to edit the relay address.

Expected results:

- Step 1: "Cannot start the session." with the URL message of §2 step 2; **no** dialog, no pip, no network traffic.
- Step 2: the dialog "RemoteView — install Python packages" names *websockets 17.2* (the secure connection to the relay)
  and *segno 1.6.6* (the QR code of the join link), says they come from PyPI or the package index configured for pip
  and that the server sees the computer's address and the Python/OS versions, nothing from the scene; *Details* shows
  `websockets==17.2` and `segno==1.6.6`. After *Cancel*: "Cannot start the session." and "Nothing was installed or
  changed. …"; the monitor shows no connection at all (neither PyPI nor the relay) and the console has no traceback.
- Step 3: Slicer's installation window runs and closes, and the panel goes on as in §2 step 3 (code within 3 s). The
  monitor shows pip's connections to PyPI/`files.pythonhosted.org` first and the relay connection only after the
  installation.
- Step 4: no dialog either time (FR-16); the session starts as in §2.
- Step 5: the dialog lists only *websockets 17.2* under "Installed now" as "websockets 16.0 will be replaced by 17.2"
  (second run: "websockets 17.3 will be downgraded to 17.2"); afterwards the session starts without a restart, and
  `m.version("websockets")` is 17.2.
- Step 6: after *OK* Slicer shows **no** restart question of its own (`prompt_restart=False`); the panel says "Cannot
  start the session." and "The Python packages are in place, but this Slicer session already loaded another version of
  websockets. Restart Slicer, then click Start session again."; after the restart the session starts. On Windows the installer may be unable to replace a
  loaded `websockets` extension file: then the panel shows the fixed "could not be installed" text, `websockets`
  stays at 16.0 (no half-installed package) and the restart-and-retry works — note which of the two happened.
- Step 7: Slicer's own error window shows pip's log (and the console and application log hold it too — pip's output is
  Slicer's, it may include a proxy address); the panel says "The Python packages could not be installed. Check the
  network connection and the proxy settings …" and holds no pip text; the application log gains one RemoteView line,
  `deps: installation failed (CalledProcessError)`; the monitor shows no connection to the relay. With dropped packets the
  window keeps spinning until pip's own timeouts and retries end (note the wait). After the offline installation the
  session starts; a path with a space and a Windows backslash path work in the list form.
- Step 8: the button stays greyed out and the address field cannot be edited until the dialog and the window are gone.
- Throughout: no traceback, no session code or token in the console or the application log.

| Date | Slicer version | OS | Result | Tester |
|---|---|---|---|---|
| | | | | |

## §12 Consent text and the scene adapter (SLC-22; R-06, NFR-16, FR-05)

Preconditions: the test Slicer of §2; the *MRHead* sample (*Sample Data*) and two models made in the Python console:

```python
import vtk
for name, center in (("Sphere A", (100, 0, 0)), ("Sphere B", (0, 100, 0))):
    source = vtk.vtkSphereSource()
    source.SetRadius(20)
    source.SetCenter(center)
    source.Update()
    slicer.modules.models.logic().AddModel(source.GetOutput()).SetName(name)
```

Steps:

1. Open *RemoteView*. Read the text above *Start session* with the address field empty, then type
   `wss://relay.example.org/ws`, then `wss://user:secret@relay.example.org/ws`, then `ws://127.0.0.1:8787/ws`.
2. In *Data*, move *Sphere B* into a new folder and hide the folder (eye icon). In *Models*, set *Sphere A*'s opacity to
   0.5. In *Transforms*, create a linear transform *T1* with a translation of 50 mm along R and apply it to *Sphere A*;
   create *T2* with 30 mm along R and apply it to *T1* (a two-level chain).
3. In the Python console run:

   ```python
   import RemoteView
   from remoteview_core.collect import collect_scene
   api = RemoteView.RemoteViewLogic.sceneApi()
   print([node.GetName() for node in api.visible_model_nodes()])
   scene = collect_scene(api)
   print([(e.name, round(e.opacity, 3), None if e.matrix is None else round(e.matrix[0][3], 3))
          for e in scene.entities], scene.skipped)
   ```

4. Show the folder again, close *Sphere A*'s eye in *Data* and run the snippet again.

Expected results:

- Step 1: the text lists what *Start session* sends (the complete surface meshes of the models shown in the 3D view —
  clipping is not applied — no images or volumes, names and MRML node IDs, colours, opacity, visibility, position, the
  Slicer/RemoteView/OS versions) and who can see it. It names "the relay whose address you enter above" for the empty
  field and "the relay at relay.example.org" for both `wss://` addresses (never `user` or `secret`); for
  `ws://127.0.0.1:8787/ws` it names "the relay at 127.0.0.1" and ends with "A ws:// address is not encrypted; Start
  session accepts it only for a relay on this computer (development)." The status stays "Not connected."; nothing is
  sent.
- Step 3: the first line is `['Sphere A']` — no slice planes (*Red/Green/Yellow Volume Slice*), no *Sphere B* (hidden
  folder), nothing from *MRHead* (a volume). The second line is `[('Sphere A', 0.5, 0.08)] ()`: opacity as shown, the
  80 mm of the two transforms as 0.08 m along glTF +X.
- Step 4: the first line is `['Sphere B']`.
- Throughout: no traceback and no error logged by Slicer (in particular none from `GetMatrixTransformToWorld`).

| Date | Slicer version | OS | Result | Tester |
|---|---|---|---|---|
| | | | | |
