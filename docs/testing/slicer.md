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
16. Slow uplink (SLC-26, SLC-40): with relay (c) — its viewer shows the result; relay (a) works too, without a viewer.
    In a second terminal start the throttle proxy, `node slicer-plugin/tests/throttle_proxy.mjs --target 127.0.0.1:8787
    --rate 125000 --listen 8788` (1 Mbit/s towards the relay; end its input like the relay's to see how many bytes it
    passed), and enter `ws://127.0.0.1:8788/ws` as the relay address. In a new scene run in the Python console

    ```python
    import vtk
    def spheres(count=5, n=220):  # each 95,920 triangles; five are about 5.8 MB of (quantised) scene
        for i in range(count):
            source = vtk.vtkSphereSource()
            source.SetRadius(40)
            source.SetCenter(100 * i, 0, 0)
            source.SetThetaResolution(n)
            source.SetPhiResolution(n)
            source.Update()
            slicer.modules.models.logic().AddModel(source.GetOutput())
    spheres()
    ```

    (five spheres stay within the `mobile` budget — 500k triangles, 100k per model — so nothing is decimated), click
    *Start session*, join with the viewer and wait. Then click *Stop session*, start again, join, and click *Stop
    session* about 20 s into the upload. Repeat once more and quit Slicer (*File → Exit*) about 20 s into the upload
    instead.

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
- Step 16, first upload: the status stays "Sending the scene · …" for about 46 s (5.8 MB at 1 Mbit/s; snapshots are
  quantised, `KHR_mesh_quantization` — SLC-12), then "Live"; the viewer then shows the five spheres; the panel never
  shows "Relay unreachable", "Connection lost" or "Session ended" on the way, the console shows no reconnect, and the
  proxy passed about 5.8 MB. With the old fixed 10 s deadline the first `ping` (at 15 s) would have been late and the
  connection cut about 25 s in ("Relay unreachable"). `relay-server` counts the chunks as signs of life while Slicer's
  pong to its WebSocket ping waits behind them (SRV-27; closing run in report `2026-10-20-slicer-7`); a relay deployed
  before SRV-27 may close the connection with 4009 during the upload, which shows as a reconnect here: note it.
- Step 16, stop during the upload: the panel leaves "Sending the scene". The stop message waits behind up to 4 MiB (≈ 34
  s at 1 Mbit/s, SLC-40) and the connection is aborted 2 s after *Stop*: stopped with more than about 2 s of the upload
  still ahead (≈ 240 kB through this proxy; most of the upload), the panel says the stop message could not be sent in
  time and that anyone with the code can still see the last scene until the relay ends the session, after a few minutes
  (SLC-44), and the viewer shows the frozen scene as offline until the relay expires it — through the throttle proxy the
  stop message never arrives then, since the proxy drops what it still holds when Slicer closes the connection. This is
  a known gap, not a new defect (report `2026-10-20-slicer-6`, second part → SLC-50;
  `docs/research/slicer-heartbeat.md`). Stopped in the last ≈ 2 s of the upload, the panel says nothing about the stop
  message and the viewer shows "presentation ended" within 5 s. When quitting, Slicer exits within 3 s; the stop message
  can be lost the same way, with no panel left to say so — the residual for `release`. Whether a stop message handed
  over in time survives the abort on a real slow link (`tc netem`, a phone hotspot) is `[TODO verify]` for SLC-50. After
  *Stop* through the throttle proxy (not when quitting), a panel that says nothing while the viewer keeps the frozen
  scene offline is a defect (T1): note the time of *Stop* and report it (SLC-50).
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

## §4 QR code, Copy link and the Presentation window (SLC-11; FR-04, NFR-29, NFR-30, US-07, T6)

Preconditions: §2's setup, `segno` installed (§3), a stock phone camera app (iPhone Camera, Android camera or Google
Lens), a 24" monitor. **Relay (b)** (a deployed relay, `wss://<relay-host>/ws`) for every step in which a phone scans
the code and opens it: the link is then `https://<relay-host>/j#<CODE>`. With relay (a) or (c) the address is
`ws://127.0.0.1:8787/ws` and the link `http://127.0.0.1:8787/j#<CODE>` — on a phone that is the phone itself, so with
them a scan only checks that the camera reads the link (the banner shows it); opening it cannot join. Joining from the
link also needs the web viewer's deep link (WEB-11) and the relay serving the viewer at `/j` (ADR 0006); until both are
deployed, step 4 checks the banner only.

Steps:

1. Start a session. Look at the panel.
2. Click *Copy link* and paste into a text editor.
3. Click *Presentation window*. Stand 2 m from the monitor and read the code aloud; scan the window's QR code.
4. With the phone camera scan the QR code **in the panel** from about 1 m and open the link it offers.
5. Switch Slicer to a dark theme (*Edit → Application Settings → Appearance*) and scan again.
6. Click *Stop session*. Click *Start session* again and click *Presentation window* again.
7. Paste into the editor again (the clipboard after step 6).
8. Start a third session, open the Presentation window and quit Slicer (*File → Exit*) while it is open.
9. Make the module panel as narrow as Slicer allows and the Presentation window as small as possible; scan both codes.
10. Optional — only with a `wss://` relay reachable under a host name of more than 48 characters (relay (b) behind such a
    DNS name, or a TLS proxy with a certificate for it and that certificate's CA under *Advanced*): start a session and
    open the Presentation window. Without such a relay this case is covered by
    `test_adapter_a_link_too_long_for_a_qr_code_still_offers_the_large_code` (`tests/test_links.py`).

Expected results:

- Step 1: under the code a QR code of at least 240 × 240 px (black on white, with a white margin) and the buttons *Copy
  link* and *Presentation window*, both enabled only now.
- Step 2: `https://<relay host>/j#<CODE>` (`http://127.0.0.1:8787/j#<CODE>` for a local relay), one line, ≤ 64
  characters; the button says "Link copied" for a moment. Nothing else is on the clipboard.
- Step 3: the code in large print (≥ 48 pt; 64 pt expected) is readable from 2 m, the QR code is larger than the
  panel's and scans.
- Step 4: the camera shows the link banner for the relay host (a link, not text or a search); opening it joins the
  session (once the web viewer's deep link exists, WEB-11) within 10 s.
- Step 5: the QR code is still dark modules on a white field and scans (the code is painted by RemoteView, not by the
  theme).
- Step 6: the QR code disappears and both buttons switch off when the session stops; the Presentation window hides and
  holds no code; the second session shows its new code and a QR code of the new link in the same window.
- Step 7: the clipboard still holds the old link (it stays until you copy something else — the *Copy link* tooltip says
  so).
- Step 8: Slicer exits without waiting more than 3 s and the Presentation window is gone.
- Step 9: neither QR code is cropped (the panel or window scrolls or grows instead); both scan, also with a dark theme.
- Step 10: no QR code and *Copy link* off; the panel says "No QR code for this relay address: the join link would be longer
  than 64 characters, or the relay is not at /ws. Read the code to the viewers instead."; the Presentation window opens and
  shows the code with the hint "Open the viewer and type the code."
- Throughout: no traceback in the Python console; no session code, link or QR data in the console or the application log.
- `[TODO verify]` in Slicer 5.12.4 (PythonQt): `qt.QPixmap(w, h)` + `qt.QPainter(pixmap)` + `painter.fillRect(x, y, w, h,
  qt.QColor("black"))`, `qt.QApplication.clipboard().setText(...)`, `QLabel.pixmap = …`, `QLabel.setMinimumSize(w, h)`
  and the `QFont` calls (`setStyleHint`, `setPointSize`, `setLetterSpacing`) as the adapter uses them; the Presentation
  window as a parentless top-level widget from `slicer.util.loadUI` with `show()`, `raise_()` and `hide()`; the panel's
  QR label hidden before the first session (the `.ui` property).

| Date | Slicer version | OS | Result | Tester |
|---|---|---|---|---|
| | | | | |

## §5 Transforms baked into the vertices (SLC-13; FR-06, FR-12 part, US-02, protocol §7.3)

Preconditions: §2's setup with relay (b) or (c) and a viewer joined (with relay (a) the steps run, but nothing shows the
result). In a new scene run in the Python console

```python
import numpy as np, vtk
def model(center, name, stretch=1.0):  # a sphere of radius 20 mm, stretched along R
    source = vtk.vtkSphereSource()
    source.SetRadius(20)
    source.SetThetaResolution(48)
    source.SetPhiResolution(48)
    place = vtk.vtkTransform()
    place.Translate(*center)
    place.Scale(stretch, 1, 1)
    moved = vtk.vtkTransformPolyDataFilter()
    moved.SetTransform(place)
    moved.SetInputConnection(source.GetOutputPort())
    moved.Update()
    node = slicer.modules.models.logic().AddModel(moved.GetOutput())
    node.SetName(name)
    return node
def linear(rows, name):
    node = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLLinearTransformNode", name)
    node.SetMatrixTransformToParent(slicer.util.vtkMatrixFromArray(np.array(rows, dtype=float)))
    return node
src, dst = vtk.vtkPoints(), vtk.vtkPoints()
for x in (240, 270, 300, 330, 360):
    for y in (-30, 30, 90):
        for z in (-30, 30):
            src.InsertNextPoint(x, y, z)
            dst.InsertNextPoint(x, y, z + 15 * (1 - ((x - 300) / 60) ** 2))  # an arch: +15 mm S at R = 300
tps = vtk.vtkThinPlateSplineTransform()
tps.SetBasisToR()
tps.SetSourceLandmarks(src)
tps.SetTargetLandmarks(dst)
bend = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLTransformNode", "Bend")
bend.SetAndObserveTransformToParent(tps)
```

Steps:

1. `model((0, 0, 0), "Shifted").SetAndObserveTransformNodeID(linear([[1, 0, 0, 30], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0,
   0, 1]], "Shift").GetID())`
2. `model((100, 0, 0), "Sheared").SetAndObserveTransformNodeID(linear([[1, 0.3, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0,
   0, 0, 1]], "Shear").GetID())`
3. `model((200, 0, 0), "Mirrored").SetAndObserveTransformNodeID(linear([[-1, -0.3, 0, 400], [0, 1, 0, 0], [0, 0, 1,
   0], [0, 0, 0, 1]], "Mirror").GetID())` (mirrored in R and sheared the other way)
4. `model((300, 0, 0), "Bent", 3).SetAndObserveTransformNodeID(bend.GetID())`; then a linear transform under the bend:
   `anterior = linear([[1, 0, 0, 0], [0, 1, 0, 60], [0, 0, 1, 0], [0, 0, 0, 1]], "Anterior")`,
   `anterior.SetAndObserveTransformNodeID(bend.GetID())`, `model((300, 0, 0), "Bent and moved",
   3).SetAndObserveTransformNodeID(anterior.GetID())`.
5. `model((400, 0, 0), "Flipped").SetAndObserveTransformNodeID(linear([[-1, 0, 0, 800], [0, 1, 0, 0], [0, 0, 1, 0],
   [0, 0, 0, 1]], "Flip").GetID())` — a plain mirror: a TRS matrix with a negative determinant, sent as `T.matrix`, not
   baked. Then note the points of two models: `before = {n: slicer.util.arrayFromModelPoints(slicer.util.getNode(n))
   .copy() for n in ("Bent", "Sheared")}`.
6. Click *Start session*, join with the viewer and turn Slicer's 3D view and the viewer to look from the front (Slicer:
   *Anterior* view), then from above (*Superior*).
