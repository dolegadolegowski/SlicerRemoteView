// Node panel (WEB-09, WEB-13): a collapsible list of the scene's structures in manifest order (§7.3) — colour swatch,
// name, a visibility switch and an opacity slider that change the structure on this device only (FR-40, US-09,
// US-10). DOM only: it sets `T.visible` or the material opacity and asks the viewer for a frame through `onChange`.
// Presenter changes (WEB-12) set them themselves, then call `refresh()`; per FR-40 they replace the local choice.
//
// Privacy: names may contain PHI (§7.3) — they are only ever set as text, never as HTML, and never logged.

import { Color, LinearSRGBColorSpace } from "three";
import { detectLang, t } from "../i18n/strings";
import type { Lang } from "../i18n/strings";
import { applyOpacity } from "../render/scene-model";
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
  readonly opacity: HTMLInputElement;
}

/**
 * Steps of the opacity slider (WEB-13): 1 %. A range input shows its value rounded to the step, so a coarser step
 * would put a presenter's 0.98 at the end stop, where moving the thumb fires no `input`; PageUp/PageDown move 10 %.
 */
const OPACITY_STEP = 0.01;

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
  // Chromium moves the thumb to the touch point on `touchstart`, before a vertical swipe becomes a scroll of the list
  // (`touch-action: pan-y` cannot stop that). When the browser takes the gesture (`pointercancel`) the slider goes
  // back to where it was — unless the presenter has set that opacity meanwhile.
  let touch: {
    readonly pointerId: number;
    readonly row: Row;
    readonly before: number;
    applied: number | null;
  } | null = null;

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

  function paintOpacity(row: Row): void {
    const value = row.node.material.opacity;
    row.opacity.value = String(value);
    row.opacity.setAttribute("aria-valuetext", `${Math.round(value * 100)} %`);
  }

  function refresh(): void {
    // The presenter set the opacity of the row being touched: a later `pointercancel` must not put back the old value.
    if (touch && touch.row.node.material.opacity !== (touch.applied ?? touch.before)) touch = null;
    for (const row of rows) {
      const { node, button, swatch } = row;
      const visible = node.T.visible;
      button.setAttribute("aria-checked", String(visible));
      button.dataset["visible"] = String(visible);
      swatch.style.backgroundColor = nodeColor(node);
      paintOpacity(row);
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
  // Local opacity (FR-40, US-10): this device only, until the presenter changes that node's opacity (WEB-12).
  const onListInput = (event: Event) => {
    const row = rows.find((r) => r.opacity === event.target);
    if (!row) return;
    applyOpacity(row.node, Number(row.opacity.value));
    paintOpacity(row);
    if (touch?.row === row) touch.applied = row.node.material.opacity;
    options.onChange?.();
  };
  const onListPointerDown = (event: PointerEvent) => {
    const row = rows.find((r) => r.opacity === event.target);
    touch =
      row && event.pointerType === "touch"
        ? { pointerId: event.pointerId, row, before: row.node.material.opacity, applied: null }
        : null;
  };
  const onListPointerEnd = (event: PointerEvent) => {
    const start = touch;
    if (!start || start.pointerId !== event.pointerId) return;
    touch = null;
    const { row, before, applied } = start;
    if (event.type !== "pointercancel" || applied === null || !rows.includes(row)) return;
    if (row.node.material.opacity !== applied) return; // the presenter's value since: it stays
    applyOpacity(row.node, before);
    paintOpacity(row);
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
  list.addEventListener("input", onListInput);
  list.addEventListener("pointerdown", onListPointerDown);
  list.addEventListener("pointerup", onListPointerEnd);
  list.addEventListener("pointercancel", onListPointerEnd);
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
      const opacity = doc.createElement("input");
      opacity.type = "range";
      opacity.className = "node-panel__opacity";
      opacity.min = "0";
      opacity.max = "1";
      opacity.step = String(OPACITY_STEP);
      opacity.dataset["nodeId"] = node.nodeId;
      opacity.setAttribute("aria-label", t(lang, "nodePanel.opacity", { name: name.textContent }));
      const item = doc.createElement("li");
      item.className = "node-panel__item";
      item.append(button, opacity);
      items.push(item);
      rows.push({ node, button, swatch, opacity });
    }
    list.replaceChildren(...items);
    empty.hidden = rows.length > 0;
    showAll.hidden = rows.length === 0;
    refresh();
    paintToggle();
    // The focused row was replaced: keep keyboard focus on the same control of the same structure (stable nodeId),
    // or on the toggle.
    if (hadFocus && !body.contains(doc.activeElement)) {
      const same = rows.find((row) => row.node.nodeId === focused.dataset["nodeId"]);
      const slider = focused.classList.contains("node-panel__opacity");
      ((slider ? same?.opacity : same?.button) ?? toggle).focus();
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
      list.removeEventListener("input", onListInput);
      list.removeEventListener("pointerdown", onListPointerDown);
      list.removeEventListener("pointerup", onListPointerEnd);
      list.removeEventListener("pointercancel", onListPointerEnd);
      showAll.removeEventListener("click", onShowAll);
      toggle.removeEventListener("click", onToggle);
      rows = [];
      element.remove();
    },
  };
}
