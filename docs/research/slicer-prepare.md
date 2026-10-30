# Research — preparing the scene in steps (SLC-60)

What `remoteview_core.snapshot.ScenePreparation` relies on, and what one step costs. Measured on 2026-10-29 in the
sandbox (Linux, 4 cores, VTK 9.6.2 wheel, Python 3.12) with the real collection, decimation and GLB writer and the
`FakeScene` of the tests; nothing here ran inside Slicer (CLAUDE.md rule 10). SLC-28 measures the steps in Slicer
(manual §15). Other agents ran decimation experiments on the same machine at the time, so the figures are upper bounds.

## The steps

`build_snapshot` used to collect, decimate, write and hash in one main-thread call. The preparation splits it where
the work is per node, and keeps everything that touches the `ProtocolClient` in the last step:

| Step | Work | Touches the client |
|---|---|---|
| one per node (models, then segments: `collect_scene`'s order) | `collect.Collector.model`/`.segment` — the `seen` set, the names and the session's `SceneIds` carry over | no |
| one per collected entity | `decimate.fit_entity` with the share `allocate` gave it (computed once, at the first of these steps) | no |
| the last | the size checks, `announce_added`, `next_scene_version`, `write_glb`, `begin_snapshot` (SHA-256, chunks) | yes |

The hint (`scene.nodeAdded`) and the snapshot's `begin` take consecutive versions (§8.2, §8.4). Between two ticks an
ack or a resume can release held updates, which take versions too; so the hint, the version in the GLB's root and the
`begin` must come from one step, or the GLB would have to be written again (SLC-38's check refuses a root that names
another version).

## Measured

A `quest3` scene at its full budget: ten spheres of ≈ 100k triangles (shared points), 1,000,000 triangles after the
per-node cap, three runs:

| | Quantised (default) | Not quantised |
|---|---|---|
| GLB size | 11.5 MiB | 17.2 MiB |
| the last step (write, hash, chunks, `begin`) | 0.15 s median, 0.28 s max | 0.13 s median, 0.16 s max |
| the slowest collection step (one 100k-triangle node) | 0.09 s | 0.07 s |
| the slowest fitting step (100,352 → 100,000 triangles) | 0.23 s | 0.21 s |

Near the relay's 64 MiB limit — reachable with unshared points (a triangle soup) when every node is reduced to its
share, or with nodes the filters cannot reduce — three runs of the whole last step on `quest3` scenes of 100k-triangle
soups (SLC-60 review):

| | Quantised: 10 soups, 45.8 MiB | Not quantised: 7 soups, 56.1 MiB |
|---|---|---|
| the last step | 1.08 s median, 1.32 s max | 0.66 s median, 0.70 s max |
| of which `write_glb` | 0.95 s median | 0.46 s median |

`begin_snapshot` alone at 64 MiB: 0.29 s median, 0.37 s max with the chunks encoded; 0.10 s for 32 MiB. SHA-256 over
64 MiB: 0.21 s; with the copy `build_snapshot_messages` makes: 0.28 s.

## Decision

The SHA-256 and the chunking stay in the last step, though they take more than the 0.25 s the SLC-60 row set as the
point to move them (0.29 s for a 64 MiB GLB). Near the limit they are ≈ 0.13 s of a ≈ 1.1 s step quantised and ≈ 0.2 s
of a ≈ 0.7 s step not (10–30 %); the rest is writing the GLB, and the GLB names the version, so it cannot move to an
earlier step without being written again whenever an ack or a resume moves the version (above). A step of their own
would save ≈ 0.1–0.2 s. What would shorten the longest step is writing and hashing off the main thread, or writing with
the expected version and again only when it moved: left to SLC-28, which measures the steps in Slicer (manual §15, with
a scene near the limit). For a full `quest3` budget of ordinary meshes the last step is ≈ 0.15 s; a quantised `quest3`
GLB is at most ≈ 46 MiB (1M triangles of unshared points) when every node is reduced to its share; nodes the filters
cannot reduce (sent whole, §7.5; SLC-61) can take it to the 64 MiB check, where the last step would take ≈ 1.5 s (the
measured step scaled to 64 MiB: ≈ 1.3 s `write_glb` plus ≈ 0.2 s for the hash; the chunks are encoded as they are sent).
One node's decimation (minutes for flat or non-manifold input) is SLC-61's; one node's collection (a polygon of a
million points) is SLC-62's.

## Between the steps

The Slicer scene can change between two ticks:

- Closed (`EndCloseEvent` on the main thread): `LiveUpdates.reset` resets the session's `SceneIds` (the one passed as
  `ids`), and the next step raises `SceneChangedError` — its `generation` moved — before it collects, aliases or sends a
  node of the closed scene, which may be another patient's (T7). The owner (SLC-28) cancels on the reset anyway and
  prepares the new scene; a close seen off the main thread only asks for a re-sync (SLC-33), which must cancel the
  preparation too (SLC-28).
- *Hide node names* switched: the preparation keeps the setting it started with, so the owner cancels it and starts
  a new one (SLC-28); a request merged into one more export afterwards would send the names first.
- A node removed: it is collected as it is at its step (`[TODO verify]` how the Slicer adapter reads a node already
  removed from the scene — SLC-28, manual §15); its removal mark, held while the preparation runs (SLC-28), goes out
  after the snapshot as `scene.nodeRemoved`. Until then the viewers see it, as they see a node hidden meanwhile; SLC-28
  may re-list the shown nodes in the last step (the lists only) to leave such nodes out.
- The session dropped, closed or created again (SLC-45: another `session_id`, other aliases): the last step refuses
  it with `ProtocolStateError`, before any client call.

A preparation that ended — the last step, `cancel()` or a step that raised — lets go of the scene's handles and the
collected meshes, so an owner may keep it for its `progress`.
