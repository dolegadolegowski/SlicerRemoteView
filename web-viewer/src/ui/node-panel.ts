// Node panel (WEB-09): a collapsible list of the scene's structures in manifest order (§7.3) — colour swatch, name and
// a visibility switch that hides or shows the structure on this device only (FR-40, US-09). DOM only: it sets
// `T.visible` and asks the viewer for a frame through `onChange`. Presenter changes (WEB-12) set `T.visible`
// themselves, then call `refresh()`; per FR-40 they replace the local choice.
//
// Privacy: names may contain PHI (§7.3) — they are only ever set as text, never as HTML, and never logged.

import { Color, LinearSRGBColorSpace } from "three";
import { detectLang, t } from "../i18n/strings";
import type { Lang } from "../i18n/strings";
import type { SceneModel, SceneNode } from "../render/scene-model";

export interface NodePanelOptions {
  readonly lang?: Lang;
  /** After a local visibility change: the viewer draws the next frame (`viewer.invalidate`). */
  readonly onChange?: () => void;
  readonly document?: Document;
}

export interface NodePanel {
  readonly element: HTMLElement;
  /** Rebuilds the list for `model` in manifest order; `null` empties it. Keeps the open/closed state. */
  setModel(model: SceneModel | null): void;
  /** Re-reads every node's `T.visible` and colour into the rows (after presenter updates, WEB-12). */
  refresh(): void;
  setOpen(open: boolean): void;
  readonly open: boolean;
  dispose(): void;
}

interface Row {
  readonly node: SceneNode;
  readonly button: HTMLButtonElement;
  readonly swatch: HTMLElement;
}

/** The colour the node is drawn with now (live updates change the material, WEB-12), as a CSS colour. */
function nodeColor(node: SceneNode): string {
  const color = (node.material as { color?: Color }).color;
  return color instanceof Color ? color.getStyle() : swatchColor(node.manifest.color);
}

const SVG = "http://www.w3.org/2000/svg";
let instances = 0;

/** CSS colour of a manifest colour: glTF colour factors are linear, a CSS colour is sRGB (§7.4). */
export function swatchColor(rgb: readonly [number, number, number]): string {
  return new Color().setRGB(rgb[0], rgb[1], rgb[2], LinearSRGBColorSpace).getStyle();
}

/** An eye; its slash is shown by CSS while the structure is hidden. Decorative: the switch state is in ARIA. */
function eyeIcon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "node-panel__eye");
  const shapes: [string, Record<string, string>][] = [
    ["path", { d: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" }],
    ["circle", { cx: "12", cy: "12", r: "3" }],
    ["line", { x1: "3", y1: "3", x2: "21", y2: "21", class: "node-panel__eye-slash" }],
  ];
  for (const [name, attributes] of shapes) {
    const shape = doc.createElementNS(SVG, name);
    for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, value);
    svg.append(shape);
  }
  return svg;
}

export function createNodePanel(options: NodePanelOptions = {}): NodePanel {
  const doc = options.document ?? document;
  const lang = options.lang ?? detectLang();
  const listId = `node-panel-list-${++instances}`;
  let rows: Row[] = [];
  let open = false;

  const element = doc.createElement("section");
  element.className = "node-panel";
  element.setAttribute("aria-label", t(lang, "nodePanel.title"));
  const body = doc.createElement("div");
  body.className = "node-panel__body";
  body.id = listId;
  const showAll = doc.createElement("button");
  showAll.type = "button";
  showAll.className = "node-panel__show-all";
  showAll.textContent = t(lang, "nodePanel.showAll");
  const list = doc.createElement("ul");
  list.className = "node-panel__list";
  const empty = doc.createElement("p");
  empty.className = "node-panel__empty";
  empty.textContent = t(lang, "nodePanel.empty");
  body.append(showAll, list, empty);
  const toggle = doc.createElement("button");
  toggle.type = "button";
  toggle.className = "node-panel__toggle";
  toggle.setAttribute("aria-controls", listId);
  // The list opens above the toggle (bottom-left, within thumb reach); DOM order is the reading order.
  element.append(toggle, body);

  function paintToggle(): void {
    toggle.textContent = t(lang, "nodePanel.toggle", { count: rows.length });
    toggle.setAttribute("aria-expanded", String(open));
    body.hidden = !open;
    element.dataset["open"] = String(open);
  }

  function refresh(): void {
    for (const { node, button, swatch } of rows) {
      const visible = node.T.visible;
      button.setAttribute("aria-checked", String(visible));
      button.dataset["visible"] = String(visible);
      swatch.style.backgroundColor = nodeColor(node);
    }
    // `aria-disabled`, not `disabled`: a disabled button drops the keyboard focus it has right after "Show all".
    showAll.setAttribute("aria-disabled", String(rows.every((row) => row.node.T.visible)));
  }

  const onListClick = (event: Event) => {
    const target = event.target as Element | null;
    const button = target?.closest(".node-panel__row");
    const row = rows.find((r) => r.button === button);
    if (!row) return;
    row.node.T.visible = !row.node.T.visible;
    refresh();
    options.onChange?.();
  };
  const onShowAll = () => {
    if (rows.every((row) => row.node.T.visible)) return;
    for (const { node } of rows) node.T.visible = true;
    refresh();
    options.onChange?.();
  };
  const onToggle = () => setOpen(!open);
  list.addEventListener("click", onListClick);
  showAll.addEventListener("click", onShowAll);
  toggle.addEventListener("click", onToggle);

  function setOpen(next: boolean): void {
    open = next;
    paintToggle();
  }

  function setModel(model: SceneModel | null): void {
    const focused = doc.activeElement as HTMLElement | null;
    const hadFocus = focused !== null && body.contains(focused);
    rows = [];
    const items: HTMLLIElement[] = [];
    for (const node of model?.nodes.values() ?? []) {
      // A switch per structure: the whole 44 px row is the target; its name is the label, `aria-checked` = shown.
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "node-panel__row";
      button.setAttribute("role", "switch");
      button.dataset["nodeId"] = node.nodeId;
      const swatch = doc.createElement("span");
      swatch.className = "node-panel__swatch";
      swatch.setAttribute("aria-hidden", "true");
      const name = doc.createElement("span");
      name.className = "node-panel__name";
      name.dir = "auto"; // a right-to-left name keeps its beginning when the ellipsis cuts it
      // As sent: with "anonymise names" the publisher already replaced it ("Model 3", §7.3).
      name.textContent =
        node.manifest.name.trim() || t(lang, "nodePanel.unnamed", { n: node.order + 1 });
      button.append(swatch, name, eyeIcon(doc));
      const item = doc.createElement("li");
      item.append(button);
      items.push(item);
      rows.push({ node, button, swatch });
    }
    list.replaceChildren(...items);
    empty.hidden = rows.length > 0;
    showAll.hidden = rows.length === 0;
    refresh();
    paintToggle();
    // The focused row was replaced: keep keyboard focus on the same structure (stable nodeId) or on the toggle.
    if (hadFocus && !body.contains(doc.activeElement)) {
      const same = rows.find((row) => row.node.nodeId === focused.dataset["nodeId"]);
      (same?.button ?? toggle).focus();
    }
  }

  setModel(null);
  return {
    element,
    setModel,
    refresh,
    setOpen,
    get open() {
      return open;
    },
    dispose() {
      list.removeEventListener("click", onListClick);
      showAll.removeEventListener("click", onShowAll);
      toggle.removeEventListener("click", onToggle);
      rows = [];
      element.remove();
    },
  };
}
