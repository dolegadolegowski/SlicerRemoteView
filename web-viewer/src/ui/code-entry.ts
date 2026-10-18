// Code entry screen (WEB-03): five single-character cells, validation through the shared helper so the
// alphabet and the targeted hints match ADR 0008 §7. DOM only; the connection is wired by the caller.
//
// Privacy: the code lives in the input cells and in `onJoin`'s argument only. This module never touches
// `location`/`history`, the form has no `action`/`method` and the inputs no `name`, so nothing can end up in a
// query string (NFR-15, CLAUDE.md rule 6).

import { CODE_HINTS, CODE_LENGTH, normalizeCode } from "@slicerremoteview/shared";
import { detectLang, t } from "../i18n/strings";
import type { Lang, StringKey } from "../i18n/strings";
import type { Description } from "../state/errors";

export interface CodeEntryOptions {
  /** Called with the canonical code (upper-case, validated) when the user presses Join. */
  readonly onJoin: (code: string) => void;
  readonly lang?: Lang;
}

export interface CodeEntry {
  readonly element: HTMLElement;
  /** Shows a localised error (from `describe()`); `null` clears it. */
  setError(error: Description | null): void;
  /** While busy the inputs and the button are disabled and the button reads "Joining…". */
  setBusy(busy: boolean): void;
  /** Clears all cells, keeps the language. */
  reset(): void;
  /** Focuses the first empty cell (the last cell when all are filled). */
  focus(): void;
}

/** Strips separators and upper-cases, exactly like `normalizeCode` but without validating. */
const clean = (text: string): string =>
  text.replace(/[\s\u2010-\u2015\u2212-]/gu, "").toUpperCase();

const HINT_KEYS = new Map<string, StringKey>([
  [CODE_HINTS.zeroOrO, "codeEntry.hint.zeroOrO"],
  [CODE_HINTS.oneIorL, "codeEntry.hint.oneIorL"],
  [CODE_HINTS.notInAlphabet, "codeEntry.hint.notInAlphabet"],
  [CODE_HINTS.length, "codeEntry.hint.length"],
]);

export function createCodeEntry(options: CodeEntryOptions): CodeEntry {
  const lang = options.lang ?? detectLang();
  let busy = false;
  let overflow = false;
  let error: Description | null = null;

  const form = document.createElement("form");
  form.className = "code-entry";
  form.noValidate = true;

  const title = document.createElement("h1");
  title.id = "code-entry-title";
  title.textContent = t(lang, "codeEntry.title");

  const lead = document.createElement("p");
  lead.className = "code-entry__lead";
  lead.textContent = t(lang, "codeEntry.lead");

  const group = document.createElement("div");
  group.className = "code-entry__cells";
  group.setAttribute("role", "group");
  group.setAttribute("aria-labelledby", title.id);

  const cells: HTMLInputElement[] = [];
  for (let i = 0; i < CODE_LENGTH; i++) {
    const cell = document.createElement("input");
    cell.type = "text";
    cell.className = "code-entry__cell";
    cell.inputMode = "text";
    cell.autocomplete = "off";
    cell.spellcheck = false;
    cell.setAttribute("autocapitalize", "characters");
    cell.setAttribute("autocorrect", "off");
    cell.setAttribute("enterkeyhint", i === CODE_LENGTH - 1 ? "go" : "next");
    cell.setAttribute(
      "aria-label",
      t(lang, "codeEntry.cellLabel", { n: i + 1, total: CODE_LENGTH }),
    );
    cells.push(cell);
    group.append(cell);
  }

  const message = document.createElement("p");
  message.className = "code-entry__message";
  message.id = "code-entry-message";
  message.setAttribute("role", "alert");
  message.hidden = true;
  for (const cell of cells) cell.setAttribute("aria-describedby", message.id);

  const join = document.createElement("button");
  join.type = "submit";
  join.className = "code-entry__join";

  form.append(title, lead, group, message, join);

  const value = (): string => cells.map((c) => c.value).join("");

  /** Writes `chars` into the cells from `start`; returns the index after the last written cell. */
  function fill(start: number, chars: string): number {
    const list = [...chars];
    let index = start;
    for (const ch of list) {
      if (index >= CODE_LENGTH) break;
      cells[index]!.value = ch;
      index++;
    }
    overflow = start + list.length > CODE_LENGTH;
    return index;
  }

  function hintText(): string | null {
    if (overflow) return t(lang, "codeEntry.hint.length");
    const result = normalizeCode(value());
    if ("code" in result) return null;
    // An empty or still-short code is not an error yet; a wrong character is, immediately.
    if (result.hint === CODE_HINTS.empty || result.hint === CODE_HINTS.length) return null;
    const key = HINT_KEYS.get(result.hint);
    return key ? t(lang, key) : null;
  }

  function currentCode(): string | null {
    if (overflow) return null;
    const result = normalizeCode(value());
    return "code" in result ? result.code : null;
  }

  function refresh(): void {
    const hint = hintText();
    const text = hint ?? (error ? `${error.title}. ${error.body}` : null);
    message.hidden = text === null;
    message.textContent = text ?? "";
    message.classList.toggle("code-entry__message--error", hint !== null || error !== null);
    const invalid = hint !== null;
    for (const cell of cells) {
      cell.disabled = busy;
      cell.setAttribute("aria-invalid", invalid ? "true" : "false");
    }
    join.disabled = busy || currentCode() === null;
    join.textContent = t(lang, busy ? "codeEntry.joining" : "codeEntry.join");
  }

  function focusCell(index: number): void {
    const cell = cells[Math.max(0, Math.min(CODE_LENGTH - 1, index))]!;
    cell.focus();
    cell.select();
  }

  cells.forEach((cell, i) => {
    cell.addEventListener("input", () => {
      error = null;
      const text = clean(cell.value);
      if (text === "") {
        cell.value = "";
        overflow = false;
      } else {
        // One character normally; several when the browser autofills or a soft keyboard sends a word.
        cell.value = "";
        const next = fill(i, text);
        focusCell(next);
      }
      refresh();
    });

    cell.addEventListener("focus", () => cell.select());

    cell.addEventListener("keydown", (event) => {
      if (event.key === "Backspace" && cell.value === "" && i > 0) {
        event.preventDefault();
        cells[i - 1]!.value = "";
        overflow = false;
        focusCell(i - 1);
        refresh();
      } else if (event.key === "ArrowLeft" && i > 0) {
        event.preventDefault();
        focusCell(i - 1);
      } else if (event.key === "ArrowRight" && i < CODE_LENGTH - 1) {
        event.preventDefault();
        focusCell(i + 1);
      }
    });

    cell.addEventListener("paste", (event) => {
      event.preventDefault();
      const text = clean(event.clipboardData?.getData("text") ?? "");
      if (text === "") return;
      error = null;
      for (const c of cells) c.value = "";
      focusCell(fill(0, text));
      refresh();
    });
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const code = currentCode();
    if (busy || code === null) return;
    options.onJoin(code);
  });

  refresh();

  return {
    element: form,
    setError(next) {
      error = next;
      refresh();
    },
    setBusy(next) {
      busy = next;
      refresh();
    },
    reset() {
      for (const cell of cells) cell.value = "";
      overflow = false;
      error = null;
      refresh();
    },
    focus() {
      const empty = cells.findIndex((c) => c.value === "");
      focusCell(empty === -1 ? CODE_LENGTH - 1 : empty);
    },
  };
}
