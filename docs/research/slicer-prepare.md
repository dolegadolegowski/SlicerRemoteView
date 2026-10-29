# Preparing the scene without freezing Slicer (SLC-28, SLC-50, SLC-51)

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
`vtkPolyDataNormals` (0.88 s on 31.4M triangles natively), `vtkTriangleFilter` (long on a polygon of many points:
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
  is over the profile's total and another node's count changed), it is collected again before it is decimated. Only
  the fitted geometry is kept (at most the share, 100k triangles), never the collected mesh: the reporter's node
  would hold about 0.8 GB for the whole session.
- **Lifetime.** One cache per live session (`LiveUpdates`); entries of nodes not exported by the last preparation
  are dropped; a reset (scene closed) clears it. The light reads (name, colour, opacity, visibility, transform) are
  made at every export, as before.

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
  connection, *Hide node names* or a new profile, a re-sync, or a gate that closes (a relay wait) abandon it. It
  then sends nothing and uses no version. The next tick starts again, and the cache makes the restart cheap: only
  nodes that were not finished, or whose stamp changed, are prepared again.
- **No `processEvents`.** The slices run from the pump. Nothing re-enters `LiveUpdates` in the middle of a step,
  which answers the SLC-32 review's concern about a progress dialog that runs `processEvents` during an export.
- **The panel.** "Preparing the scene" with the progress (`Progress`: two units per node, collected and fitted). The
  code is shown from the first tick (SLC-25 follow-up). The adapter shows a non-modal `QProgressDialog` with no
  cancel button (*Stop session* stays in the panel). The dialog only appears once a preparation is long (its
  `minimumDuration`), so a live change of a small scene does not flash it.
