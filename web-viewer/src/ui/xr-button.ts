// The button that enters XR (WEB-19; FR-47): "View in AR" when passthrough is supported, else "View in VR". Shown over
// the scene on Meta Quest Browser only (xr/support.ts); DOM only, the screens wire it.

import { t } from "../i18n/strings";
import type { Lang } from "../i18n/strings";
import type { XrMode } from "../xr/support";

export interface XrButton {
  readonly element: HTMLButtonElement;
  /** Disabled while the session starts (a second tap would ask for a second session). */
  setBusy(busy: boolean): void;
  setLang(lang: Lang): void;
}

export function createXrButton(options: {
  readonly mode: XrMode;
  readonly lang: Lang;
  readonly onClick: () => void;
  readonly document?: Document;
}): XrButton {
  const doc = options.document ?? document;
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "viewer__xr";
  button.dataset["mode"] = options.mode;
  const label = (lang: Lang) =>
    (button.textContent = t(lang, options.mode === "immersive-ar" ? "xr.enterAr" : "xr.enterVr"));
  label(options.lang);
  button.addEventListener("click", () => options.onClick());
  return {
    element: button,
    setBusy(busy) {
      button.disabled = busy;
    },
    setLang: label,
  };
}