7. Stop the session. Run `[np.array_equal(before[n], slicer.util.arrayFromModelPoints(slicer.util.getNode(n))) for n in
   before]` and look in *Data* at the transform tree.

Expected results (simulated through the module's collection with the same scene):

- Step 6, from the front: "Shifted" 30 mm towards R (patient right) of where it was made; "Bent" and "Bent and moved"
  — ellipsoids 120 mm long along R — arch upwards: the top of the middle about 15 mm higher than the sphere's own
  (S ≈ 35 mm), the parts 45 mm from the middle about 8 mm higher (S ≈ 21 mm), as in Slicer's 3D view.
- Step 6, from above: "Sheared" and "Mirrored" are ellipses that lean opposite ways (0.3 mm along R per mm along A, one
  each way); "Bent and moved" lies 60 mm towards A from "Bent".
- Throughout step 6: every model — "Flipped" too, whose mirror the viewer applies itself — is lit from outside, none
  looks dark, inside-out or see-through (front faces stay outside after a mirror); the panel reports no model that could not be shared; the viewer matches Slicer's 3D view.
- Step 7: `[True, True]` — the models' own points are unchanged — and every model is still under its transform in
  *Data* (nothing was hardened).
- Throughout: no traceback in the Python console.
- `[TODO verify]` in Slicer 5.12.4: `vtkMRMLTransformNode.SetAndObserveTransformToParent` with a
  `vtkThinPlateSplineTransform` makes `IsTransformToWorldLinear()` false; `GetTransformToWorld(vtkGeneralTransform)` from
  Python fills the transform (it is the C++ call of the model displayable manager); `InternalTransformDerivative` on
  that `vtkGeneralTransform` is wrapped in Slicer's VTK 9.6.2 as in the `vtk` wheel.

| Date | Slicer version | OS | Result | Tester |
|---|---|---|---|---|
| | | | | |

## §6 Live scene changes (SLC-32, SLC-33, SLC-34; NFR-02, FR-11, FR-12, architecture §6, protocol §6.2, §7.3, §8)

Preconditions: §2's setup. Relay (a) with the update report:
`node slicer-plugin/tests/relay_stub.mjs --port 8787 --report-updates`. When its input ends, it prints
`<closes> <pings> v<n>:<sha256> …` and then `{"violations": [...], "updates": [[type, sceneVersion, baseVersion],
...]}`. Use one stub run per step unless a step says otherwise: start the stub, click *Start session*, do the step,
click *Stop session*, then end the stub's input. Use relay (b) or (c) with a viewer joined for the visual checks.

Every step also expects `violations == []`, closes `1` and no traceback in the Python console. Write down each
session code shown; step 15 searches the logs for them.

Paste §5's helpers (`model`, `linear`, `bend`) once, then these:

```python
import gc, math, threading, time, weakref
w = slicer.modules.RemoteViewWidget          # open the module once first
def spheres(count, prefix="Doe^John sphere"):  # placed by their vertices (§5's model): no transform events
    return [model((50 * i, 0, 0), f"{prefix} {i}") for i in range(count)]
def every(ms, count, step):                  # calls step(i) every ms, count times; prints the elapsed time
    timer, state = qt.QTimer(), {"i": 0, "t0": time.monotonic()}
    def tick():
        step(state["i"]); state["i"] += 1
        if state["i"] >= count:
            timer.stop(); print(f"every: {time.monotonic() - state['t0']:.2f} s")
    timer.connect("timeout()", tick); timer.start(ms)
    return timer                             # keep a reference
def exact_models():
    return len([n for n in slicer.util.getNodesByClass("vtkMRMLModelNode") if n.GetClassName() == "vtkMRMLModelNode"])
```

Steps:

1. **Bindings** (no session; research note §4 and §9, SLC-31 `[TODO verify]`).
   - Run `print(slicer.vtkMRMLScene.NodeAddedEvent, slicer.vtkMRMLScene.NodeRemovedEvent,
     slicer.vtkMRMLScene.StartBatchProcessEvent, slicer.vtkMRMLScene.EndBatchProcessEvent,
     slicer.vtkMRMLScene.EndCloseEvent, slicer.vtkMRMLDisplayableNode.DisplayModifiedEvent,
     slicer.vtkMRMLModelNode.MeshModifiedEvent, slicer.vtkMRMLTransformableNode.TransformModifiedEvent,
     slicer.mrmlScene.IsBatchProcessing())`.
     Expected: `8193 8195 8449 8705 8707 17000 17001 15000 False` (or `0` for the last value).
   - Run `t = qt.QTimer(); t.setSingleShot(True); f = lambda: print("fired"); t.connect("timeout()", f); t.start(100)`.
     Expected: "fired" is printed once, and `t.isSingleShot()` is `True`.
   - Run `t.disconnect("timeout()", f)`. Expected: it returns `True`.
   - Run the same disconnect a second time. Expected: nothing is raised. Record what it returns.
2. **Wiring and one change** (NFR-02).
   1. `a, = spheres(1)`
   2. Click *Start*.
   3. Run `w.flushTimer.isSingleShot(), w.controller.observer_count == 5 + 4 * exact_models()`. Expected: `(True,
      True)`. The count includes one hidden model per slice view.
   4. Run `wr = weakref.ref(w.controller._watcher)` as one statement.
   5. Change the colour in *Models*.
   6. Click *Stop*.
   7. Run `gc.collect(); w.controller.observer_count, wr() is None`. Expected: `(0, True)`.
   8. Change the colour again.

   Expected:
   - The status reads "Sending the scene", then "Live".
   - The viewer shows the first colour change within 0.5 s.
   - Nothing more is sent after Stop.
   - The stub shows `v1:` only, and updates `[["scene.update",2,1]]`.
3. **Idle and slice scrolling.**
   1. *Sample Data → MRHead*, then `spheres(2)`, with the Red slice shown in 3D.
   2. Click *Start*. Wait for "Live".
   3. Scroll the Red slice for about 10 s.
   4. Leave Slicer idle for 10 s.

   Expected: `v1:` only, and updates `[]` (slice planes cause no loop of marks; research note §5).
4. **One folder eye toggle** (FR-11).
   1. `nodes = spheres(5)`, then move them into one folder in *Data*.
   2. Click *Start*. Wait for "Live".
   3. Click the folder's eye, wait 1 s, then click it again. Console variant, each as one line:
      `for n in nodes: n.GetDisplayNode().SetVisibility(0)`, then the same with `(1)`.

   Expected:
   - Updates exactly `[["scene.update",2,1],["scene.update",3,2]]`, and `v1:` only.
   - The viewer hides all five at once, then shows them all at once.
5. **Opacity drag** (two stub runs). Setup: `a, = spheres(1); d = a.GetDisplayNode()`.
   - Run 1:
     1. Click *Start*. Wait for "Live".
     2. Drag *Opacity* by hand for about 5 s, and time it (`T`).

     Expected: `v1:` only; at most `4·T + 2` `scene.update`; the viewer follows within 0.5 s.
   - Run 2:
     1. Click *Start*. Wait for "Live".
     2. Run `keep = every(50, 100, lambda i: d.SetOpacity(0.2 + 0.8 * abs(math.sin(i / 10))))`.
     3. Wait until it prints `every: T s`.

     Expected: `v1:` only; between `4·T − 1` and `4·T + 2` `scene.update` (`APPEARANCE_MAX_MS` 250).
6. **Smoothing** (FR-12).
   1. `a, = spheres(1)`.
   2. Click *Start*. Wait for "Live".
   3. In *Surface Toolbox*, set input = output = `a`, choose Smoothing and click Apply.

   Expected:
   - One new `v2:`, and no `scene.update` for it.
   - The status reads "Updating the scene", then "Live".
   - The new shape is on the viewer about 1 s after Apply.
7. **Transforms.**
   1. `m = model((0, 0, 0), "Doe^John moved"); t = linear(np.eye(4).tolist(), "Move");
      m.SetAndObserveTransformNodeID(t.GetID())`.
   2. Click *Start*. Wait for "Live".
   3. Drag "Move"'s LR slider in *Transforms* for about 3 s.
   4. Run `t.SetAndObserveTransformNodeID(bend.GetID())`.
   5. Drag the slider again.

   Expected:
   - During the first drag: updates only, and the sphere follows.
   - After the bend: snapshots at most about every 2 s while dragging, and one about 750 ms after the last change. A
     baked node takes the slow lane (FR-12).
8. **Add, delete, rename.**
   1. `spheres(2)`.
   2. Click *Start*. Wait for "Live".
   3. `b = model((0, 80, 0), "Doe^John added")`, then wait 2 s.
   4. `slicer.mrmlScene.RemoveNode(b)`, then wait 2 s.
   5. Rename sphere 0 in *Data*.

   Expected:
   - Updates `[["scene.nodeAdded",2,1],["scene.nodeRemoved",4,3]]`.
   - Snapshots `v1: v3: v5:`.
   - The viewer's list shows the new name.
9. **Close and load** (§7.3). Beforehand, save step 4's scene as `five.mrb`.
   1. Load `five.mrb`.
   2. Click *Start*. Wait for "Live".
   3. *File → Close Scene*, then wait 2 s.
   4. Load `five.mrb` (*File → Add Data* or *Load Scene*; same result), then wait for "Live".

   Expected:
   - The viewer is empty within 1 s of the close.
   - No `scene.nodeRemoved` for the closed models.
   - The load gives one `scene.nodeAdded` and exactly one more snapshot: `v1: v2: v4:`, updates
     `[["scene.nodeAdded",3,2]]`.
10. **HideFromEditors** (SLC-31 `[TODO verify]`).
    1. `a, b = spheres(2)`.
    2. Click *Start*. Wait for "Live".
    3. `a.SetHideFromEditors(1)`, then wait 2 s.
    4. `a.SetHideFromEditors(0)`.

    Expected:
    - Updates `[["scene.nodeRemoved",2,1],["scene.nodeAdded",3,2]]`, and snapshots `v1: v4:`.
    - The sphere leaves the viewer, then comes back.
    - If nothing happens at `(1)`, the flip fires no `ModifiedEvent`: report it.
11. **Start during a batch** (SLC-31 review, SLC-33).
    1. `spheres(3); slicer.mrmlScene.StartState(slicer.vtkMRMLScene.BatchProcessState)`.
    2. Click *Start*. Wait for the code, then 5 s more.
    3. `slicer.mrmlScene.EndState(slicer.vtkMRMLScene.BatchProcessState)`.

    Expected:
    - Until `EndState`, the status reads "Sending the scene · no viewers yet." with the detail "Slicer is still loading
      or changing the scene: RemoteView sends it when Slicer is done.", and the stub has no snapshot.
    - Within 0.1 s after `EndState`, one snapshot with all three spheres; updates `[]`.
    - Variant: click Start during a large `.mrb` load, if the panel accepts the click while the progress dialog is open
      `[TODO verify]`. Expected: one snapshot after the load.
12. **Events off the main thread** (SLC-33; research note §5 `[TODO verify]`). Do not run MRML calls on a thread:
    Slicer's own observers (displayable managers, subject hierarchy, Qt scene models) are not thread-safe. A missed
    start or end of a batch is covered by SLC-33's unit tests.
    - Probe on a private object. Run `o = vtk.vtkObject(); seen = []; o.AddObserver(vtk.vtkCommand.ModifiedEvent,
      lambda c, e: seen.append(threading.get_ident())); th = threading.Thread(target=o.Modified); th.start();
      th.join(); print(bool(seen) and seen[0] != threading.get_ident())`. Expected: `True` — a Python observer runs on
      the invoking thread, which is why the watcher's guard exists. Record the result.
    - The guard:
      1. `a, = spheres(1)`.
      2. Click *Start*. Wait for "Live".
      3. `watcher = w.controller._watcher; th = threading.Thread(target=watcher._on_display, args=(a, "NoEvent"));
         th.start(); th.join()`.

      Expected: within 0.1 s, one new snapshot at the stub (a re-sync) with no `scene.update` for it, and no traceback.
      A colour change afterwards gives one `scene.update`.
13. **SlicerVirtualReality** (N/A without it; research note §2 row 17 `[TODO verify]`).
    1. Click *Start*. Wait for "Live".
    2. Enable VR.
    3. Run `slicer.mrmlScene.GetFirstNodeByClass("vtkMRMLVirtualRealityViewNode").IsA("vtkMRMLViewNode")`. Expected:
       `True`.
    4. Turn VR off and on again. Expected: each turn sends at most one `scene.update`, with no error.
14. **Reload and quit.** Research note §9; Slicer 5.12.4 `util.py:1626` calls `cleanup()`.
    1. Click *Start*. Wait for "Live".
    2. `wr = weakref.ref(w.controller._watcher); old = w` (as statements).
    3. *Developer mode → Reload*.
    4. Change a colour.
    5. `gc.collect(); wr() is None, old.flushTimer.isActive()`. Expected: `(True, False)`, and no traceback (the
       `disconnect` calls work).
    6. End the stub's input. Expected: closes `1`, and no update after the reload.
    7. `w = slicer.modules.RemoteViewWidget`, then click *Start* in the reloaded panel. Expected: it works.
    8. *File → Exit* while live. Expected: Slicer exits within 3 s.
15. **Logs** (T7, rule 6). Search the application log file (*Help → Report a bug* lists the log files
    `[TODO verify]`) and the Error Log window, not the console window (it echoes the commands typed). Search for
    `Doe`, `Traceback`, `vtkMRMLModelNode` and every session code written down during §6. Expected:
    - None of them is on a line from `remoteview_core` or `RemoteView.py` (Slicer's Python log lines name the source
      file `[TODO verify]`). Hits on lines Slicer itself wrote, or on console output of the commands typed here
      (Slicer may mirror the console into its log `[TODO verify]`), are allowed.
    - No publisher token anywhere (a 43+ character `[A-Za-z0-9_-]` string on a RemoteView line).

Known gaps (not failures):
- An error answering an update with a busy code shows "Updating the scene" during the relay's wait (SLC-18).
- A Close Scene missed off the main thread is not handled as a reset: if the new scene is too large, the closed one
  stays on the viewers, and a snapshot of the closed scene already in flight is not superseded.
- Events off the main thread that keep coming re-send the whole scene about every 60 s (SLC-33).

| Date | Slicer version | OS | Result | Tester |
|---|---|---|---|---|
| | | | | |

## §7 Resume and reconnect (SLC-44 to SLC-47; FR-14, US-05, NFR-11, NFR-20, protocol §4.3, §4.4, §6.3, §8.4, §9.1, §9.3; T1, T4)

Preconditions: §2's setup, with its relays (a), (b) and (c); §6's helpers and two of its synthetic models shown in 3D
(`spheres(2)`; never patient data in §7); a large scene for
steps 3 and 4: §2 step 16's snippet run in a new scene with its function renamed `big_spheres` (so that it does not
replace §6's `spheres`) — five spheres, about 5.8 MB. Write down every session code shown; step 12 searches the logs
for them.
- (a) the stub with the resume report —
  `node slicer-plugin/tests/relay_stub.mjs --port 8787 --grace-ms 120000 --report-sessions --report-updates` — whose
  commands are typed into its input (`restart`, `close-publisher 1001`, `pongs off-until-handshake`, `status`; each
  answers `ok…`); when its input ends it prints its summary, the update report and, last,
  `{"sessions": [{"first": …, "preferredCode": …, "lastSceneVersion": …, "frames": [...]}, …], "violations": [...]}`
  (one entry per handshake; no code, token or name in it). It listens on 127.0.0.1 without TLS: no phone or viewer can
  join it, so its steps check the panel and the report only, and every one of them expects `violations == []`. Never
  expose it beyond the loopback interface.
- (b) the deployed relay with its viewer page and a phone joined with the code: the only relay that turning Wi-Fi off
  or a sleep separates from this computer, and the one for the visual checks.
- (c) `relay-server` and `web-viewer` on this machine, the viewer page at `http://localhost:5173`: Wi-Fi and sleep do
  not separate it from Slicer, so it serves the restart and the idle renewal steps only. It listens unencrypted on
  every interface (§2): sample data only, or a host firewall.

Relays (b) and (c) must run a `relay-server` that answers `session.resume` (SRV-15: the socket stays open 10 s after
`SESSION_NOT_FOUND` for the fallback create) and closes with 4008 on SIGTERM (SRV-17). Both are done on `main`. A relay
deployed before SRV-15 answers a resume with `UNSUPPORTED_TYPE` and closes the socket with 4012 10 s after it opened (no
session is bound to it). The panel then resumes again on every new connection ("Reconnecting to the session…",
"Connection lost — reconnecting in N s.") until its reconnect window ends, about 3 minutes after the loss at the default
120 s grace. It then shows "Session ended." with "The connection to the relay was lost for too long, …" and "Anyone with
the code can still see the last scene …" (relay (b) keeps the session until its grace ends). Against such a relay,
record the steps marked *[SRV-15]* as blocked, not failed. Every step expects no traceback in the Python console.

Steps:

1. **Wi-Fi off for 40 s** (FR-14; relay (b)). Click *Start*, wait for "Live", turn Wi-Fi off.
   Expected: within 25 s the status reads "Connection lost — reconnecting in N s.", the same code, QR code and
   Presentation window stay, *Stop* stays enabled; the viewer may show the presenter as offline (the relay notices the
   loss within 30–60 s, §9.1). Turn Wi-Fi on (*[SRV-15]* from here). Expected: within 40 s (the retry delay grows to
   30 s) "Live · 1 viewer.", the same code, no "Sending the scene" (nothing is uploaded again); a colour change then
   reaches the phone.
2. **Edits while offline** (relay (b); *[SRV-15]*). As step 1, but change a colour and hide a model while Wi-Fi is off.
   Expected: both reach the phone within 2 s of "Live"; no snapshot is sent again (the panel never shows
   "Updating the scene").
3. **Cut while "Sending the scene"** (relay (a) behind §2 step 16's throttle proxy, so that the upload of the large
   scene lasts at least 10 s). Load the large scene, click *Start*; while "Sending the scene" shows, type
   `close-publisher 1001`. Expected: "Connection lost — reconnecting…" with "Sending the scene was interrupted:
   RemoteView sends it again once reconnected."; after the reconnect "Sending the scene", then "Live". The report's
   resume entry starts with `["scene.snapshot.begin", v]` for a version above the cut one. Repeat once with relay (b)
   (*[SRV-15]*), turning Wi-Fi off during the upload: after the reconnect the phone shows the whole scene.
4. **Close the scene while it is sent, then cut** (relay (a) behind the throttle proxy of step 3). With the large
   scene loaded click *Start* and wait for "Live"; then run `slicer.mrmlScene.Clear(0); big_spheres()` in the Python
   console, in one line — `Clear(0)` is what *File → Close Scene* does (`qSlicerMainWindow`), and the new spheres are
   added before the closed scene's snapshot is made, so that snapshot takes long to upload — and, while "Updating the
   scene" shows, type `close-publisher 1001`. Expected: while reconnecting the panel says "Sending the scene was
   interrupted: …" and "The scene was closed in Slicer, but anyone with the code still sees it until RemoteView
   reconnects, …"; after the reconnect the first frame of the resume entry is `scene.snapshot.begin`. Repeat once with
   relay (b) (*[SRV-15]*), turning Wi-Fi off while "Updating the scene" shows: after the reconnect the phone shows the
   new spheres and never the closed models again.
5. **Relay restart.** From here on relay (a) is reached at its own address (`ws://127.0.0.1:8787/ws`, no throttle
   proxy); first run `slicer.mrmlScene.Clear(0); spheres(2)` for the two models of the preconditions. (a) Wait for
   "Live", type `restart`. Expected: within 5 s "Live" again with the same code; while reconnecting the panel says "The
   relay restarted: RemoteView starts the session again, …"; "Sending the scene", then "Live" (the scene is uploaded
   again: a restarted relay keeps none). Report: `create none`, `resume`, `create previous`. (c) (*[SRV-15]*, SRV-17)
   Stop the local relay-server (SIGTERM) and start it again within 3 s. Expected: the same code; the viewer page rejoins
   by itself. The relay closes Slicer's socket with 4008 and answers a reconnect during its drain with HTTP `503
   {"error":"RELAY_RESTARTING"}` (report `2026-10-27-server-5`). If the relay's 4008 close frame has not reached Slicer
   when the drain ends (about 5 s; rare for a publisher, whose send buffer on the relay holds only short replies),
   Slicer sees 1006 instead. A resume after that is answered `SESSION_NOT_FOUND`, and without a 4008 the panel ends the
   session ("The relay ended the session while RemoteView was offline. …"): the known gap below, not a failure. A
   reconnect that meets the drain may also show "The relay answered HTTP 503 instead of opening the connection. Check
   the relay address." under the restart text until SLC-49.
6. **Restart without the old code** (relay (a) started with `--ignore-preferred-code` added). Type `restart`. Expected:
   a new code in the panel, the QR code and the Presentation window, with "The relay restarted and could not keep the
   old code: give the viewers the new code. …" until the session ends. Type `close-publisher 1001`: the note stays while
   reconnecting (under a second against the stub: watch the detail line).
7. **Lost longer than the window.** (a) Stop the stub (Ctrl-C) and leave it stopped for 190 s. Expected: the panel
   keeps "Connection lost — reconnecting…" (every attempt fails); 180 s after the loss "Session ended." with "The
   connection to the relay was lost for too long, so RemoteView stopped the session. …". Start the stub again on the
   same port: nothing reaches it (its report has no entry). (b) Wi-Fi off for 4 minutes with relay (b): the same
   ending; the relay's `/healthz` shows 0 sessions after Wi-Fi returns. (c) Relay (a) started with `--grace-ms 50`:
   type `close-publisher 1001`. Expected: "Session ended." with "The relay ended the session while RemoteView was
   offline. …"; the report has `create none` and `resume`, and no second create (a relay that ended the session is
   not asked for its code again: it may belong to another session).
8. **Stop while offline** (relay (b)). Wi-Fi off, wait for "Connection lost", click *Stop*. Expected: at once "Session
   ended." with "RemoteView was not connected to the relay when you stopped. Anyone with the code can still see the last
   scene until the relay ends the session, after a few minutes."; 3 s later, and again after Wi-Fi returns, no
   `RemoteView-transport` thread (`[t.name for t in threading.enumerate()]`): nothing can connect. With relay (a): type
   `close-publisher 1001` and click *Stop* right after the reconnect ("Live" again); the closes count is `1`.
9. **Laptop sleep** (relay (b)), while "Live" with no edits in progress. Sleep for 1 minute (*[SRV-15]*): after waking
   the session resumes with the same code. Sleep for 10 minutes: within about 25 s of waking (when the next ping finds
   the connection gone) "Session ended." with the "lost for too long" text and nothing more (no "Anyone with the code
   …": no resume went out), and **no frame goes out** after the wake (the reconnect window starts at the connection's
   last sign of life before the sleep, SLC-41; with the relay at `LOG_LEVEL=debug`, no `websocket closed` line with
   `role: "publisher"` after the wake — a resume or a create sets that role).
10. **Reload or exit while reconnecting** (relay (b) with Wi-Fi off, or relay (a) stopped with Ctrl-C). Wait for
    "Connection lost", then *Developer → Reload*. Bring the relay back, click *Start*, wait for "Live", cut it again
    the same way and, while reconnecting, *File → Exit*. Expected: no traceback; no `RemoteView-transport` thread 3 s
    after the reload (`[t.name for t in threading.enumerate()]`); *Start* works after the reload; Slicer exits within
    3 s.
11. **Idle renewal** (SLC-47; relay (c) started with `SESSION_TTL_S=90 LOG_LEVEL=debug` added, so it warns with
    `session.expiring` 30–40 s after the session's idle period starts (its sweep runs every 10 s) — at creation, when
    the last viewer leaves, at a renewal; the viewer page not joined until (iii)). (i) Click *Start*. Expected: 30–40 s
    after "Live" nothing changes in the panel: it renewed the session by itself (relay log: `session renewed`), because
    *Start* was clicked within 5 minutes. (ii) Do not touch the panel. Expected: 30–40 s later "No viewer is connected,
    so the relay ends the session in about a minute. Click Keep session to keep it running." with a *Keep session*
    button (the automatic renewal is used once per Start). Change a model's colour: the text and the button stay. Click
    *Keep session*. Expected: both go, the relay logs `session renewed`, the code stays. (iii) When the text is back,
    join with the viewer page. Expected: the text and the button go at once. Close the viewer's tab. Expected: 30–40 s
    later the text again. Leave it. Expected: about 60 s later "Session ended." with "The session expired because nobody
    joined for a while."
12. **Logs** (T7). As §6 step 15, after steps 1-11: no session code written down here, no publisher token (`pt_…`), no
    `sess_` session ID and no `Doe` on any RemoteView line.

Known gaps (not failures):
- A relay that crashes without close 4008, or whose 4008 frame did not reach Slicer before its drain ended (step 5
  (c)), and comes back without the session ends it (`SESSION_NOT_FOUND`, no re-create; report `2026-10-28-slicer-2.md`
  item 4).
- A fallback create refused by the relay (`CAPACITY`, `RATE_LIMITED`) ends the session; there is no retry loop.
- On Windows a sleep of roughly 3 to 6.5 minutes (default grace) still resumes at the wake and ends with "The relay
  ended the session while RemoteView was offline."; a frame that reached Slicer before the sleep but is read only
  after the wake dates the loss at the wake (SLC-41, `docs/research/slicer-sleep-clocks.md`).

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

## §13 Segments (SLC-27, SLC-35, SLC-36, SLC-37; US-02, FR-06, FR-64, ADR 0005 §6, protocol v1.1 §7.3, T7)

Preconditions: §2's setup. Relay (a) with the update report (`node slicer-plugin/tests/relay_stub.mjs --port 8787
--report-updates`, one stub run per step as in §6: start the stub, click *Start session*, do the step, click *Stop
session*, end the stub's input; every step expects `violations == []`, closes `1` and no traceback in the Python
console) and, for the visual checks, relay (b) or (c) with a viewer joined. Write down every session code shown; step 13
searches the logs for them. Paste §5's helpers (`model`, `linear`, `bend`) and §6's (`every`) once, then these:

```python
import gc, json, struct, threading, time, weakref
import RemoteView
from remoteview_core.collect import collect_scene
from remoteview_core.glb_writer import RootExtras, write_glb
from remoteview_core.ids import SceneIds
w = slicer.modules.RemoteViewWidget            # open the module once first
api = RemoteView.RemoteViewLogic.sceneApi()
ids = SceneIds()                               # one registry for every export() below, like a session's
def export(anonymize=False):                   # what one snapshot would hold (nothing is sent)
    scene = collect_scene(api, anonymize_names=anonymize, ids=ids)
    for e in scene.entities:
        print(e.kind, e.node_id, e.segment_id, repr(e.name), [round(c, 3) for c in e.color],
              round(e.opacity, 3), e.baked)
    print("skipped:", [(s.index, s.reason.value) for s in scene.skipped])
    return scene
