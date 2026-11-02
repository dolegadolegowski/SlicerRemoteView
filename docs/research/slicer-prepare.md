# Preparing the scene without freezing Slicer (SLC-28, SLC-50, SLC-51, SLC-68)

At *Start session*, and again at every live change that needs a new snapshot (a geometry edit, an added node, a
reset: `LiveUpdates._export`), `build_snapshot` used to collect and decimate every node in one call on Slicer's main
thread. On the reporter's 16M-triangle micro-CT segmentation that call took 10.5-11.0 s in Slicer 5.12.4 under
Rosetta even after SLC-41 (`docs/research/slicer-decimate.md` § SLC-41). Slicer drew nothing and took no input
meanwhile, and the transport thread did not get the GIL either. Processing one node per `QTimer` tick (R-05) does not
help when one node holds most of the triangles. This note records why the work stays on the main thread, how it is cut
into steps, and how a per-node cache makes a live change cost only the node that changed.

## Threads: checked and rejected

| Fact | Source | Consequence |
|---|---|---|
| (a) VTK 9.6 has a wrapping hint that releases the GIL around a call: `VTK_UNBLOCKTHREADS`, on `vtkAlgorithm::Update()`, `Update(int)`, `UpdateExtent`, `UpdateTimeStep`, `UpdateInformation` and `UpdateWholeExtent` (inherited by every filter). The generated code calls `PyEval_SaveThread()` before the call only under `#ifdef VTK_PYTHON_FULL_THREADSAFE`. Other methods keep the GIL, among them `DeepCopy`. | [vtkWrappingHints.h#L32-L33](https://github.com/Kitware/VTK/blob/v9.6.0/Common/Core/vtkWrappingHints.h#L32-L33), [vtkWrapPythonMethod.c#L818-L826](https://github.com/Kitware/VTK/blob/v9.6.0/Wrapping/Tools/vtkWrapPythonMethod.c#L818-L826), [vtkAlgorithm.h#L683-L686](https://github.com/Kitware/VTK/blob/v9.6.0/Common/ExecutionModel/vtkAlgorithm.h#L683-L686), [vtkParseMerge.c#L310-L314](https://github.com/Kitware/VTK/blob/v9.6.0/Wrapping/Tools/vtkParseMerge.c#L310-L314) | a filter's `Update()` could run in a worker thread without holding the GIL |
| (b) `VTK_PYTHON_FULL_THREADSAFE` defaults to ON since VTK 9.4.0, the release that added the hint. Slicer 5.12.4 does not set it, so its VTK fork (`c9cd17a`, upstream 9.6.2 plus 7 commits that do not touch it) builds with ON. This was not checked against the generated `vtkPythonConfigure.h` of a shipped Slicer (`[TODO verify]`). | [VTK CMakeLists.txt#L173-L174](https://github.com/Kitware/VTK/blob/v9.6.0/CMakeLists.txt#L173-L174), [9.4 release note](https://github.com/Kitware/VTK/blob/v9.6.0/Documentation/release/9.4/python-hint-unblock.md#L3), [External_VTK.cmake#L173-L174](https://github.com/Slicer/Slicer/blob/v5.12.4/SuperBuild/External_VTK.cmake#L173-L174) | idem in Slicer. The repository's earlier note (`slicer.md` §3: "Slicer is not built with `VTK_PYTHON_FULL_THREADSAFE`") was true up to VTK 9.3 |
| (c) Slicer's main thread holds the GIL at all times, also while it idles in the Qt event loop. Slicer initialises Python itself (`Py_InitializeFromConfig`, which takes the GIL for the calling thread). It then initialises PythonQt with `PythonAlreadyInitialized`. Nothing in Slicer 5.12.4, CTK `5056664` or PythonQt `74dcd67` calls `PyEval_SaveThread`, and PythonQt's thread support is compiled in but switched off (`_globalShouldAllowThreads`, `_enableGILScope` false). CPython hands the GIL to a waiting thread only from its eval loop, every 5 ms. | [qSlicerCorePythonManager.cxx#L64-L74](https://github.com/Slicer/Slicer/blob/v5.12.4/Base/QTCore/qSlicerCorePythonManager.cxx#L64-L74), [PythonQtMethodInfo.cpp#L50](https://github.com/commontk/PythonQt/blob/74dcd675e1515324cd7467a328d63dd25d263679/src/PythonQtMethodInfo.cpp#L50), [PythonQtThreadSupport.cpp#L45](https://github.com/commontk/PythonQt/blob/74dcd675e1515324cd7467a328d63dd25d263679/src/PythonQtThreadSupport.cpp#L45), [ceval_gil.c#L19-L22](https://github.com/python/cpython/blob/v3.12.10/Python/ceval_gil.c#L19-L22); Andras Lasso in the [forum (2023-10-19)](https://discourse.slicer.org/t/using-python-multithreading-in-3d-slicer/32299/5): a worker advances when the mouse moves over a view, because Slicer's Python code then runs and yields the GIL | a worker progresses only while the main thread runs Python or sleeps; when the main thread wants the GIL back, it waits for whatever the worker holds |
| (d) numpy 2.4.6 (Slicer's) releases the GIL in the loops of `sort`/`argsort`, `take` and integer fancy indexing, ufuncs, `concatenate`, `astype` and `bincount`'s count (above 500 elements). It holds the GIL in the fast path of `ufunc.at` (`np.minimum.at`, `np.maximum.at`: `clustering.components` and `_collapse`) and in `bincount`'s min/max pre-pass. | [item_selection.c#L1295-L1296](https://github.com/numpy/numpy/blob/v2.4.6/numpy/_core/src/multiarray/item_selection.c#L1295-L1296), [ufunc_object.c#L1162-L1163](https://github.com/numpy/numpy/blob/v2.4.6/numpy/_core/src/umath/ufunc_object.c#L1162-L1163), [`trivial_at_loop` #L6128-L6133](https://github.com/numpy/numpy/blob/v2.4.6/numpy/_core/src/umath/ufunc_object.c#L6128-L6133), [compiled_base.c#L229-L249](https://github.com/numpy/numpy/blob/v2.4.6/numpy/_core/src/multiarray/compiled_base.c#L229-L249) | idem |
| (e) A Python observer (the quadric's deadline observer) always takes the GIL: `vtkPythonCommand::Execute` uses `vtkPythonScopeGilEnsurer(true)`. | [vtkPythonCommand.cxx#L78-L79](https://github.com/Kitware/VTK/blob/v9.6.0/Wrapping/PythonCore/vtkPythonCommand.cxx#L78-L79) | in a worker, every progress event would wait for the main thread to yield |

Measured with the dev venv (VTK 9.6.2 wheel, numpy 2.5.4; a pure-Python counter thread next to the call, its rate
relative to its rate alone): 0.96-0.99 during the `Update()` of `vtkQuadricDecimation` (3.9M triangles, 11.6 s),
`vtkPolyDataNormals` and `vtkTriangleFilter`, `np.sort` of 48M int64, `take`, fancy indexing and `bincount`; 0.61 during
`np.minimum.at` on 48M; 0.06 during `np.unique(axis=0)` on 4M rows. These numbers agree with (a) and (d).

**Decision.** A worker thread would need the main thread to give up the GIL from a timer (the SimpleFilters pattern
in the forum post). Each stretch in which the worker holds the GIL would then still stall Slicer, as soon as the main
thread wants the GIL back. Such stretches are `ufunc.at` on 48M elements (0.4 s), `np.unique(axis=0)`, `DeepCopy`,
and the Python between calls. The project's threading rule keeps VTK on the main thread (`slicer.md` §3), and none of
this can be tested without Slicer (CLAUDE.md rule 10). The preparation is therefore cut into steps on the main
thread instead (below). A single numpy or VTK call cannot be cut. The longest is the quadric's run; the others are
`vtkPolyDataNormals` (0.88 s on 31.4M triangles natively), `vtkTriangleFilter` (in parts of bounded work since
SLC-52), the geometry copy's `DeepCopy` and a bake's `TransformPoints` (a bake under a non-linear transform has not
been measured). Moving only the quadric's `Update()` into a worker is the follow-up of the plan (SLC-51 follow-ups):
by (a) and (b) it runs without the GIL in Slicer. It must first be
measured in Slicer, together with a main-thread yield and with VTK's messages from a worker thread
(`vtkOutputWindow`, `[TODO verify]`).

## Steps (SLC-28)

`remoteview_core.steps`: a *steps* generator yields `None` between its heavy calls and returns its result, and
`yield from` nests such generators. `run()` takes one to the end in a single call. The one-shot functions are exactly
that: `collect_scene`, `fit_to_budget`, `decimate_entity`, `cluster_connected`, `components` and `build_snapshot`. The
one-shot and stepwise paths therefore run the same code and give the same bytes. `Stepper` takes steps a slice of time
at a time; a step is never split, so a slice ends after the step that crosses it. The steps:

- collect, per mesh: the geometry copy; the cell check; `vtkTriangleFilter`; the bake; the area test, in parts of
  `CHUNK_TRIANGLES` (4M) triangles; the winding check, a sort of the directed edges in parts of about 4M triangles,
  split by the first vertex (both copies of a repeated edge share it, so the result is the same);
  `vtkPolyDataNormals`; the finite check; the conversion to glTF; then one step per node.
- clustering, per pass: grid keys; coincident pairs; edges; each round of `components`; the labels; the collapse in
  two steps; the rescue.
- decimate: the input checks; each size-bound pass; the fan clustering; the fallback's passes. The quadric's runs and
  `_finished` form **one** step. Its `QUADRIC_SECONDS` deadline therefore counts only their own time, never the event
  loop's between steps, and the result does not depend on how busy Slicer is.
- the last step: the size check, the `scene.nodeAdded` hint, `write_glb`, the SHA-256 and `begin`. The client is asked
  for nothing before it. A preparation abandoned between steps (`close()`) has sent nothing and used no version. It
  is short: 0.033 s natively for ten models of 99,456 triangles under `quest3` (994,560 triangles, an 11.4 MiB
  quantised GLB; 0.022 s for the 17.1 MiB unquantised one), so about 0.2 s for the relay's 64 MiB limit. The SHA-256
  and the chunks therefore stay in it (the SLC-06/SLC-08 follow-up); the chunk frames are encoded only as the
  transport takes them.

The profile of `prepare_snapshot` on a generated segmentation-like surface (Gaussian-smoothed noise, flying edges,
one segment, `mobile` budget → 100,000 triangles), measured natively (arm64, dev venv), one step per `advance`. The
lists of steps are from `step_profile.py`, a local harness that is not committed:

| Input | Steps | Total | Longest step | Next longest | One call (`build_snapshot`) |
|---|---|---|---|---|---|
| 4.35M triangles | 29 | 2.77 s | 1.08 s (the quadric's step) | 0.36 s (the winding sort, before the parts) | 2.68 s, same bytes |
| 31.4M triangles, without the parts | 30 | 12.67 s | 2.68 s (the winding sort of 94M edge keys) | 1.49 s (the area test), 1.27 s (the quadric), 1.17 s (grid keys + coincident pairs) | 13.26 s, same bytes |
| 31.4M triangles, with the parts | 49 | 13.07 s | 1.24 s (the quadric's step) | 0.98 s (the edges inside one cell, 94M), 0.88 s (`vtkPolyDataNormals`), 0.83 s (coincident pairs), 0.63-0.67 s (a `components` round, a part of the winding sort) | 12.90 s, same bytes |

The steps cost nothing measurable (13.07 s against 12.90 s in one call, within the noise). The quadric's input is
bounded by the size bound (SLC-41), so its step does not grow with the input: 1.08-1.24 s here, about 1.9 s on the
reporter's node in Slicer under Rosetta (its two runs took 1.75 + 0.10 s there, §14). The other steps scale with the mesh. On the reporter's 16M triangles
they are about half of the 31.4M figures, so about 0.5 s natively and an estimated 0.75 s under Rosetta (collect +
fit ran 1.4-1.5 times slower there, §14). The quadric's step is then the only one above 1 s; manual §15 measures
it in Slicer.

## Per-node cache (SLC-50)

A live re-export used to collect and decimate every node again (SLC-41 follow-up (g)): about 11 s on the reporter's
scene for any change, also one to a small model next to it. `MeshCache` keeps, per `nodeId`, what the last export
made of the node's mesh: the **stamp** of the mesh, the triangle count collect gave, the **share** it was fitted to,
the fitted geometry (glTF positions, normals, indices) and whether it was reduced or could not be. A re-export
consults it before collecting:

- **Stamp.** The polydata's C++ address (`GetAddressAsString`), its `GetMTime()`, and the `GetMTime()` of the
  connectivity and offsets arrays of its polygons and strips. Add the bake for a sheared linear world matrix (the
  matrix); a non-linear chain is never cached (its transform is a new object at every read). A linear TRS matrix is
  not part of the stamp, because the collected mesh is in the node's frame and the matrix travels as `T.matrix`.
- Why that identifies a mesh. Every `Modified()` takes the next value of one global atomic counter
  ([vtkTimeStamp.cxx#L19-L45](https://github.com/Kitware/VTK/blob/v9.6.0/Common/Core/vtkTimeStamp.cxx#L19-L45)), and
  a new object calls `Modified()` in its constructor
  ([vtkObject.cxx#L211-L217](https://github.com/Kitware/VTK/blob/v9.6.0/Common/Core/vtkObject.cxx#L211-L217)). An
  object at a reused address therefore has a newer time. `vtkPolyData::GetMTime()` covers its four cell arrays
  ([vtkPolyData.cxx#L2205-L2225](https://github.com/Kitware/VTK/blob/v9.6.0/Common/DataModel/vtkPolyData.cxx#L2205-L2225)),
  its points and their data array
  ([vtkPointSet.cxx#L114-L128](https://github.com/Kitware/VTK/blob/v9.6.0/Common/DataModel/vtkPointSet.cxx#L114-L128),
  [vtkPoints.cxx#L141-L146](https://github.com/Kitware/VTK/blob/v9.6.0/Common/Core/vtkPoints.cxx#L141-L146)), and
  the point and cell data
  ([vtkDataSet.cxx#L320-L331](https://github.com/Kitware/VTK/blob/v9.6.0/Common/DataModel/vtkDataSet.cxx#L320-L331)).
  It does not cover the arrays inside a `vtkCellArray`. Measured with 9.6.2: after `Modified()` on a polygon
  connectivity array, the polydata's time stays the same. Those arrays are therefore added. The cache misses whenever
  VTK's own pipeline (and Slicer's 3D view) would see a change, and on a few changes it would not see.
- **Share.** `allocate` needs every node's triangle count, which a cached node gives without being collected. A
  decimated result is used for the same share only. A node that was not decimated (count ≤ share) is used for any
  share it still fits, since its result does not depend on the share. When a cached node's share changed (the scene
  is over the profile's total and another node's count changed), a node that was decimated is collected again
  before it is decimated; any other entry holds the mesh as collected, which is decimated directly. Only what the
  export sent is kept: the fitted geometry (at most the share, 100k triangles), or the whole mesh of a node that
  fitted its share or that nothing could reduce — never a collected mesh that was decimated (the reporter's node
  would hold about 0.8 GB for the whole session). When a decimated node is collected again and its mesh has lost
  every triangle since it was listed (a change between steps), it is left out and the others are named again as a
  fresh collection names them; their shares are still those of the listed nodes, and the mark of that change
  re-exports the scene after this snapshot.
- **A deadline fallback is kept too.** A node whose quadric ran out of its 8 s (SLC-41; under load) keeps the coarser
  clustering result while its mesh and share are unchanged, where an export without the cache would try the quadric
  again.
- **Lifetime.** One cache per live session (`LiveUpdates`); entries of nodes not exported by the last preparation
  are dropped; a reset (scene closed) clears it. The light reads (name, colour, opacity, visibility, transform) are
  made at every export, as before.

Measured natively (dev venv) on a generated 43.8M-triangle surface — the profile harness with a smaller smoothing
radius — with a sphere of 7,936 triangles next to it, `mobile`: the first export takes 17.8 s; a second one with
nothing changed 0.00 s; one after the sphere's mesh is replaced 0.01 s, because the surface is neither collected nor
decimated again. Every snapshot goes through the cache (`prepare_snapshot` makes an empty one for a single export),
so there is one fitting path for snapshots; its per-node decision is `decimate.fit_entity_steps` (SLC-53's
`fit_entity` in steps), which `decimate.fit_steps` uses too. The tests compare warm exports with fresh ones byte for byte.

## Small islands (SLC-53 follow-up (e))

SLC-53 leaves every node's small islands out before the shares are given (`docs/research/slicer-islands.md`). It
was merged from `ws/slicer-islands` into this branch, and the preparation runs it like this:

- **One step per node.** `snapshot._fit_steps` calls `decimate.island_mask` for every node collected now, one step
  each, before `allocate`; the shares count the triangles left. Then each node goes through
  `decimate.fit_entity_steps` (SLC-53's `fit_entity` in steps). A node within its share is sent without its islands,
  compacted. A node above its share is decimated from an entity that shares the collected positions, with only its
  triangles filtered (`without_islands(…, compact=False)`, no copy).
- **The cache counts the islands.** An entry keeps the number of triangles in the islands it left out
  (`CachedMesh.islands`), so a cached node's share needs no mask. An entry holds the collected mesh only if it was
  neither decimated nor cleaned. A decimated entry was fitted to another share. A cleaned entry is compacted, while a
  fresh export decimates an input that still holds the islands' vertices. So either kind is collected again when its
  share changes, and its islands are looked for again. That keeps a warm export identical, byte for byte, to a fresh
  one (`test_prepare_cache.py`).
- **One island rule per cache.** What the fit makes of a mesh depends on the rule: on or off,
  `SMALL_ISLAND_TRIANGLES` and `SMALL_ISLAND_SHARE`. `prepare_snapshot` passes the rule to `MeshCache.use_settings`,
  which empties the cache when it changes. Changing the rule during a session (SLC-54's checkbox) therefore
  collects and fits every node once more.

Measured natively with a local harness (not committed) on a generated surface of 15,384,537 triangles (smoothed
noise through flying edges, one segment) next to a sphere of 7,936 triangles, `mobile`, one step at a time:

| Islands | Steps | Total | Longest step | Island step of the surface | After the sphere's mesh is replaced |
|---|---|---|---|---|---|
| off | 53 | 6.95 s | 1.28 s (the quadric) | none | 0.01 s, no mask |
| on | 55 | 7.30 s | 1.20 s (the quadric) | 0.54 s | < 0.01 s, the sphere's mask only |

Unlike the quadric's step, whose input the size bound caps (at most 800k triangles for a 100k share), the island
step grows with the node. On the reporter's mesh SLC-53 measured 0.6 s natively and about 1 s in Slicer under
Rosetta, against about 1.9 s for the quadric there. On a generated 77.4M-triangle surface it took 2.78 s and was the
longest step of that export; without islands, the longest step of the same export took 3.19 s.

## Live preparation and the panel (SLC-51)

- `LiveUpdates(slice_s=…)`: `_export` starts a preparation (`prepare_snapshot` with the session's cache) and runs
  its first slice; the pump's `tick()` runs one slice per tick until the snapshot begins. The default `None` runs
  the whole preparation in the call, as before. The panel passes 0.05 s: with the pump's 50 ms period the main
  thread spends almost all its time on the preparation and handles Qt's events between slices.
- **The SLC-30 design review.** The debouncer is held from the first step until `begin` has run and
  `sent = snapshot.sent` is installed. The preparation's hold then becomes the in-flight hold. Marks made meanwhile
  flush after the ack and are classified against the new scene, so dropping the client's held changes at `begin`
  stays right.
- **A preparation runs only while an export may go out.** Stop, a reset (scene closed), a batch, a lost
  connection, *Hide node names* or a new profile, or a gate that closes (a relay wait) abandon it. It then sends
  nothing and uses no version. The next tick starts again, and the cache makes the restart cheap: only nodes that
  were not finished, or whose stamp changed, are prepared again.
- **A closed scene leaves the viewers first.** When the scene that replaces a closed one (a reset) takes more than
  one slice, its preparation is dropped, an empty snapshot clears the closed scene off the viewers (§7.3), and the
  new scene follows as an owed snapshot after that one's ack. Before SLC-51 a reset bounded this with one call; in
  steps, batches (loading data) could otherwise keep the closed scene on the viewers for as long as they run.
- **No `processEvents`.** The slices run from the pump, so nothing re-enters `LiveUpdates` in the middle of a step.
  This answers the SLC-32 review's concern about a progress dialog that runs `processEvents` during an export. If a
  scene event calls back from inside a step anyway (a read that fires an MRML event), an abandon closes the steps
  as soon as that step returns, and nothing of them is sent.
- **The panel.** "Preparing the scene" with the progress (`Progress`: two units per node, collected and fitted);
  during a retry the last failure's reason stays as the detail. The code is shown from the first tick (SLC-25
  follow-up). The adapter shows a non-modal `QProgressDialog` with no cancel button (*Stop session* stays in the
  panel) that does not take the focus (`WA_ShowWithoutActivating`). Qt shows it once its estimate of the
  preparation's length passes `minimumDuration` (1 s) — after about a tenth of a second on a long preparation
  (Qt 5.15 `qprogressdialog.cpp`) — so a live change of a small scene does not flash it. Closed from its title bar,
  it stays closed until the next preparation (`setValue` would show it again). A failure in it is logged by type
  only. A flush starts a preparation with one slice; the pump runs the others.
- **A re-sync does not abandon.** Events missed off the main thread (SLC-33) let a running preparation finish and
  ask for another snapshot after it. Abandoning it at each such event could hold a large scene off for ever. A scene
  close among them is the exception (SLC-70, below): it stops the preparation and the pump resets.
- **An abandoned preparation stays owed.** A flush's re-export, or the first snapshot, owes the client nothing, so
  `_abandon` sets `snapshot_needed` while the session runs: a later tick starts it again. A slice condition
  (`_may_continue`) without `snapshot_needed` lets a preparation that a flush started go on.
- **Limits read again.** `prepare_snapshot` checks the session's state and the relay's limits at its first step and
  again at its last, where the session must still be the same one (SLC-68, below).

**One live geometry change, phase by phase** (the owner's report: every change froze Slicer during a session). On
`main`, every change that needs a new snapshot collected and decimated every node again on the main thread, in one
call: about 11 s on the reporter's scene, with Slicer frozen throughout. Measured natively with
`live_change_profile.py`, a local harness that is not committed. It drives the panel with the real transport and the
relay stub, pumps every 50 ms like the adapter, and times only each phase's own steps. Scene: a generated surface (one
segment) and a sphere of 7,936 triangles, `mobile`:

| Change | Until the relay's ack | Longest pump (main thread blocked) | Collect | Decimation | GLB, SHA-256, chunks | Upload |
|---|---|---|---|---|---|---|
| Start session, 15.5M-triangle surface | 6.99 s | 1.06 s (the quadric's step) | 3.01 s | 3.51 s | < 0.01 s | in the worker thread |
| the sphere's mesh replaced (cache: the surface is reused) | 0.12 s | 0.01 s | < 0.01 s | none | < 0.01 s | idem |
| the surface's mesh changed | 6.75 s | 1.05 s | 2.92 s | 3.48 s | < 0.01 s | idem |
| the sphere's mesh replaced, 4.35M surface, uplink throttled to 250 KB/s | 5.86 s | 0.01 s | < 0.01 s | none | < 0.01 s | about 5.6 s, none of it on the main thread |
| the surface's mesh changed, same throttle | 8.40 s | 0.90 s | 0.82 s | 1.61 s | < 0.01 s | idem |

The GLB, its SHA-256 and the chunk frames take milliseconds: the GLB is about 1.2 MB at these budgets. The upload runs
in the transport's worker thread (`RelayTransport.send` only queues a frame with `call_soon_threadsafe`), so it never
holds the main thread. In Slicer that thread gets the GIL from the pump's yield; manual §2 step 16 measured an upload
bound by the bandwidth (5.8 MB at 1 Mbit/s in about 46 s). What blocks the main thread now is one step at a time,
and the longest step is the quadric's run on the changed node. A change to any other node is served from the cache.

## From `ws/slicer`'s SLC-60 (superseded in the merge of 2026-10-30)

`ws/slicer` had built its own preparation in steps meanwhile (`snapshot.ScenePreparation`, SLC-60, `cf5f2b0`: one node
collected per step, one entity fitted per step, the GLB and `begin` in the last step). The steps above replaced it when
`main` was merged into `ws/slicer`; what still applies:

- **The last step near the relay's limit.** Measured in the sandbox in the merge comparison (2026-10-30), three runs
  each of the whole last step of a `quest3` scene of ten 100k-triangle soups — every point unshared, the way to the
  largest GLB when every node is reduced to its share —, a 45.8 MiB quantised GLB: 0.86 s median on `main`, 0.80 s on
  `ws/slicer` (its own note had 1.08 s median, of which `write_glb` 0.95 s, under more load); ten spheres of 99,456
  triangles, 11.4 MiB: 0.14 s and 0.15 s. `begin_snapshot` alone at 64 MiB: 0.29 s median with the chunks encoded;
  SHA-256 over 64 MiB 0.21 s. So the "about 0.2 s for the relay's 64 MiB limit" above, scaled from ordinary meshes
  natively, is ≈ 1–1.5 s for a GLB of that size in this sandbox: the GLB's size, not its triangle count, sets the last
  step (`[TODO verify]` in Slicer: manual §15 step 10).
- **Steps.** For a 1,033,920-triangle sphere and three small nodes `main` takes 60 steps, the longest 3.97–3.98 s (the
  quadric's one VTK call); SLC-60 took 9, the longest 8.1–9.3 s (the whole node's fit). For a 399,616-triangle sphere:
  2.34 s against 2.58 s. Both give the same bytes as the one-call path.
- **A closed scene between two steps.** SLC-60 stopped at the next step once the session's `SceneIds` had been reset
  (a scene closed on the main thread), before it collected, aliased or sent a node of the closed scene, which may be
  another patient's (T7), and refused the last step when the session had dropped, closed or been created again.
  `prepare_snapshot` above relies on its owner instead: `LiveUpdates` abandons the preparation on a reset, a batch,
  a new setting, a gate that closes and — since the merge review — a lost connection (the panel does not tick while
  it reconnects, so a preparation used to stay frozen through the outage and go on after the resume), and a session
  created again gets new live updates. Run alone after `SceneIds.reset()`, `prepare_snapshot` went on and sent the
  closed scene's nodes (merge comparison); a re-sync lets a running preparation finish. Whether every path that
  changes the scene between two steps is guarded in time — also a node removed or hidden meanwhile, which a step
  collects as the adapter reads it (`[TODO verify]` how `MrmlSceneApi` reads a node already removed) — is SLC-68's.
  *SLC-68 (below) gave `prepare_snapshot` both checks back.*
- **Kept from SLC-60's design, not from its code:** no re-listing of the shown nodes in the last step (a node hidden or
  removed during the preparation is in its snapshot until its mark goes out after it), and the GLB written and hashed
  on the main thread in the last step — `main` does the same; both are SLC-68's to revisit if Slicer shows a problem.

## The scene changed between steps (SLC-68)

A preparation spans the event loop, so the scene or the session can change between two of its steps. Probed on
`ws/slicer` after the merge (`9c60565`), for every step position of a preparation of three nodes — a model with a
scripted ID (aliased `m_<n>`), one with a generated ID, a segment — 18 to 36 positions per case. The guard works on
the registry it is given: `LiveUpdates.reset` resets the session's at `EndCloseEvent`; `prepare_snapshot` with
`ids=None` makes its own, which nothing can reset, so an owner that steps it across the event loop passes the
session's. Through the panel every position the pump exposes is tested: the pump that delivers `session.created`
runs two steps, so a close cannot land after the first.

| Change between two steps | Guard | Where | Tests (`pytest slicer-plugin -k "prepar and (closed or session)"`) |
|---|---|---|---|
| Scene closed on the main thread, `EndCloseEvent` alone or in a batch, with `LiveUpdates` | `reset()` abandons the preparation (`Stepper.close()`) before `SceneIds.reset()`, in one call; an empty snapshot clears the closed scene, the next one follows | `live.py` `reset` | `test_live_a_scene_closed_at_any_step_…`, `test_panel_a_scene_closed_at_any_step_…` |
| `SceneIds.reset()` with `prepare_snapshot` driven alone | `SceneIds.generation`, moved by `reset()`, checked after every step of the collection and the fit: `SceneClosedError` before the next read | `snapshot.py` `_same_scene`, `ids.py` | `test_prepare_a_scene_closed_between_any_two_steps_…` |
| A batch (a load, an import) | `hold()` abandons | `live.py` `hold` | `test_live_a_batch_at_any_step_…` |
| *Hide node names* | the switch abandons; the next preparation hides the names | `live.py` `set_anonymize_names` | `test_live_names_hidden_at_any_step_…` |
| Connection lost (grace, resuming) | `observe()` abandons; the panel ticks only while live; alone: the state check at the last step | `live.py` `_observe`, `snapshot.py` `_live_limits` | `test_live_a_connection_lost_at_any_step_…`, `test_panel_a_connection_lost_at_any_step_…`, `test_prepare_a_session_changed_…[dropped, resuming]` |
| Dropped and resumed (the same session) | none needed: its aliases hold, the snapshot begins on it | — | `test_prepare_a_session_dropped_and_resumed_…` |
| Session closed | `observe()` stops the controller; alone: the state check | `live.py`, `snapshot.py` | `test_live_a_session_closed_at_any_step_…`, `test_prepare_…[closed]` |
| Session created again (SLC-45) | the panel stops the old live updates before `session.create` and makes new ones (registry, cache); alone: `session_id` compared at the last step, `ProtocolStateError` | `panel.py`, `snapshot.py` | `test_panel_a_session_created_again_at_any_step_…`, `test_prepare_…[created_again]` |
| Scene closed off the main thread (SLC-70) | the observers call `LiveUpdates.scene_closed_off_thread()`, which moves the generation under a lock; the preparation stops at its next step, or in its last step before its `begin` or the frames of a `begin` built meanwhile — an abandon —, and `LiveUpdates` resets before its next tick or flush classifies, prepares or sends anything, and again after a flush's classification (the panel calls `follow_close()` while it reconnects) | `observers.py` `_on_end_close`, `ids.py` `closed_elsewhere`, `snapshot.py` `_still_open`, `live.py` `_follow_close`, `_advance` | `test_live_…closed_off_thread…`, `test_panel_…closed_off_thread…` (every position; during a mesh read, a fit step, the GLB, the begin; a flush or *Send now* before the next tick; no preparation; the snapshot in flight; while reconnecting), `test_prepare_a_scene_closed_off_thread_…`, `test_observers_an_end_close_off_thread_…` |
| A segmentation removed while it is prepared; a segment removed before its step, read by the real adapter (SLC-71) | the whole-node mark is kept with the preparation and resolved again against its scene once it begins, so its segments leave the viewers after the ack; `_segment_props` asks no per-segment getter about a segment `GetSegment` no longer has (it reads as hidden, without a mesh) | `live.py` `mark_held_segments`, `_advance`; `mrml_scene.py` `_segment_props` | `test_live_a_segmentation_removed_at_any_step_…`, `test_panel_a_node_removed_or_hidden_while_preparing_…`, `test_mrml_scene_a_segment_removed_while_preparing_…` |
| A model or segment removed or hidden | each goes out as it was at its step; its mark after the ack makes the viewers match (22 cases) | `live.py` marks | `test_panel_a_node_removed_or_hidden_while_preparing_…` |

Before SLC-68, `prepare_snapshot` driven alone with `SceneIds.reset()` between two steps went on: at every one of the 36
positions it began version 1 with the closed scene's nodes and their "Doe…" names; up to position 32 it also read closed
handles after the reset, and up to position 22 it gave one of them a new alias. Across a session created again it began
on the other session with the old session's aliases (SLC-60's check had been lost in the merge). Its owners never did
that — `LiveUpdates` abandons first — but a second owner (SLC-19's self-test, a script) would have.

**Why every step, not every node.** A check per node in `collect_steps` (tried first) misses a close in the middle of a
node — its name is still read after the close — and a close once the last node has started: positions 23–36 of 36 still
began version 1. `_same_scene` wraps the collection and the fit, checks after every resumed step, and closes the inner
steps when it stops or is closed. The generation is read at the first step, not when the steps are made.

**What remains** (rule 8 defaults, not blocking):

- A reset fired from inside a step (a read that fires an MRML event; no such Slicer path seen): the step finishes its
  reads after `ids.reset()` and may give a closed node an alias. Nothing of it is sent, but that alias stays in the
  registry until the next close: a node of the next scene with the same raw ID would take it — an alias no viewer
  has seen, so §7.3 holds. The same step may also leave a skipped node's entry (no name, no mesh) in the session's
  cache, which the next collection drops (`keep_only`).
- A snapshot begun before *Hide node names* still carries the names: it is no longer a preparation. The switch cannot
  be reached from the UI until SLC-18.
- The owner contract: `observe()` follows every client event. A controller not observed across a re-create (never
  the panel) would have its last step refused, then prepare again on the new session with the old aliases.
- No re-listing of the shown nodes in the last step (SLC-60's design, kept): a node hidden or removed meanwhile is in
  the snapshot until its mark goes out after the ack (manual §15 steps 9 and 12; SLC-71 for segmentations). A node
  hidden before its own step goes out with `visible: false` and its mesh, though the adapter leaves a hidden node out
  of a listing (`mrml_scene.py`, SLC-22): the snapshot still shows nothing hidden; whether to drop it there is the
  owner's choice (rule 8, default kept).

## A scene closed off the main thread (SLC-70)

The observers record events off the main thread and touch neither MRML nor the live updates there (SLC-33); the pump
then asks for a re-sync, which lets a running preparation finish. For a scene close that was not enough: probed, the
preparation began the closed scene's snapshot with its names, gave a new alias to one of its nodes after the close
and, with the registry never reset, reused `m_1` for the next patient's node. SLC-70 makes the close count:

- `SceneWatcher._on_end_close` on another thread calls the sink's `scene_closed_off_thread()` — its one method safe
  off the main thread: it moves `SceneIds.generation` under a lock (`closed_elsewhere`) and nothing else — and sets
  the missed-events flag as before.
- A preparation under way stops at its next step boundary (SLC-68's check). The last step has no next boundary, so
  `prepare_snapshot` checks again before the `scene.nodeAdded` hint and before `begin_snapshot` (the GLB's write,
  ≈ 1 s near the relay's limit, is the longest step) — before any version is used when the close comes before the
  hint, otherwise the hint's version is a gap, never sent (§8.4) — and `LiveUpdates._advance` checks once more before
  it hands over the frames of a snapshot whose `begin` was built meanwhile: it is superseded by the reset's, never
  sent. A read that raises once the close has finished (an orphaned handle) counts the same. Each is an abandon —
  nothing sent, no error line, the snapshot still owed. `Clear` removes every node before its `EndCloseEvent`, so a
  read that breaks while it still runs is a failure by type (one `live:` line, a FAILED event and the back-off),
  and the reset follows at the next tick: nothing of the closed scene goes out either way. The step during which the
  close finished runs to its end, as a reset fired from inside a step does (SLC-68's leftovers).
- `LiveUpdates` follows the moved generation itself (`_seen_generation`): its next tick or flush — the flush timer,
  *Send now*, a send-mode change, the end of a batch — runs `reset()` before anything is classified, prepared or sent,
  so no update addresses the closed scene's IDs and no alias of it goes to the next scene's node with the same raw ID
  (the review of SLC-70 found both with a flush between the close and the next pump). A close that finishes while a
  flush is classified is followed before the result goes out. The reset is the one of a close on the main thread: the
  closed scene's queued chunks dropped, the aliases forgotten, an empty snapshot first when the next scene takes more
  than one slice — built with a registry of its own, which no close stops: it names nothing. While the panel
  reconnects (no tick) its pump calls `follow_close()`: `reset_owed` at once, as for a close offline on the main
  thread.

**Can a close come off the main thread at all?** Read in Slicer v5.12.4's sources (tag commit `4e21c19`): no core
path does it, so SLC-70 guards against extensions and user scripts only.

- `vtkMRMLScene::Clear` is the only code that enters and leaves `CloseState`
  ([vtkMRMLScene.cxx#L349-L389](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/Core/vtkMRMLScene.cxx#L349-L389));
  `EndState` invokes `EndCloseEvent` inline
  ([#L747-L773](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/Core/vtkMRMLScene.cxx#L747-L773)), and VTK
  runs the observers inline on the calling thread
  ([vtkObject.cxx#L834-L841](https://github.com/Slicer/VTK/blob/c9cd17a377cbc7e488329e882a35b70c7f37fe76/Common/Core/vtkObject.cxx#L834-L841),
  the VTK fork the tag pins); `vtkEventBroker` is synchronous by default
  ([vtkEventBroker.cxx#L97](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/Core/vtkEventBroker.cxx#L97)).
  So the event comes on whichever thread calls `Clear`.
- The callers on the main scene are main-thread code: *File → Close Scene* is a slot of the main window
  ([qSlicerMainWindow.cxx#L985-L998](https://github.com/Slicer/Slicer/blob/v5.12.4/Base/QTApp/qSlicerMainWindow.cxx#L985-L998));
  a scene load with *clear* and an MRB or DICOM scene bundle go through `vtkMRMLScene::Connect`, which runs `Clear(0)`
  inside a batch ([#L789-L825](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/Core/vtkMRMLScene.cxx#L789-L825));
  the WebServer's `DELETE /mrml` is served from a `QSocketNotifier`
  ([SlicerRequestHandler.py#L778-L787](https://github.com/Slicer/Slicer/blob/v5.12.4/Modules/Scripted/WebServer/WebServerLib/SlicerRequestHandler.py#L778-L787));
  the scene's own teardown at exit runs on the main thread; the rest are tests' `setUp`.
- Slicer's two worker threads (`vtkSlicerApplicationLogic`'s processing and networking threads,
  [vtkSlicerApplicationLogic.cxx#L159-L199](https://github.com/Slicer/Slicer/blob/v5.12.4/Base/Logic/vtkSlicerApplicationLogic.cxx#L159-L199))
  never clear the main scene, and send their MRML events back to the main thread
  ([vtkSlicerCLIModuleLogic.cxx#L1163-L1175](https://github.com/Slicer/Slicer/blob/v5.12.4/Base/Logic/vtkSlicerCLIModuleLogic.cxx#L1163-L1175)).
- Nothing in `vtkMRMLScene` checks the thread: an extension or a user script that calls `Clear` from a worker thread
  (unsupported) fires `EndCloseEvent` there. Slicer's documentation at the tag says nowhere that MRML is main-thread
  only; the code assumes it. `[TODO verify]` third-party extensions (not audited) and, in Slicer, that a
  `threading.Thread` calling `slicer.mrmlScene.Clear(0)` reaches `_on_end_close` off the main thread — not a manual
  step: it is unsupported and may crash Slicer.

## Nodes removed while the scene is prepared (SLC-71)

The collection lists the shown nodes in its first step and reads each handle at its own step (the alias, the world
matrix, the display properties, the mesh, the name), so a node removed or hidden meanwhile is read as it is then; its
mark (the observers', on the main thread) goes out after the snapshot's ack. Probed through the panel with the real
observers, 22 cases (`ws/slicer` at `9c60565`): models removed or hidden, and segments removed or hidden, before or
after their step, converge. Two did not:

- **A segmentation node removed** while the snapshot that first carries it is prepared (the first snapshot, or a
  re-export that adds it), after its segments were read: the observers mark it whole (`mark_held_segments`), which
  resolved against the viewers' scene from before this snapshot, so the segments the snapshot carried got no
  `scene.nodeRemoved` and stayed on the viewers. (Removed before its segments are read, a segmentation's segments are
  left out anyway through Slicer's adapter — its display node no longer resolves, read in the sources, below —; a
  segmentation the viewers already hold was removed correctly.) Now the mark is also kept with the preparation and
  resolved again against its scene once it is installed (held until the ack, like every mark made meanwhile). The
  observers' per-node alternative (marking the node's cached segments) was rejected: it issues `s_<n>` aliases to
  segments never exported, scene closes included.
- **A segment removed before its step**, read by the real adapter: Slicer v5.12.4's per-segment display getters log
  the ID of a segment they no longer know with `vtkErrorMacro` — `GetSegmentVisibility`, `GetSegmentVisibility3D` and
  `GetSegmentOpacity3D` ("no display properties"), `GetSegmentColor` ("segment not found by id")
  ([vtkMRMLSegmentationDisplayNode.cxx](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/Core/vtkMRMLSegmentationDisplayNode.cxx),
  lines 397–440, 505–515, 538–548, 637–647), and a removed segment's properties go with it
  (`RemoveUnusedDisplayProperties`, on by default, `vtkMRMLSegmentationDisplayNode.h` line 388); a segment ID may be
  name-derived (T7). `_segment_props` now asks `GetSegment` first, which returns nullptr without a word
  ([vtkSegmentation.cxx](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/vtkSegmentationCore/vtkSegmentation.cxx),
  lines 836–845): the segment reads as hidden, its mesh as none (`GetSegmentRepresentation`, silent too, lines
  1430–1438), and the collection leaves it out as without triangles — the panel's "could not be shared" note until the
  next snapshot.

Read in the sources, not run (`[TODO verify]`, manual §15 steps 9 and 12): after `RemoveNode` a node's references
resolve to nothing (`vtkMRMLNode.cxx` lines 1488–1514), so a removed model reads as hidden at an identity pose with its
old mesh (`vtkMRMLModelNode.cxx` lines 240–258) and a removed segmentation's display node is gone; whether the
per-segment getters' lines reach Slicer's Error Log window and its log file; whether `UpdateNthNodeReference` on a
removed node fires events during a preparation.
