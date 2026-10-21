// Language switch (WEB-21): one button that names the language it switches to, in that language — "Polski" on the
// English UI, "English" on the Polish one — so it is found by someone who does not read the current language. The
// visible text is the whole accessible name (WCAG 2.5.3: voice control users say what they see). Used in the status
// bar and on the code entry; DOM only, the store does the rest.

import { t } from "../i18n/strings";
import { nextLang } from "../i18n/lang";
import type { LangStore } from "../i18n/lang";

export interface LangToggle {
  readonly element: HTMLButtonElement;
  dispose(): void;
}

export function createLangToggle(
  store: Pick<LangStore, "lang" | "set" | "onChange">,
  options: { readonly className?: string; readonly document?: Document } = {},
): LangToggle {
  const doc = options.document ?? document;
  const button = doc.createElement("button");
  button.type = "button"; // never submits the code entry's form
  button.className = options.className ?? "lang-toggle";

  function paint(): void {
    const target = nextLang(store.lang);
    button.lang = target; // the label is in the target language: read with its pronunciation
    button.textContent = t(target, "lang.name");
  }

  const onClick = () => store.set(nextLang(store.lang));
  button.addEventListener("click", onClick);
  const off = store.onChange(paint);
  paint();
  return {
    element: button,
    dispose() {
      off();
      button.removeEventListener("click", onClick);
      button.remove();
    },
  };
}
