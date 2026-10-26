# Baking a node's world transform into its vertices (SLC-13)

What `remoteview_core.collect` does with a model whose world transform cannot be a glTF `node.matrix`, and the Slicer
and VTK sources it relies on. Checked against Slicer v5.12.4 and VTK v9.6.0 (the dev venv runs VTK 9.6.2).

## When the transform is baked

| Case | `world_matrix(node)` | What collect does |
|---|---|---|
| no parent transform | identity | no `T.matrix` |
| linear chain, TRS in float64 and float32 | the 4×4 | `T.matrix = C·M·C⁻¹` (protocol §7.2, SLC-05) |
| linear chain with shear, zero scale or a float32 overflow (`glb_writer.is_exportable_matrix` false) | the 4×4 | bake that matrix (a `vtkTransform`) |
| non-linear chain (thin-plate spline, grid, B-spline, or any chain containing one) | `None` | bake `world_transform(node)` |
| non-linear chain, `world_transform` gives no `vtkAbstractTransform` | `None` | skip, `non-linear-transform` |

Baked entities have `baked: true` and an identity `T.matrix` (protocol §7.3). glTF requires `node.matrix` to decompose
into TRS (glTF 2.0 §5.25 / validator `NODE_MATRIX_NON_TRS`), so a sheared matrix is baked like a non-linear chain
(SLC-05 follow-up, report `docs/testing/reports/2026-10-18-slicer-4.md`; §7.3 still names only non-linear transforms).

## Sources

| Fact | Source |
|---|---|
| The 3D view, for a non-linear chain, fills a new `vtkGeneralTransform` (after `Identity()`) with `tnode->GetTransformToWorld(worldTransform)` and puts it in a `vtkTransformFilter` on the model's mesh; a linear chain becomes the actor's user matrix instead | [vtkMRMLModelDisplayableManager.cxx#L738-L746](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/DisplayableManager/vtkMRMLModelDisplayableManager.cxx#L738-L746), [#L835-L858](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/DisplayableManager/vtkMRMLModelDisplayableManager.cxx#L835-L858), [#L1254-L1294](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/DisplayableManager/vtkMRMLModelDisplayableManager.cxx#L1254-L1294) |
| `vtkMRMLTransformNode::GetTransformToWorld(vtkGeneralTransform*)`: "Get concatenated transforms to world" (may change the PreMultiply/PostMultiply flag) | [vtkMRMLTransformNode.h#L118-L122](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/Core/vtkMRMLTransformNode.h#L118-L122) |
| `vtkAbstractTransform::TransformPoints(inPts, outPts)` appends the transformed points to `outPts`, which keeps its own data type: a default `vtkPoints` is float, so the output is set to double first (checked: float output rounds `100.123456789 × 1.1` to `110.1358032`) | [vtkAbstractTransform.h#L202-L206](https://github.com/Kitware/VTK/blob/v9.6.0/Common/Transforms/vtkAbstractTransform.h#L202-L206), run |
| `InternalTransformDerivative(in, out, J)` gives the 3×3 Jacobian at a point; it does not call `Update()` (collect calls it first). `vtkGeneralTransform` chains the derivatives of its concatenation | [vtkAbstractTransform.h#L262-L272](https://github.com/Kitware/VTK/blob/v9.6.0/Common/Transforms/vtkAbstractTransform.h#L262-L272), [vtkGeneralTransform.cxx#L105-L160](https://github.com/Kitware/VTK/blob/v9.6.0/Common/Transforms/vtkGeneralTransform.cxx#L105-L160) |
| `vtkPolyDataNormals(ConsistencyOn)` orients each connected part like its lowest-ID cell, not outward | `docs/research/slicer-collect.md` (vtkOrientPolyData.cxx) |

## Orientation and degenerate triangles

- A transform with a negative Jacobian determinant mirrors: every triangle's winding turns over, so the glTF front
  faces (counter-clockwise, `doubleSided: false`) would face inwards and a viewer that culls back faces would show the
  inside. Collect reverses the triangles when the determinant at the centre of the **first** triangle is negative —
  that triangle seeds `ConsistencyOn` (the 3D view does not need this: Slicer's display nodes start with
  `BackfaceCulling = 0`, [vtkMRMLModelDisplayNode.cxx#L58](https://github.com/Slicer/Slicer/blob/v5.12.4/Libs/MRML/Core/vtkMRMLModelDisplayNode.cxx#L58)).
  A transform that mirrors only part of a mesh (a folding warp) cannot be oriented by one sign; such a part may face
  inwards (plan follow-up).
- A triangle without area (collinear corners after the bake, e.g. a zero scale, or already in the data) has no normal
  of its own: as the lowest-ID triangle it seeded `ConsistencyOn` with an arbitrary winding and turned the real
  triangles over (reproduced: a collinear triangle as cell 0 gave the real one a −S normal), and a point only it used got
  a zero normal. It is invisible, so collect drops it (exact zero cross product in float64) before the normals.
- Normals can still cancel out where two sheets lie back to back (a closed model flattened by a bake, two triangles
  folded onto each other): such a point keeps a zero normal, which `coords.ras_to_gltf_normals` turns into glTF +Y, so
  the node is exported like any other.
- A bake that moves vertices beyond float32 (what the GLB stores), or input with inf/NaN coordinates, skips the node
  (`invalid-geometry`); the arithmetic on such coordinates runs under `np.errstate(all="ignore")`, so nothing warns
  (a warning would abort the snapshot where warnings are errors, as in the test suite).
