// A short text shown in XR (WEB-20: the Quest 2 budget warning), where the 2D page cannot be seen: drawn on a canvas,
// shown on a small plane in the scene. `null` where the browser cannot draw text on a canvas.

import { CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from "three";

/** Panel size in metres (readable at about 1 m) and canvas pixels per metre. */
const WIDTH_M = 0.6;
const PX_PER_M = 1600;
const FONT_PX = 44;
const PAD_PX = 40;

/** Splits `text` into lines no wider than `width` pixels in the context's current font. */
function wrap(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && context.measureText(next).width > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

export function createTextPanel(text: string, doc: Document = document): Mesh | null {
  const canvas = doc.createElement("canvas");
  canvas.width = WIDTH_M * PX_PER_M;
  const measure = canvas.getContext("2d");
  if (!measure) return null;
  measure.font = `${FONT_PX}px system-ui, sans-serif`;
  const lines = wrap(measure, text, canvas.width - 2 * PAD_PX);
  canvas.height = lines.length * FONT_PX * 1.3 + 2 * PAD_PX; // resizing clears the context's state
  const context = canvas.getContext("2d")!;
  context.fillStyle = "rgba(21, 27, 35, 0.92)"; // --surface
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#ffc857"; // --warn
  context.fillRect(0, 0, 12, canvas.height);
  context.font = `${FONT_PX}px system-ui, sans-serif`;
  context.fillStyle = "#f2f5f8"; // --text
  context.textBaseline = "top";
  lines.forEach((line, i) => context.fillText(line, PAD_PX, PAD_PX + i * FONT_PX * 1.3));
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const panel = new Mesh(
    new PlaneGeometry(WIDTH_M, canvas.height / PX_PER_M),
    new MeshBasicMaterial({ map: texture, transparent: true }),
  );
  panel.name = "SlicerRemoteView XR panel";
  return panel;
}

/** Frees the panel's GPU resources. */
export function disposeTextPanel(panel: Mesh): void {
  panel.geometry.dispose();
  const material = panel.material as MeshBasicMaterial;
  material.map?.dispose();
  material.dispose();
  panel.removeFromParent();
}
