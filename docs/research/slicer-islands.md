# Remove small islands before decimation (SLC-53)

The owner asked that a model be cleaned of small islands, like the *Islands* effect of Slicer's Segment Editor,
before it is reduced for sending, and only then decimated. Before SLC-53 nothing removed islands: `build_snapshot`
called `fit_to_budget` straight after `collect_scene`, the shares counted every speck, a node within its share was sent
with all of them, and `_reduce_parts` gave the parts below `ISLAND_TRIANGLES` (2,000) a run of their own with twice
their proportional share (SLC-41, so that small pieces are not eaten first). On the reporter's mesh going to 100k
triangles those parts got 24,406 of the 99,999 triangles.

SLC-53 adds the step to the core (`clustering.small_islands`, `decimate.island_mask`, `without_islands`, `fit_entity`,
`fit_to_budget(…, remove_islands=True)`), off by default; SLC-54 adds the panel option (on by default) and the wiring.
The Slicer sources below were read in the v5.12.4 tag (the local copies compared byte for byte with it). Nothing ran
inside Slicer (CLAUDE.md rule 10); the in-Slicer measurement is `docs/testing/slicer.md` §14 (SLC-53 steps).

## What Slicer's Islands effect does

| Fact | Source ([Slicer v5.12.4](https://github.com/Slicer/Slicer/tree/v5.12.4)) | Used as |
|---|---|---|
| *Remove small islands* removes "all islands from the selected segment that are smaller than the specified minimum size" | [SegmentEditorIslandsEffect.py#L55-L59](https://github.com/Slicer/Slicer/blob/v5.12.4/Modules/Loadable/Segmentations/EditorEffects/Python/SegmentEditorEffects/SegmentEditorIslandsEffect.py#L55-L59) | the operation RemoteView mirrors |
| The minimum size is in voxels, 1000 by default; islands of fewer voxels are deleted (spin box and its tooltip; the parameter default `MinimumSize` 1000) | [#L91-L97](https://github.com/Slicer/Slicer/blob/v5.12.4/Modules/Loadable/Segmentations/EditorEffects/Python/SegmentEditorEffects/SegmentEditorIslandsEffect.py#L91-L97), [#L392](https://github.com/Slicer/Slicer/blob/v5.12.4/Modules/Loadable/Segmentations/EditorEffects/Python/SegmentEditorEffects/SegmentEditorIslandsEffect.py#L392) | `SMALL_ISLAND_TRIANGLES` is the triangle count of the smallest 1,000-voxel surface; "fewer than" removes, as in Slicer |
| `REMOVE_SMALL_ISLANDS` runs `splitSegments(minimumSize=…, split=False)` | [#L129-L130](https://github.com/Slicer/Slicer/blob/v5.12.4/Modules/Loadable/Segmentations/EditorEffects/Python/SegmentEditorEffects/SegmentEditorIslandsEffect.py#L129-L130) | — |
| The islands come from `vtkITKIslandMath` with `SetFullyConnected(False)` (face connectivity) and `SetMinimumSize(minimumSize)` | [#L153-L157](https://github.com/Slicer/Slicer/blob/v5.12.4/Modules/Loadable/Segmentations/EditorEffects/Python/SegmentEditorEffects/SegmentEditorIslandsEffect.py#L153-L157) | mesh parts match face-connected islands (below) |
| `vtkITKIslandMath` labels with `itk::ConnectedComponentImageFilter` (`SetFullyConnected`) and drops small labels with `RelabelComponentImageFilter::SetMinimumObjectSize` | [vtkITKIslandMath.cxx#L96-L110](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/vtkITK/vtkITKIslandMath.cxx#L96-L110) | — |
| When no island remains ("for example, all islands are smaller than the minimum size") the selected segment is cleared | [#L230-L247](https://github.com/Slicer/Slicer/blob/v5.12.4/Modules/Loadable/Segmentations/EditorEffects/Python/SegmentEditorEffects/SegmentEditorIslandsEffect.py#L230-L247) | **deliberate deviation**: RemoteView never drops a node (§7.5), so the largest part, and any part as large, always stays |
| Slicer sets the root logger to DEBUG with a handler that posts every record to the application log (Error Log) | [slicerqt.py#L69-L95](https://github.com/Slicer/Slicer/blob/v5.12.4/Base/Python/slicerqt.py#L69-L95) | the `Islands: …` INFO line reaches the Error Log; whether the Python console shows INFO is `[TODO verify]` (§14 step 7) |

## From voxels to triangles

Slicer's default closed-surface conversion,
[vtkBinaryLabelmapToClosedSurfaceConversionRule.cxx](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/vtkSegmentationCore/vtkBinaryLabelmapToClosedSurfaceConversionRule.cxx):

- defaults ([#L72-L101](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/vtkSegmentationCore/vtkBinaryLabelmapToClosedSurfaceConversionRule.cxx#L72-L101)):
  decimation factor 0.0, smoothing factor 0.5, surface normals 1, conversion method flying edges, surface-nets
  internal smoothing 0, joint smoothing 0;
- a labelmap with non-background border voxels is padded by one voxel
  ([#L279-L304](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/vtkSegmentationCore/vtkBinaryLabelmapToClosedSurfaceConversionRule.cxx#L279-L304));
- `vtkDiscreteFlyingEdges3D` with gradients and normals off
  ([#L328-L352](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/vtkSegmentationCore/vtkBinaryLabelmapToClosedSurfaceConversionRule.cxx#L328-L352));
- `vtkDecimatePro` only when the decimation factor is above 0
  ([#L413-L425](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/vtkSegmentationCore/vtkBinaryLabelmapToClosedSurfaceConversionRule.cxx#L413-L425));
- `vtkWindowedSincPolyDataFilter` with passband 10^(−4s) and `int(20 + 40s)` iterations for smoothing factor s,
  boundary and feature-edge smoothing off, non-manifold smoothing on
  ([#L427-L455](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/vtkSegmentationCore/vtkBinaryLabelmapToClosedSurfaceConversionRule.cxx#L427-L455));
- `vtkPolyDataNormals` with `ConsistencyOn` and `SplittingOff`
  ([#L467-L478](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/vtkSegmentationCore/vtkBinaryLabelmapToClosedSurfaceConversionRule.cxx#L467-L478)).

Smoothing moves points and adds or removes no triangle; decimation does. Measured with a replica of this conversion
built from the source (a local script, not committed: flying edges, windowed sinc with 40 iterations and passband
0.01, normals as above), followed by RemoteView's collect:

| 1,000-voxel island | Triangles after collect |
|---|---|
| 10 × 10 × 10 cube | **1,196** |
| ball | 1,448 |
| boxes 5 × 10 × 20 / 5 × 8 × 25 | 1,396 / 1,456 |
| random compact (Eden) clusters | 2,920-3,012 (2-4 parts: inner cavities) |
| plates 2 × 20 × 25 / 1 × 25 × 40 | 2,356 / 4,256 |
| random worms | 6,264-6,444 |
| rod 1 × 1 × 1000 | 6,040 (8,000 before collect drops the triangles without area) |

- An annealing search (4 × 600 voxel moves) found no 1,000-voxel island below 1,196 triangles.
- Smoothing factors 0, 0.5 and 1.0 leave the counts unchanged. Decimation factors 0.3 and 0.8 give the ball 1,012 and
  288 triangles, the cube 836 and 238.
- Surface nets: cube 1,200, ball 1,452, Eden 2,984.
- Balls: triangles ≈ 14.4 · V^(2/3) for V from 27 to 27,000 voxels.
- One voxel gives 8 triangles. Two face-adjacent voxels give one part of 16. Voxels that touch only along an edge or at
  a corner give two parts of 8: flying edges separates them, so the parts of the mesh are Slicer's face-connected
  islands (`FullyConnected` off; `test_islands_labelmap_specks_match_face_connectivity`).

So a part with fewer than 1,196 triangles has fewer than 1,000 voxels under the default conversion: the rule never
removes an island that Slicer's default keeps. For a segment shown with a decimation factor above 0, more voxels fit
under 1,196 triangles (factor 0.3: compact islands of about 1,700 voxels; 0.8: about 11,000), and for a model (STL,
OBJ) the count says nothing about volume (risks below).

## The rule

A **part** is connected through shared vertex IDs and through vertices at exactly the same position, whatever their
normals. A part is a **small island** when it has fewer than `SMALL_ISLAND_TRIANGLES` = 1,196 triangles **and** fewer
than `SMALL_ISLAND_SHARE` = 1 % of the triangles of its node's largest part. With a share ≤ 1 the largest part, and any
part tied with it, is never an island, so no node loses everything.

- The 1 % guard: with the minimum alone (and the largest part kept) a node of 8 electrode-contact-like parts lost 7
  of them; with the guard all stay, and next to a 50k-triangle body parts of 600 triangles stay while parts of 400 go.
  On the reporter's mesh (1 % of 10.49M = 104,863) and the synthetic mesh it changes nothing. The largest part is
  measured with its position joins, so the charts of an unwelded model count as one part (§ Connectivity, step 4).
- Where: in `fit_to_budget`, before `allocate`, on every node (models and segments, also those within their share),
  when `remove_islands` is on; the shares then follow the triangles left. `island_mask` and `fit_entity` are the
  per-node steps for SLC-28. A node above its share is decimated from an entity that shares the input's positions and
  normals and has only the kept triangles (`without_islands(…, compact=False)`); every entity `fit_to_budget` returns
  is compact, so no vertex of a removed island reaches the GLB.
- Log: one INFO line per node that loses islands, counts only (T7); INFO, not WARNING, as this is the expected
  behaviour. On the reporter's node:
  `Islands: 14453 small islands (661624 of 16116404 triangles) are left out of a node`.
- Cavities: a small closed inner surface (a pore) is a part like any other and is removed. On the reporter's mesh 6,036
  of the 14,453 small parts enclose a negative volume (226,225 triangles), 7,639 a positive one and 778 none. They are
  invisible behind an opaque surface. Telling them apart needs a signed volume per part, which means nothing for open
  parts and is unreliable for models with arbitrary winding. Slicer's effect works on the labelmap and keeps background
  holes, so with an opacity below 1 small inner bubbles that Slicer shows are not sent.

## Connectivity

Vertex IDs alone are not enough: a `vtkCubeSource` has 24 points (6 parts by IDs), an STL read without merging is one
part per triangle, and the two layers of a double-sided sheet share positions under other IDs. `coincident_pairs` joins
coincident vertices only when their normals agree (SLC-41: the layers of a double-sided sheet must stay apart for the
clustering), so it cannot be reused. `small_islands`:

1. parts by vertex IDs: `components` on two edges per triangle (`t0–t1`, `t1–t2` connect all three);
2. if no part is below `minimum`, nothing is an island (merging only makes parts larger);
3. `position_keys` (the 64-bit splitmix hash of the coordinate bits that `coincident_pairs` also uses, `-0.0` = `0.0`);
4. the vertices to compare:
   - every vertex when `share` × the largest part by vertex IDs is below `minimum` (a largest part below 119,600
     triangles): the threshold then follows the largest part, which joins between two parts above the minimum can
     make larger (the charts of an unwelded model, a body touched by a larger loose piece);
   - otherwise the threshold is `minimum` whatever the joins, and only joins that touch a small part matter: a table
     of 2^`PREFIX_BITS` booleans (24 bits, 16 MiB) marks the key prefixes of the small parts' vertices, and only the
     vertices whose prefix is marked are compared (532,616 of 8,089,163 on the reporter's mesh);
5. `_same_position` orders them by key with `_key_order` — four stable argsorts of 16 bits each, which numpy runs as
   radix sorts, so the order is that of one stable argsort at a fifth of its cost on 8M keys — pairs each vertex of a
   key group with the group's first, and keeps the pairs whose positions are exactly equal (one axis at a time);
6. the parts these pairs join are merged with `components` on their roots, and counted again with `bincount`.

The result equals a reference that uses every coincident pair and all three edges of every triangle with the SLC-41
union-find, also with a 1-bit table (every vertex a candidate), and when the largest part is two grids or eight
sphere charts joined only by position — `tests/test_islands.py`. The review's random scenes (grids, unwelded seams,
soups, double-sided sheets, specks; 1,800 scenes, minimum and share varied, 24-, 8- and 1-bit tables; scratch scripts,
not committed) match the reference everywhere; the reviewed version, which always used the table, kept extra specks
in 24 of them, all with a largest part made of charts joined only by position. A 64-bit hash collision inside a key
group could miss a coincidence (about 1e-8 per export, as for `coincident_pairs`); the piece would then count as
separate.

`coincident_pairs` (SLC-41) now hands its repeated keys to `_same_position` too: the same pairs in the same order
(compared with SLC-41's on 300 random scenes, soups and the reporter's mesh), 10.9 s → 6.8 s on an 8M-triangle soup,
0.5 s on the reporter's mesh as before.

`components` itself got faster: its first round needs no gather (the parents are the identity), and the edges left are
taken by index after one scan, so a round that drops none copies nothing. Same roots (random graphs with self-loops and
repeated edges); on two edges per triangle of a sphere it peaks at 22 bytes per edge instead of 53. It also speeds up
`cluster_connected` and `_weld_float32`.

## Measured

Natively: Apple M3 Ultra (arm64), Python 3.12.15, numpy 2.5.4, VTK 9.6.2 wheel; Slicer was not launched. The owner's
data (the 16,116,404-triangle entity collect made of the reporter's segmentation, 8,089,163 vertices) was used locally
for counts, timings and memory only. The synthetic mesh is a generated porous surface with specks (19,670,693
triangles).

Parts of the reporter's mesh:

- 14,821 parts by vertex IDs, 14,559 by IDs and positions (20,763 vertices share a position with an earlier one; 1,069
  joins between parts); the largest part has 10,486,288 triangles, the second 3,979,724;
- below 1,000 triangles: 14,422 parts with 627,828 triangles; below 1,196: **14,453 parts with 661,624 triangles
  (4.1 %)**; below 3,000: 14,512 with 767,992;
- of the parts below 3,000 triangles, every one that encloses a positive volume holds fewer than 1,000 voxels
  (0.075 mm voxels): 7,586 below 100, 73 at 100-500, 9 at 500-1,000;
- the synthetic mesh: 28,460 islands with 194,377 triangles.

The island step (`island_mask`; in brackets the reviewed version, which always used the prefix table and a stable
argsort):

| Input | Time | Temporaries (tracemalloc) |
|---|---|---|
| reporter's mesh (532,616 vertices compared) | 0.56-0.67 s (0.54-0.69 s): `components` 0.35-0.43, labels and `bincount` 0.05, keys and prefix table 0.09, pairs 0.02, merge 0.06 | 1.28 GiB (the entity is 0.63 GiB) |
| synthetic mesh | 0.65-0.81 s (0.60-0.75 s) | 1.60 GiB |
| 200 nodes of 3,088 triangles (every vertex compared) | 0.027 s in all (0.036-0.055 s) | — |
| 117 nodes of a 79,200-triangle sphere and 30 specks each (every vertex compared) | 0.27 s in all (0.22-0.23 s) | — |
| 1,996,000-triangle sphere and 20,000 unwelded specks (the test) | 0.14 s (0.28 s) | 0.18 GiB |
| dust: 12 % of 260³ random voxels through flying edges, 16,438,616 triangles in 1.33M parts of at most 216 (every vertex compared) | 0.93-0.95 s (3.1 s) | 1.24 GiB |
| soup of 2,316,000 triangles, 6.9M vertices | 0.82-0.86 s (2.3-2.4 s) | 0.59 GiB (0.85) |
| soup of 8,312,000 triangles, 24.9M vertices | 3.6-3.7 s (11.1 s) | 2.12 GiB (3.05) |

The reference (every pair, three edges) takes 1.0-1.2 s for the reporter's 14,453 islands. `components` on two edges
per triangle: 0.52-0.56 s → 0.32 s (16.1M triangles), 0.64-0.67 s → 0.35-0.42 s (19.7M). The working entity for the
decimation costs 0.15 s uncompacted, 0.37 s compacted. `_key_order` orders 8M random keys in 0.29 s and 25M in 1.29 s
(a stable argsort: 1.64 s and 8.71 s); on the 8.3M-triangle soup the positions compared one axis at a time take
0.61 s instead of 1.43 s. `fit_to_budget` to `mobile` on the worst cases: dust 2.71 s with islands off, 3.87 s on (the
reviewed version 6.10 s on); the 8.3M-triangle soup 11.94 s off, 16.60 s on (the reviewed version 16.69 s and 28.86 s;
off is faster by `coincident_pairs`' new order), peak `ru_maxrss` 7.38 and 7.71 GiB (8.60 and 9.20).

The whole native flow (read the surface, collect, `fit_to_budget` to `mobile`):

| Flow | `fit_to_budget` | Peak footprint | `ru_maxrss` |
|---|---|---|---|
| reporter's mesh, before SLC-53 | 4.16-4.39 s | 7.08-7.11 GiB | 7.11-7.14 GiB |
| reporter's mesh, SLC-53, islands off | 3.96 s | 7.09 GiB | — |
| reporter's mesh, islands on | 4.50-4.51 s | 7.11-7.12 GiB | 7.14-7.15 GiB |
| reporter's mesh, after the review, islands off | 3.75-3.76 s | 7.07 GiB | 7.10-7.11 GiB |
| reporter's mesh, after the review, islands on | 4.32-4.34 s | 7.09-7.10 GiB | 7.12-7.13 GiB |
| reporter's mesh, islands on, compacted working copy (rejected) | — | 7.45-7.46 GiB | — |
| reporter's mesh, islands on, triangle-hooking `components` (rejected) | — | 7.24 GiB | — |
| synthetic, before SLC-53 | 5.02-5.16 s | 9.25-9.26 GiB | — |
| synthetic, SLC-53, islands off | 4.75 s | 8.92 GiB | — |
| synthetic, islands on | 5.26-5.46 s | 9.12-9.13 GiB | — |
| synthetic, after the review, islands off | 4.45 s | 8.94 GiB | 8.97 GiB |
| synthetic, after the review, islands on | 5.08-5.12 s | 9.10 GiB | 9.14 GiB |

The mesh sent for the reporter's scene (100k triangles):

| | Islands off | Islands on |
|---|---|---|
| parts | 1,523 | 851 |
| parts below 100 triangles | 1,494 (14,543 triangles) | 821 (7,899) |
| the two largest parts | 53,598 and 19,864 triangles | 58,148 and 21,540 |
| quadric shares: large parts / parts below 2,000 | 75,594 / 24,406 | 82,024 / 17,977 |

Decimating the largest part alone (one part of 10,486,288 triangles) to 100k gives 890 parts, 888 of them below 100
triangles: most specks left in the sent mesh are made by the decimation (thin walls), not islands of the input.

## Rejected alternatives

- A higher minimum: the rule already removes 14,453 of the 14,512 parts below 3,000 triangles on the reporter's mesh,
  and every one of those with a volume has fewer than 1,000 voxels, so a higher number would be safe there; but compact
  islands of 1,000-4,000 voxels elsewhere would be removed although Slicer keeps them.
- The absolute minimum without the 1 % guard: small nodes made of similar parts (contacts, letters) lose all but one.
- Only nodes above their share: a node within its share would still send its specks.
- `coincident_pairs` as the position join: a double-sided sheet stays two parts (normals opposite).
- Sorting every key instead of the prefix table: 0.38 s against 0.10 s.
- The prefix table also when the largest part sets the threshold (the reviewed version): a largest part made of
  charts joined only by position was measured as its largest chart, so specks the rule removes were sent. Documenting
  that approximation instead: exactness costs nothing on the reporter's mesh and about 0.4 ms per 80k-triangle node.
- A stable argsort of the candidates' keys (the reviewed version): 1.64 s on 8M keys against 0.29 s for `_key_order`;
  the island step took 3.1 s on 16.4M triangles of dust and 11.1 s on an 8.3M-triangle soup.
- A default (unstable) argsort: 0.60 s on 8M keys, and the first vertex of a key group would depend on the sort.
- `np.sort` of the candidates' keys first and an argsort of the repeated ones only (the `coincident_pairs` pattern,
  the review's prototype): fast on dust, where few keys repeat, but a soup repeats every key and pays the extra sort;
  `_key_order` needs no filter.
- One `np.sort` of the key's high bits packed with the vertex ID (0.21 s on 8M keys): distinct keys with equal high
  bits need a second, exact pass.
- Merging the joined roots on their own (marked, `components` on the marked roots only, the sizes added per root):
  0.02 s instead of 0.06 s on the reporter's mesh, slower on soups, and the count needs a correction for parts with
  several roots.
- `part_sizes`-style labelling (three edges, `np.unique`): 1.01 s; `vtkPolyDataConnectivityFilter`: 1.73 s, and it
  joins no positions.
- Triangle-hooking `components`: 0.39-0.49 s, but +0.16 GiB peak.
- A compacted working entity for the decimation: +0.33-0.35 GiB peak (the indices copy `decimate_entity` made was
  removed instead, so the uncompacted entity's indices take its place).
- Telling cavities apart by signed volume: see § The rule.

## Risks

- With the option on, a real small structure in the same node as a large body is not sent: 1,000 voxels at 1 mm is
  about 1 cm³ (a 12 mm ball), so a small lesion or SEEG contacts segmented together with a large structure vanish
  unless they reach 1 % of the largest part. Mitigations: the checkbox text and tooltip (SLC-54), the INFO line, a panel
  note (follow-up).
- The triangle threshold depends on the tessellation (decimation factor above 0 in *Show 3D*; models from files).
- Small closed cavities are removed: invisible at opacity 1, missing at opacity below 1.
- Memory parity is partly allocator-dependent (the island step holds about twice the entity in temporaries); the peak
  inside Slicer must stay at SLC-41's 12.2 GiB (§14 step 6).
- Time: about 0.6 s natively on the reporter's mesh and an estimated 0.9-1.0 s under Rosetta, on the main thread until
  SLC-28; the faster `components` offsets most of it inside `fit_to_budget`. The cost grows with the vertices
  compared, so the worst cases are nodes where every vertex is: about 1 s for 16.4M triangles of dust and 3.7 s for an
  8.3M-triangle soup (24.9M vertices), next to decimations of 2.7 s and 11.9 s there; on soups the faster
  `coincident_pairs` pays it back (the 8.3M-triangle soup: 16.69 s with islands off before the review, 16.60 s now
  with islands on).
- The `components` rewrite is on every large mesh's decimation path: same roots (random-graph test), and the SLC-41
  suites pass unchanged.
- The uncompacted working entity breaks the "every vertex is used" invariant inside `fit_entity`; the tests check that
  every returned entity is compact.
- About 850 decimation-made fragments of thin walls remain in the reporter's sent mesh (half of the 1,523 parts).

## Follow-ups

- A panel note after each snapshot ("N small islands were not sent") from `FitResult.cleaned`; in SLC-18 a per-node
  opt-out in the node list.
- Scale the minimum for segments whose conversion uses a decimation factor above 0 (the segmentation's *Decimation
  factor* conversion parameter, `[TODO verify]` `vtkSegmentation.GetConversionParameter` in 5.12).
- Keep cavities (signed volume per part) if the owner shows bone with an opacity below 1.
- The specks made by the decimation: on the reporter's mesh 43,625 of the size-bounded mesh's triangles are in parts
  below 2,000 even after island removal, and they get the island share (17,977 of 100k) — the rescue and
  `ISLAND_BOOST` for parts the bound creates, or a post-pass, measured against thin-wall erosion.
- `part_sizes` could use two edges per triangle and `bincount` like `small_islands`.
- The user guides and architecture §6 step 4 should mention the island step and the checkbox (`release`).
