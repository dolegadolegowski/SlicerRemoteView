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
- Step 4: the category *Remote* contains *RemoteView* with the Wi-Fi-style blue icon; the panel opens and shows
  "RemoteView is not connected. Session controls arrive in a later version." The *Help & Acknowledgement* section
  says nothing is sent before *Start session* and lists what is sent afterwards; no error in the Python console.
- Step 5: the Python console shows "RemoteView load test passed" and no error dialog appears (*Reload and Test*
  shows a dialog only on failure); the scene is not cleared.
- Step 6: no connection beyond the baseline (opt-in rule — FR-02, Extension Index tier 1); no pip/installation
  dialog appears.

| Date | Slicer version | OS | Result | Tester |
|---|---|---|---|---|
| | | | | |