def glb_text(scene):                           # the JSON chunk of the GLB such a snapshot would carry, and its size
    glb = write_glb(scene.entities, RootExtras(scene_version=1, profile="mobile",
                    slicer_version=slicer.app.applicationVersion, anonymized_names=scene.anonymized_names),
                    quantize=True)
    print(f"{len(glb)} bytes")
    return glb[20:20 + struct.unpack_from("<I", glb, 12)[0]].decode("utf-8")
def exact(cls):
    return len([n for n in slicer.util.getNodesByClass(cls) if n.GetClassName() == cls])
def expected_observers():                      # 5 scene + 4 per model + 8 per segmentation (slice-view models too)
    return 5 + 4 * exact("vtkMRMLModelNode") + 8 * exact("vtkMRMLSegmentationNode")
```

Scene for the steps (unless a step says otherwise): *Sample Data → MRHead*; in *Segment Editor* add a segmentation
named `Doe^John seg` with two segments, `Doe^John brain` and `Doe^John skull`, each painted with a few brush strokes
(*Paint*, sphere brush; any shape); click **Show 3D** (on). Then `seg = slicer.util.getNode("Doe^John seg");
d = seg.GetDisplayNode(); sids = seg.GetSegmentation().GetSegmentIDs()`. The medical-data rule (CLAUDE.md rule 6) is
about the module's output: the console lines printed here are the tester's own and show IDs and names on purpose.

Steps:

1. **Bindings** (no session; SLC-36/SLC-37 `[TODO verify]`). Record every value.
   1. `print(slicer.vtkSegmentation.SegmentAdded, slicer.vtkSegmentation.SegmentRemoved,
      slicer.vtkSegmentation.SegmentModified, slicer.vtkSegmentation.RepresentationModified,
      slicer.vtkSegmentation.ContainedRepresentationNamesModified, slicer.vtkSegmentation.SourceRepresentationModified,
      slicer.vtkSegmentation.SegmentsOrderModified)`. Expected: `62102 62103 62104 62101 62105 62100 62106`
      (`Libs/vtkSegmentationCore/vtkSegmentation.h`, an enum from 62100 in declaration order). Different numbers are
      fine as long as every attribute exists — the adapter reads the attributes; a missing one makes *Start* fail with
      an `AttributeError` by design.
   2. `print(type(sids), [type(s) for s in sids], sids)`. Expected: a `tuple` of `str`, two IDs like `Segment_1`.
   3. `c = d.GetSegmentColor(sids[0]); print(type(c).__name__, len(c), tuple(c))`. Expected: `vtkVector3d 3 (r, g, b)`
      in 0–1 (the one-argument overload the adapter uses).
   4. `print(repr(d.GetDisplayRepresentationName3D()))`, then click *Show 3D* off, run it again, click it on again.
      Expected: `'Closed surface'`, `''`, `'Closed surface'`.
   5. `print(slicer.vtkMRMLFolderDisplayNode.GetOverridingHierarchyDisplayNode(seg),
      slicer.vtkMRMLFolderDisplayNode.GetHierarchyVisibility(seg), slicer.vtkMRMLFolderDisplayNode.GetHierarchyOpacity(seg))`.
      Expected: `None True 1.0` (callable from Python for a segmentation node; `None` while it is in no folder).
   6. Call data of a typed handler on the segmentation **node** (the watcher's `calldata_type(VTK_STRING)`): run as one
      block

      ```python
      from vtkmodules.util.misc import calldata_type
      from vtkmodules.vtkCommonCore import VTK_STRING
      seen = []
      @calldata_type(VTK_STRING)
      def probe(caller, event, calldata=None):
          seen.append((event, type(calldata).__name__, calldata))
      tag = seg.AddObserver(slicer.vtkSegmentation.SegmentModified, probe)
      seg.GetSegmentation().GetSegment(sids[0]).SetName(seg.GetSegmentation().GetSegment(sids[0]).GetName())
      seg.GetSegmentation().GetSegment(sids[0]).Modified()           # immediate path
      wasModifying = seg.StartModify(); seg.GetSegmentation().GetSegment(sids[1]).Modified(); seg.EndModify(wasModifying)
      seg.RemoveObserver(tag); print(seen)
      ```

      Expected: at least one entry `('NoEvent', 'str', '<the ID of sids[0]>')` from the immediate path, and for the
      deferred one an entry whose call data is `None` (`'NoneType'`) — or a `str` if Slicer forwards the ID; record
      which. Nothing is raised either way.
2. **Wiring and the first snapshot** (US-02, FR-06). Relay (b)/(c) with a viewer, and the stub for the counts.
   1. Click *Start*. Wait for "Live".
   2. Run `w.controller.observer_count == expected_observers(), w.controller.observer_count`.
   3. Run `export()`.
   4. Click *Stop*.

   Expected:
   - The viewer shows both segments where MRHead's head is, in Slicer's segment colours and fully opaque, and lists
     them under their names `Doe^John brain`/`Doe^John skull` (the panel: "Live").
   - Step 2 prints `(True, n)`: 8 observers per segmentation node.
   - Step 3 prints two `segment` lines with nodeIds `vtkMRMLSegmentationNode<k>/<segment ID>`, `segment_id` = the
     ID, the two names, the segment colours as in *Segment Editor*, opacity `1.0`, `False` (not baked), then
     `skipped: []`; the stub shows `v1:` only and updates `[]`.
3. **Show 3D off and on** (`ContainedRepresentationNamesModified` → geometry; a segment no longer shown is removed).
   1. Click *Start*. Wait for "Live".
   2. Click *Show 3D* (off), wait 2 s.
   3. Click *Show 3D* (on), wait 2 s.

   Expected: updates `[["scene.nodeRemoved",2,1],["scene.nodeAdded",3,2]]`, snapshots `v1: v4:`; the viewer empties
   within about 1 s of the click, then shows both segments again (a segment shown again is a new node — the cost of
   leaving hidden segments out, report `2026-10-28-slicer-1`).
4. **A segment's eye** (FR-11, cheap updates for a held segment).
   1. Click *Start*. Wait for "Live".
   2. In *Segment Editor*'s table close the eye of `Doe^John skull`, wait 1 s, open it again.

   Expected: updates `[["scene.update",2,1],["scene.update",3,2]]`, `v1:` only; the viewer hides and shows the skull
   within 0.5 s each (hidden **after** the export: `visible: false`, no snapshot).
5. **Hidden at export time, and `Opacity3D` 0** (the privacy default and its cost, report `2026-10-28-slicer-1`).
   1. Close the eye of `Doe^John skull`. Click *Start*. Wait for "Live".
   2. Open the eye, wait 2 s.
   3. In *Segmentations → Display*, set *Opacity 3D* of the segmentation to 0, wait 2 s; set it back to 1, wait 2 s.
   4. Add a model next to it: `m = model((0, 0, 0), "Doe^John sphere")`, wait 2 s, then
      `m.GetDisplayNode().SetOpacity(0)`, wait 2 s.

   Expected (one stub run for the whole step: the versions below add up to updates `[["scene.nodeAdded",2,1],
   ["scene.update",4,3],["scene.update",5,4],["scene.nodeAdded",6,5],["scene.update",8,7]]` and snapshots
   `v1: v3: v7:`):
   - Step 1: `v1:` with one segment (the brain); the viewer shows no skull. Step 2: `["scene.nodeAdded",2,1]` and a
     snapshot `v3:` with both — a segment hidden at export time is a new node later (a full snapshot), not a
     `visible: true`.
   - Step 3: the segmentation at `Opacity3D` 0 is "not shown" (`vtkMRMLSegmentationsDisplayableManager3D::vtkInternal::
     IsVisible`), but the viewers hold both segments and the mark is appearance only (`DisplayModifiedEvent`), so this
     is step 4's lane, not a removal: `["scene.update",4,3]` with `visible: false` for both segments, then
     `["scene.update",5,4]` with `visible: true` for both; no `scene.nodeRemoved`, no snapshot; the viewer hides and
     shows both segments within 0.5 s each. Models and segmentations differ at opacity 0 **at export time only**: a
     segmentation at `Opacity3D` 0 is left out of a snapshot (hidden-at-export, the cost of step 2), a model at
     opacity 0 is exported.
   - Step 4: the model arrives with `["scene.nodeAdded",6,5]` + a snapshot `v7:`; at opacity 0 it stays on the viewers
     (`["scene.update",8,7]` with `opacity: 0`) — as Slicer's displayable managers do, a model at opacity 0 is drawn
     (invisibly) and a segmentation is not (`release` decides both, `2026-10-20-slicer-5` and `2026-10-28-slicer-1`).
6. **Four-factor opacity and the folder override on screen** (ADR 0005 Decision 6, `[TODO verify]`; relay (b)/(c)).
   Compare the viewer, Slicer's 3D view and `export()` after each sub-step; record the printed opacity and colour.
   1. (a) In *Segment Editor* set the opacity of `Doe^John brain` to 0.5 (*Segmentations → Display → Advanced* per
      segment, *Opacity 3D*) and the segmentation's *Opacity 3D* to 0.8. Run `export()`.

      Expected: the brain's opacity prints `0.4` (0.5 × 0.8 × 1.0 × 1.0), the skull's `0.8`; the viewer and Slicer's
      3D view look alike (both translucent, the brain more so).
   2. (b) In *Data*, create a folder, move `Doe^John seg` into it, right-click the folder → *Edit properties* (or the
      folder's display node in Python: `f = slicer.vtkMRMLFolderDisplayNode.GetOverridingHierarchyDisplayNode(seg)`
      after *Apply color to all children* is enabled) and set the folder's **opacity** to 0.5. Run `export()` and
      `print(f.GetOpacity(), slicer.vtkMRMLFolderDisplayNode.GetHierarchyOpacity(seg), d.GetFolderDisplayOverrideAllowed())`.

      Expected: the adapter copies the displayable manager's arithmetic — hierarchy opacity × segment × `Opacity3D` ×
      the generic (folder) display node's opacity — so the brain prints `0.1` (0.5 × 0.5 × 0.8 × 0.5): the folder's
      opacity enters **twice**. Look at Slicer's 3D view: if the brain looks like 0.1 (nearly invisible) the double
      count is what Slicer draws and the export matches; if it looks like 0.2, Slicer counts it once — record it either
      way and report it (`2026-10-28-slicer-1` names it). The viewer shows what `export()` printed.
   3. (c) Enable *Apply color to all children* on the folder with a distinct colour (e.g. yellow), then run
      `d.SetFolderDisplayOverrideAllowed(0); export()`.

      Expected: the opacity factors of the folder are gone (the brain prints `0.4` again) but the **colour** printed is
      the folder's yellow — the colour branch of `UpdateDisplayNodePipeline` is not gated by
      `GetFolderDisplayOverrideAllowed`. Look at Slicer's 3D view: if both segments are yellow the export matches; if
      they keep their own colours, record it and report it (the adapter would then need the gate for segments too).
      Afterwards `d.SetFolderDisplayOverrideAllowed(1)`, move the segmentation out of the folder, set both opacities
      back to 1.
7. **A colour change** (NFR-02; the stub).
   1. Click *Start*. Wait for "Live".
   2. In *Segment Editor*, double-click the colour of `Doe^John brain` and choose another colour; wait 1 s.
   3. Run `every(50, 40, lambda i: d.SetSegmentOpacity3D(sids[1], 0.2 + 0.8 * abs((i % 20) / 20 - 0.5)))`; wait for
      `every: T s`.

   Expected: step 2 gives `[["scene.update",2,1]]` and `v1:` only — a `SegmentModified(id)` is an appearance change,
   never a snapshot; the viewer shows the new colour within 0.5 s. Step 3 adds between `4·T − 1` and `4·T + 2`
   `scene.update` (the fast lane, `APPEARANCE_MAX_MS` 250) and still no snapshot.
8. **Hide node names: aliases, never a raw ID** (protocol v1.1 §7.3, reports `2026-10-18-slicer-3`,
   `2026-10-19-slicer-3`, T7). *Hide node names* has no panel toggle yet (SLC-18); the live controller's switch is used.
   1. Run, as one line each: `s = seg.GetSegmentation(); s.AddEmptySegment("left lung", "Doe^John lung");
      s.AddEmptySegment("Läsion", "Doe^John lesion"); s.AddEmptySegment("Tumor(1)", "Doe^John tumour");
      s.AddEmptySegment("x" * 110, "Doe^John long"); s.AddEmptySegment("s_1", "Doe^John s1")`, then paint one or two
      strokes into each of the five new segments (an empty segment has no surface, step 12).
   2. Run `shown = export(); text = glb_text(shown)`.
   3. Run `hidden = export(anonymize=True); text2 = glb_text(hidden); print([n for n in ("left lung", "Läsion",
      "Tumor(1)", "x" * 110, "s_1", "Doe", "brain", "skull", "Segment_", "S_") if n in text2])`.
   4. Click *Start*. Wait for "Live". Run `w.controller._live.set_anonymize_names(True)`, wait 2 s; then
      `w.controller._live.set_anonymize_names(False)`, wait 2 s. Click *Stop*.

   Expected:
   - Step 2: the two painted segments keep `<mrmlId>/<ID>` with `segment_id` = the ID; `left lung`, `Läsion`,
     `Tumor(1)`, the 110-character ID and `s_1` print as `<mrmlId>/s_1` … `/s_5` (in this order) with `segment_id` =
     the raw ID and the given names; `skipped: []`; `text` holds every raw ID (as `extras.segmentId`) and name.
   - Step 3: every segment is `<mrmlId>/s_<n>` — the five keep `s_1` … `s_5`, the two painted ones get `s_6`, `s_7`
     (an alias once issued is never reissued or shadowed) —, `segment_id` prints `None`, names are `Segment 1` …
     `Segment 7`; the list printed is `[]`: no raw ID or name anywhere in the JSON chunk.
   - Step 4: one new snapshot `v2:` after the switch on and one `v3:` after the switch off (no `scene.update` for
     them); `len(glb_text(export()))` afterwards is unchanged and `export()` shows the aliases of step 3 kept for the
     five and for the two painted ones (`s_6`, `s_7` with `segment_id` revealed again) — the alias survives the
     switch-off (§7.3).
9. **`AddEmptySegment` while live: exactly one snapshot per change; reads inside `NodeAddedEvent` write nothing**
   (SLC-36 `[TODO verify]`: an export's own display getters may fire a deferred `SegmentModified(NULL)`).
   1. Click *Start*. Wait for "Live".
   2. Run `sid = s.AddEmptySegment("", "Doe^John added")`, wait 3 s, then paint a stroke into it, wait 2 s.
   3. Run as one block (a probe on a private observer, no session needed, but harmless while live):

      ```python
      marks = []
      def probe(caller, event, calldata=None):
          node = calldata
          if node is not None and node.IsA("vtkMRMLSegmentationNode"):
              before = (node.GetMTime(), node.GetSegmentation().GetMTime(), slicer.mrmlScene.GetMTime())
              sids2 = node.GetSegmentation().GetSegmentIDs()
              names = [node.GetSegmentation().GetSegment(i).GetName() for i in sids2]
              after = (node.GetMTime(), node.GetSegmentation().GetMTime(), slicer.mrmlScene.GetMTime())
              marks.append((sids2, names, before == after))
      from vtkmodules.util.misc import calldata_type
      from vtkmodules.vtkCommonCore import VTK_OBJECT
      probe = calldata_type(VTK_OBJECT)(probe)
      tag = slicer.mrmlScene.AddObserver(slicer.vtkMRMLScene.NodeAddedEvent, probe)
      n2 = slicer.mrmlScene.AddNewNodeByClass("vtkMRMLSegmentationNode", "Doe^John seg 2")
      slicer.mrmlScene.RemoveObserver(tag); print(marks)
      ```

   Expected:
   - Step 2: the empty segment costs a snapshot it is not in: `SegmentAdded` of a segment the viewers do not hold is
     a re-export, and `v2:` holds the two painted segments only — the new one is left out as `no-triangles` (the
     panel says one model or segment shown in 3D could not be shared); only exported entities are announced, so no
     `scene.nodeAdded`. The stroke (`RepresentationModified`) lifts a skip reason the classifier does not trust
     without the export (`no-triangles` is re-checked there), so it is one more plain snapshot `v3:` with all three
     segments — again no `scene.nodeAdded`. Over the step: updates `[]`, snapshots `v1: v2: v3:` — **not**
     `v1: v2: v3: v4:` (a deferred `SegmentModified(NULL)` fired by the export's own getters marks appearance only,
     which changes nothing); a fourth snapshot is the failure this step is for — report it.
   - Step 3: `[((), [], True)]` — `GetSegmentIDs()` and `GetSegment(id).GetName()` inside `NodeAddedEvent` changed no
     MTime (the watcher reads them there). The new empty segmentation sends nothing (no segments); remove it:
     `slicer.mrmlScene.RemoveNode(n2)`.
10. **Painting: one export per quiet period, export time, GLB size** (ADR 0005 Consequences, plan Follow-ups;
    SLC-28 brings the per-node ticks). Two sub-steps.
    1. Click *Start*. Wait for "Live". Paint `Doe^John skull` continuously for about 20 s (`T`), without pausing
       longer than half a second; stop painting and note when the status returns to "Live". Then wait 5 s.

       Expected: `v1:` and **one** `v2:` — about 750 ms after the last stroke — and no `scene.update`; while painting
       nothing is exported (every stroke ends in `RepresentationModified` and re-bases the 2 s cap). Record: the
       number of snapshots (more than one means a pause ≥ 750 ms between strokes, or a Slicer event the rule does not
       cover — report it), how long "Updating the scene" showed (the export time), and whether the 3D view stuttered
       during or after painting (the main-thread stall).
    2. Size (relay (a) needed only for the time): *Sample Data → CTChest*, *Segment Editor → Threshold* a bone segment
       (≥ 200 HU) and a soft-tissue segment (−200…200 HU), *Show 3D* on; then on MRHead's scene a brain threshold
       (≥ 50). For each run `t = time.monotonic(); text = glb_text(export()); print(f"{time.monotonic() - t:.1f} s")`.

       Expected: the GLB size and the time are printed; record both (the 64 MiB question of architecture §10). The
       panel shows the budget warning only above the profile's recommended size (§14).
11. **A Latin-1 segment ID** (`bytes` from VTK; SLC-27 `[TODO verify]`). `[TODO verify]` that VTK accepts `bytes` for a
    `std::string` argument; if `AddEmptySegment` refuses it, the case cannot arise from Python — record that instead.
    1. `rid = s.AddEmptySegment("L\xe4sion".encode("latin-1"), "Doe^John latin"); print(repr(rid),
       [repr(i) for i in s.GetSegmentIDs()])`, then paint a stroke into the new segment (select it in the table).
    2. Run `export()`.
    3. Click *Start*. Wait for "Live". Run `s.GetSegment(rid).Modified()` (a `SegmentModified` with the raw ID as call
       data), wait 1 s. Click *Stop*. Look at the Python console and the Error Log.

    Expected:
    - Step 1: the ID comes back as `bytes` (`b'L\xe4sion'`) or as a `str` with U+FFFD/the original letter — record
      which; nothing is raised.
    - Step 2: the segment is `<mrmlId>/s_<n>` (a `bytes` ID is always aliased) with `segment_id` `'L�sion'`
      (decoded with U+FFFD) and its name; `skipped: []`.
    - Step 3: nothing from `remoteview_core` or `RemoteView.py` beyond at most one type-only line; if the VTK wrapper
      fails to decode the call data it reports a `UnicodeDecodeError` to stderr with a byte and a position, never the
      ID — record whether any line shows the raw bytes. Afterwards `s.RemoveSegment(rid)`.
12. **Empty segments, planar contours and a *HideFromEditors* flip** (SLC-36 `[TODO verify]`).
    1. `s.AddEmptySegment("", "Doe^John empty")` (no strokes). Click *Start*. Wait for "Live".
    2. `seg.SetHideFromEditors(1)`, wait 2 s; `seg.SetHideFromEditors(0)`, wait 2 s. Click *Stop*.
    3. N/A without SlicerRT: load a planar-contour segmentation (an RT structure set), *Show 3D* on with *Planar
       contour* as the 3D representation, and run `export()`.

    Expected:
    - Step 1: the painted segments are on the viewer; the empty one is left out (`export()` reports it as
      `no-triangles`, the panel says one model or segment shown in 3D could not be shared); the snapshot still goes.
    - Step 2: `[["scene.nodeRemoved",2,1],["scene.nodeAdded",3,2]]`, snapshots `v1: v4:` — the flip fires
      `ModifiedEvent` on the segmentation node. If nothing happens at `(1)`, report it.
    - Step 3: every planar-contour segment prints as `no-triangles` (polylines are not exported — an accepted
      difference), the rest of the scene ships.
13. **Logs** (T7, rule 6). Search the application log file and the Error Log window (not the console window) for
    `Doe`, `Traceback`, `vtkMRMLSegmentationNode`, every segment ID printed in steps 1, 8 and 11 (`left lung`,
    `Läsion`, `Tumor(1)`, `s_1`, `xxxxxxxxxx`, `L\xe4sion`), and every session code written down during §13. Expected:
    - None of them is on a line from `remoteview_core` or `RemoteView.py`; hits on lines Slicer wrote or on echoed
      console commands are allowed.
    - No `vtkError`/`vtkWarning` line with a segment ID that the module's reads caused (an unknown ID passed to
      `GetSegmentVisibility`/`GetSegmentColor` logs one with the ID — the adapter passes only IDs it just read from
      `GetSegmentIDs()`; a `vtkError` here means a race the §13 scene exposed: report it).
    - No publisher token anywhere (a 43+ character `[A-Za-z0-9_-]` string on a RemoteView line).
14. **Transforms** (SLC-13 for segmentations; FR-06, FR-12).
    1. `t = linear(np.eye(4).tolist(), "Move"); seg.SetAndObserveTransformNodeID(t.GetID())`. Click *Start*. Wait for
       "Live".
    2. Drag "Move"'s LR slider in *Transforms* for about 3 s.
    3. `t.SetAndObserveTransformNodeID(bend.GetID())` (§5's thin-plate spline), wait 2 s; run `export()`.
    4. Drag the slider again for about 3 s. Click *Stop*.

    Expected:
    - Step 2: `scene.update` only (one `matrix` per segment, about 4/s), no snapshot; both segments follow on the
      viewer.
    - Step 3: one snapshot; `export()` prints `True` (baked) for both segments and the viewer shows them bent as
      Slicer's 3D view does.
    - Step 4: snapshots at most about every 2 s while dragging and one about 750 ms after the last change (a baked
      node takes the slow lane) — no `scene.update` for the segments.

Known gaps (not failures):
- A segment hidden at export time and shown later costs a full snapshot (step 5 sub-step 2; a segmentation whose
  `Opacity3D` drops to 0 while live is the cheap `visible: false`, sub-step 3); `release` may reverse the privacy
  default for models and segments (`2026-10-20-slicer-5`, `2026-10-28-slicer-1`).
- An empty segment added while live costs a snapshot it is not in, and its first stroke another (step 9); the viewers
  learn of it from the second one, without a `scene.nodeAdded`.
- Continuous painting exports the whole scene once per quiet period on the main thread (step 10); SLC-28 brings
  per-node preparation. A script editing a mesh every < 750 ms for ever never exports until it stops.
- Planar contours are not exported (`no-triangles`).

| Date | Slicer version | OS | Result | Tester |
|---|---|---|---|---|
| | | | | |

## §14 Decimation to the device profile (SLC-14; FR-10, NFR-03, protocol §7.5)

Preconditions: §2's setup with relay (b) or (c) and a viewer joined. The panel uses the `mobile` profile (500k
triangles in all, 100k per model; the profile selector is SLC-18). In a new scene run in the Python console

```python
import vtk
def sphere(center, n, name):  # 2·n·(n − 2) triangles
    source = vtk.vtkSphereSource()
    source.SetCenter(*center)
    source.SetRadius(40)
    source.SetThetaResolution(n)
    source.SetPhiResolution(n)
    source.Update()
    model = slicer.modules.models.logic().AddModel(source.GetOutput())
    model.SetName(name)
    return model
