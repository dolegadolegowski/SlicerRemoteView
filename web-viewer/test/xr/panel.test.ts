import { describe, expect, it, vi } from "vitest";
import type { MeshBasicMaterial, PlaneGeometry } from "three";
import { createTextPanel, disposeTextPanel } from "../../src/xr/panel";

/** A document whose canvases have a 2D context that measures 20 px per character. */
function documentWith(context: object | null): Document {
  return {
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
  } as unknown as Document;
}
const context = () => ({
  font: "",
  fillStyle: "",
  textBaseline: "",
  measureText: (text: string) => ({ width: text.length * 20 }),
  fillRect: vi.fn(),
  fillText: vi.fn(),
});

describe("XR text panel (WEB-20)", () => {
  it("wraps the text onto a 0.6 m wide plane whose height follows the lines", () => {
    const c = context();
    const panel = createTextPanel("word ".repeat(30).trim(), documentWith(c))!;
    const lines = c.fillText.mock.calls.map((call) => call[0] as string);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length * 20).toBeLessThanOrEqual(960 - 80);
    expect(lines.join(" ")).toBe("word ".repeat(30).trim());
    const { width, height } = (panel.geometry as PlaneGeometry).parameters;
    expect(width).toBe(0.6);
    expect(height).toBeGreaterThan(0);
    expect((panel.material as MeshBasicMaterial).map).not.toBeNull();
    disposeTextPanel(panel);
  });

  it("is null where the browser cannot draw text on a canvas", () => {
    expect(createTextPanel("x", documentWith(null))).toBeNull();
  });
});
