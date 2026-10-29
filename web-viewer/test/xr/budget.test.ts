import { describe, expect, it } from "vitest";
import { BufferAttribute, BufferGeometry, Mesh } from "three";
import type { SceneModel, SceneNode } from "../../src/render/scene-model";
import { QUEST2_TRIANGLES, quest2Concern, triangleCount } from "../../src/xr/budget";

/** A model whose nodes have these triangle counts (indexed or not) and this publisher profile. */
function model(profile: string | null, ...triangles: number[]): SceneModel {
  const nodes = new Map<string, SceneNode>();
  triangles.forEach((count, i) => {
    const geometry = new BufferGeometry();
    if (i % 2 === 0) geometry.setIndex(new BufferAttribute(new Uint32Array(count * 3), 1));
    else geometry.setAttribute("position", new BufferAttribute(new Float32Array(count * 9), 3));
    nodes.set(`n${i}`, { M: new Mesh(geometry) } as unknown as SceneNode);
  });
  return {
    nodes,
    info: { profile, sceneVersion: 1, anonymizedNames: false },
  } as unknown as SceneModel;
}

describe("Quest 2 budget (WEB-20, §7.5)", () => {
  it("counts every node's triangles, indexed or not", () => {
    expect(triangleCount(model("quest2", 10, 20, 30))).toBe(60);
  });

  it("warns above 500 k triangles, or (within them) for a scene not prepared with the quest2 profile", () => {
    expect(QUEST2_TRIANGLES).toBe(500_000);
    expect(quest2Concern(model("quest2", 250_000, 250_000))).toBeNull();
    expect(quest2Concern(model("quest2", 250_000, 250_001))).toBe("triangles");
    expect(quest2Concern(model("mobile", 600_000))).toBe("triangles"); // the stronger reason wins
    expect(quest2Concern(model("mobile", 1_000))).toBe("profile"); // §7.5: up to 120 meshes, Quest 2 holds 60
    expect(quest2Concern(model(null, 1_000))).toBe("profile");
  });
});