sphere((0, 0, 0), 448, "Big")         # 399,616 triangles
sphere((100, 0, 0), 240, "Medium")    # 114,240
sphere((200, 0, 0), 160, "Small")     # 50,560
sphere((300, 0, 0), 8, "Tiny")        # 96
```

Steps:

1. Click *Start session* and join with the viewer.
2. Stop the session. In *Models* select "Big" and look at *Information* (number of cells).

Expected results:

- Step 1: Slicer is busy for a few seconds while it simplifies "Big" and "Medium", and the code appears only then (SLC-28,
  §15, shows the code first and a progress dialog); then "Sending the scene", then "Live". The viewer shows the four spheres, round and in
  place — "Big" and "Medium" with visibly fewer, larger facets than in Slicer (100,000 triangles at most each; the
  total is at most 500,000), "Small" and "Tiny" unchanged; all lit from outside. The panel shows no warning (the scene
  is about 3 MB, below the 32 MB recommended for `mobile`).
- Step 2: "Big" still has 399,616 cells in Slicer: only the copy that is sent is simplified.
- Throughout: no traceback in the Python console.
- `[TODO verify]` in Slicer 5.12.4: `vtkQuadricDecimation` and `vtkDecimatePro` from `vtkmodules.vtkFiltersCore` behave
  as in the `vtk` 9.6.2 wheel (Slicer builds VTK 9.6.2, `docs/research/slicer-decimate.md`); how long the scene takes to
  prepare (≈ 6 s on the development machine, which sends 250,656 triangles, 3.0 MB).

| Date | Slicer version | OS | Result | Tester |
|---|---|---|---|---|
| | | | | |

### §14.1 A mesh with an edge shared by thousands of triangles (SLC-54)

Preconditions: §14's. In a new scene run in the Python console (a "book" of 3,000 pages, 100 × 150 mm, all on one spine
edge; 6,000 triangles, so nothing is decimated under `mobile`):

```python
import numpy as np
import vtk
from vtkmodules.util.numpy_support import numpy_to_vtk, numpy_to_vtkIdTypeArray
pages = 3000
a = np.linspace(0.0, np.pi, pages)
rim = np.c_[100 * np.cos(a), 100 * np.sin(a), np.zeros(pages)]
points = np.vstack([[0, 0, 0], [0, 0, 150], rim, rim + [0, 0, 150]])
outer = 2 + np.arange(pages)
triangles = np.vstack([np.c_[np.zeros(pages), outer, np.ones(pages)],
                       np.c_[np.ones(pages), outer, outer + pages]]).astype(np.int64)
