// The UI language (WEB-21; FR-51, NFR-33): the user's manual choice, kept in `localStorage` under one key — the
// language only, never a code, token or anything about the session (CLAUDE.md rule 6) — else the browser's
// languages. The store also keeps `<html lang>` in step, so screen readers pronounce the texts in the right
// language, and tells the UI to re-render its texts on a switch (no reload: a reload would leave the session).

import { LANGS, detectLang, pickLang } from "./strings";
import type { Lang } from "./strings";

/** The only `localStorage` key the viewer writes. */
export const LANG_STORAGE_KEY = "rv.lang";

export interface LangStore {
  readonly lang: Lang;
  /** Switches the UI language and remembers the choice; the same language is a no-op. */
  set(lang: Lang): void;
  /** Called after every switch; returns the unsubscribe function. */
  onChange(listener: (lang: Lang) => void): () => void;
}

export interface LangStoreOptions {
  /** `null` when storage is unavailable (blocked cookies, some private modes): the choice lasts for the page. */
  readonly storage?: Pick<Storage, "getItem" | "setItem"> | null;
  /** `navigator.languages` style input for the first visit; default the browser's (`detectLang`). */
  readonly languages?: readonly string[] | string;
  /** Gets `lang` set on creation and on each switch (`document.documentElement`). */
  readonly root?: { lang: string };
}

const isLang = (value: unknown): value is Lang => LANGS.some((lang) => lang === value);

/** `window.localStorage`, or `null` where reading it throws (Safari with all cookies blocked, sandboxed frames). */
export function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function createLangStore(options: LangStoreOptions = {}): LangStore {
  const storage = options.storage ?? null;
  const listeners = new Set<(lang: Lang) => void>();
  let stored: string | null = null;
  try {
    stored = storage?.getItem(LANG_STORAGE_KEY) ?? null;
  } catch {
    // unreadable storage: the browser languages decide
  }
  // A stored value is used only if it is one of ours (the key is shared with anything on the origin).
  const browser = options.languages === undefined ? detectLang() : pickLang(options.languages);
  let lang: Lang = isLang(stored) ? stored : browser;
  if (options.root) options.root.lang = lang;

  return {
    get lang() {
      return lang;
    },
    set(next) {
      if (next === lang || !isLang(next)) return;
      lang = next;
      if (options.root) options.root.lang = lang;
      try {
        storage?.setItem(LANG_STORAGE_KEY, lang);
      } catch {
        // full or blocked storage: the switch still applies to this page
      }
      for (const listener of [...listeners]) {
        try {
          listener(lang);
        } catch {
          // one failing listener must not keep the rest of the UI in the old language
        }
      }
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The language after `lang` in `LANGS` (with two languages: the other one). */
export const nextLang = (lang: Lang): Lang => LANGS[(LANGS.indexOf(lang) + 1) % LANGS.length]!;
