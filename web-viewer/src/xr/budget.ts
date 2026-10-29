// The Quest 2 budget warning (WEB-20; protocol §7.5, NFR-04, NFR-07, US-14): a scene above 500 k triangles, or one
// the presenter did not prepare with the `quest2` profile, may not hold 72 Hz on a Quest 2 — the headset says so
// when XR starts. The count comes from the geometry itself (the manifest's per-node `triangleCount` is optional).

import type { SceneModel } from "../render/scene-model";

/** Total triangles of the `quest2` (and `mobile`) budget, §7.5. */
export const QUEST2_TRIANGLES = 500_000;

/** Triangles the model draws (every node, shown or hidden: a presenter can show them all at once). */
export function triangleCount(model: SceneModel): number {
  let total = 0;
  for (const node of model.nodes.values()) {
    const geometry = node.M.geometry;
    const vertices = geometry.index?.count ?? geometry.getAttribute("position")?.count ?? 0;
    total += Math.floor(vertices / 3);
  }
  return total;
}

/**
 * On a Quest 2: why XR should warn about this scene — above the triangle budget, or (within it) not prepared with the
 * `quest2` profile (§7.5: e.g. `mobile` allows twice the meshes) — or `null`.
 */
export function quest2Concern(model: SceneModel): "triangles" | "profile" | null {
  if (triangleCount(model) > QUEST2_TRIANGLES) return "triangles";
  return model.info.profile === "quest2" ? null : "profile";
}