book = vtk.vtkPolyData()
book.SetPoints(vtk.vtkPoints())
book.GetPoints().SetData(numpy_to_vtk(points, deep=True))
cells = vtk.vtkCellArray()
cells.SetData(numpy_to_vtkIdTypeArray(np.arange(0, triangles.size + 1, 3, dtype=np.int64), deep=True),
              numpy_to_vtkIdTypeArray(triangles.ravel(), deep=True))
book.SetPolys(cells)
slicer.modules.models.logic().AddModel(book).SetName("Book")
```

Steps:

1. Click *Start session*; time how long the code takes to appear (a stopwatch is enough). Join with the viewer.

Expected results:

- Step 1: the code appears within about a second (before SLC-54 Slicer was frozen for more than 10 s here); the viewer
  shows a half-circle fan of 3,000 thin pages around one edge.
- Throughout: no traceback in the Python console.
- `[TODO verify]` in Slicer 5.12.4: `vtkOrientPolyData` from `vtkmodules.vtkFiltersCore` behaves as in the `vtk` 9.6.2
  wheel (`vtkOrientPolyData.cxx` is byte-identical in Slicer's fork, `docs/research/slicer-collect.md` §2).

| Date | Slicer version | OS | Result | Tester |
|---|---|---|---|---|
| | | | | |

### §14.2 Flat meshes decimate in seconds (SLC-52)

Preconditions: Slicer with the RemoteView module loaded (no session needed). In the Python console of a new scene
(`RemoteView/remoteview_core` is on the module's path once the module has loaded; `[TODO verify]`):

```python
import time
import numpy as np
import vtk
from vtkmodules.util.numpy_support import numpy_to_vtk
from remoteview_core import decimate
from remoteview_core.collect import mesh_from_polydata
from remoteview_core.glb_writer import Entity

