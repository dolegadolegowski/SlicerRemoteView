// Development-only overlay (WEB-16): what three.js holds on the GPU, refreshed twice a second, so a leak shows while
// working on the viewer. `main.ts` starts it only under `import.meta.env.DEV`, so production builds drop it.

export interface RendererInfo {
  readonly geometries: number;
  readonly textures: number;
}

export function startDevOverlay(
  read: () => RendererInfo | null,
  doc: Document = document,
): () => void {
  const element = doc.createElement("pre");
  element.className = "dev-overlay";
  element.setAttribute("aria-hidden", "true");
  doc.body.append(element);
  const paint = () => {
    const info = read();
    element.textContent = info
      ? `geometries ${info.geometries} · textures ${info.textures}`
      : "no renderer";
  };
  paint();
  const timer = setInterval(paint, 500);
  return () => {
    clearInterval(timer);
    element.remove();
  };
}
