// A short text shown in XR (WEB-20: the Quest 2 budget warning; WEB-23: the status line), where the 2D page cannot be
// seen: drawn on a canvas, shown on a small plane in the scene. `null` where the browser cannot draw text on a canvas.

import { CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from "three";
import { XR_PANEL_NAME } from "./placement";

/** Panel size in metres (readable at about 1 m) and canvas pixels per metre. */
const WIDTH_M = 0.6;
const PX_PER_M = 1600;
const FONT_PX = 44;
const PAD_PX = 40;

/** `word` cut into pieces no wider than `width` pixels: a long node name has no space to break at. */
function cut(context: CanvasRenderingContext2D, word: string, width: number): string[] {
  const pieces: string[] = [];
  let piece = "";
  for (const char of word) {
    if (piece && context.measureText(piece + char).width > width) {
      pieces.push(piece);
      piece = char;
    } else piece += char;
  }
  return piece ? [...pieces, piece] : pieces;
}

/** Splits `text` into lines no wider than `width` pixels in the context's current font. */
function wrap(context: CanvasRenderingContext2D, text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  const words = text
    .split(/\s+/)
    .flatMap((word) =>
      context.measureText(word).width > width ? cut(context, word, width) : [word],
    );
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && context.measureText(next).width > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/** `text` on a plane `WIDTH_M` wide; each `\n` starts a new line. */
export function createTextPanel(text: string, doc: Document = document): Mesh | null {
  const canvas = doc.createElement("canvas");
  canvas.width = WIDTH_M * PX_PER_M;
  const measure = canvas.getContext("2d");
  if (!measure) return null;
  measure.font = `${FONT_PX}px system-ui, sans-serif`;
  const lines = text.split("\n").flatMap((part) => wrap(measure, part, canvas.width - 2 * PAD_PX));
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
  panel.name = XR_PANEL_NAME;
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