def node(polydata):
    mesh = mesh_from_polydata(polydata)
    return Entity(node_id="n", kind="model", name="n", positions=mesh.positions * 0.001, normals=mesh.normals,
                  indices=mesh.triangles, color=(1, 1, 1), opacity=1.0, visible=True, mrml_id="n")

def timed(polydata, share):
    entity = node(polydata)
    started = time.time()
    smaller = decimate.decimate_entity(entity, share)
    print(entity.triangle_count, "->", smaller.triangle_count, "in", round(time.time() - started, 2), "s")

plane = vtk.vtkPlaneSource(); plane.SetPoint1(100, 0, 0); plane.SetPoint2(0, 100, 0); plane.SetResolution(300, 300)
triangles = vtk.vtkTriangleFilter(); triangles.SetInputConnection(plane.GetOutputPort()); triangles.Update()
timed(triangles.GetOutput(), 100_000)                      # a flat plane of 180,000 triangles
side = np.arange(-111, 112); y, x = np.meshgrid(side, side, indexing="ij")
volume = np.zeros((162, len(side), len(side)), np.uint8); volume[1:-1] = x * x + y * y <= 110 * 110
image = vtk.vtkImageData(); image.SetDimensions(len(side), len(side), 162)
image.GetPointData().SetScalars(numpy_to_vtk(volume.ravel(), deep=True))
surface = vtk.vtkDiscreteFlyingEdges3D(); surface.SetInputData(image); surface.SetValue(0, 1); surface.Update()
timed(surface.GetOutput(), 100_000)                        # an unsmoothed labelmap cylinder, 434,800 triangles
sphere = vtk.vtkSphereSource(); sphere.SetThetaResolution(448); sphere.SetPhiResolution(448); sphere.Update()
timed(sphere.GetOutput(), 100_000)                         # a smooth sphere of 399,616 triangles
```

Expected results:

- Each line prints the share reached (100000 or just under) and a time: the plane ≈ 1 s, the labelmap cylinder ≈ 4 s,
  the sphere ≈ 3 s on the development machine (it took over 90 s, over 90 s and ≈ 3 s before SLC-52). Record the times
  in the Result column: `[TODO verify]` Slicer's own VTK build is as fast as the `vtk` 9.6.2 wheel.
- Throughout: no traceback in the Python console.

| Date | Slicer version | OS | Result | Tester |
|---|---|---|---|---|
| | | | | |
