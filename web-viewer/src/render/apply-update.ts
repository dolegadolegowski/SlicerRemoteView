// Applies live changes to the shown scene (WEB-12; docs/protocol.md §7.2, §8.1–8.3): `visible` → `T.visible`,
// `color`/`opacity` → the node's own material, `matrix` → `T.matrix` (glTF space, column-major); `M` keeps its
// dequantisation matrix. Unknown node ids and invalid items are skipped (§8.1).
//
// The presenter's last value of every property is kept per node (from the manifest, then each change). A property
// is applied only when the presenter's value changes: a `scene.state` replayed after a gap or a rejoin repeats
// values already applied and so does not undo what the user chose locally in the node panel. When the presenter
// does change `visible`, that replaces the local choice (FR-40, US-09); the nodes where this happened are returned
// for the notice (WEB-13).

import { LinearSRGBColorSpace } from "three";
import type { Color } from "three";
import { parseChange, parseNodeIds } from "../protocol/scene-versions";
import { applyOpacity } from "./scene-model";
import type { SceneModel } from "./scene-model";

export interface Applied {
  /** Something on screen may have changed: draw a frame, refresh the node panel. */
  readonly changed: boolean;
  /** Nodes were removed: the node panel rebuilds its list. */
  readonly removed: boolean;
  /** Nodes whose local visibility choice a presenter change replaced (FR-40). */
  readonly overridden: readonly string[];
}

export interface LiveScene {
  /** Applies `scene.update.changes` or `scene.state.nodes`. */
  apply(changes: readonly unknown[]): Applied;
  /** Removes `scene.nodeRemoved.nodeIds` or `scene.state.removed`. */
  remove(nodeIds: readonly unknown[]): Applied;
}

interface Presenter {
  visible: boolean;
  color: readonly number[];
  opacity: number;
  matrix: readonly number[];
}

const same = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

export function createLiveScene(model: SceneModel): LiveScene {
  const presenter = new Map<string, Presenter>();
  for (const node of model.nodes.values()) {
    node.T.updateMatrix();
    presenter.set(node.nodeId, {
      visible: node.manifest.visible,
      color: node.manifest.color,
      opacity: node.manifest.opacity,
      matrix: [...node.T.matrix.elements],
    });
  }

  return {
    apply(changes) {
      let changed = false;
      const overridden: string[] = [];
      for (const item of changes) {
        const change = parseChange(item);
        const node = change && model.nodes.get(change.nodeId);
        const p = change && presenter.get(change.nodeId);
        if (!change || !node || !p) continue;
        if (change.visible !== undefined && change.visible !== p.visible) {
          // The user's local choice (different from the presenter's) ends here: from now on the presenter's counts.
          if (node.T.visible !== p.visible) overridden.push(node.nodeId);
          node.T.visible = change.visible;
          p.visible = change.visible;
          changed = true;
        }
        if (change.color && !same(change.color, p.color)) {
          const [r, g, b] = change.color;
          // Factors are linear, like `baseColorFactor` (§7.4); GLTFLoader set the colour the same way.
          (node.material as { color?: Color }).color?.setRGB(r, g, b, LinearSRGBColorSpace);
          p.color = change.color;
          changed = true;
        }
        if (change.opacity !== undefined && change.opacity !== p.opacity) {
          applyOpacity(node, change.opacity);
          p.opacity = change.opacity;
          changed = true;
        }
        if (change.matrix && !same(change.matrix, p.matrix)) {
          // Used as given (a Slicer transform may shear, which position/quaternion/scale cannot hold).
          node.T.matrix.fromArray(change.matrix);
          node.T.matrixAutoUpdate = false;
          node.T.matrixWorldNeedsUpdate = true;
          p.matrix = change.matrix;
          changed = true;
        }
      }
      return { changed, removed: false, overridden };
    },
    remove(nodeIds) {
      let removed = false;
      for (const nodeId of parseNodeIds(nodeIds)) {
        if (!model.removeNode(nodeId)) continue;
        presenter.delete(nodeId);
        removed = true;
      }
      return { changed: removed, removed, overridden: [] };
    },
  };
}
