import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodeEntry } from "../../src/ui/code-entry";
import type { CodeEntry } from "../../src/ui/code-entry";
import { CODE_HINTS } from "@slicerremoteview/shared";
import { describe as describeCode } from "../../src/state/errors";

let entry: CodeEntry;
let onJoin: ReturnType<typeof vi.fn<(code: string) => void>>;

const cells = () => [...entry.element.querySelectorAll<HTMLInputElement>(".code-entry__cell")];
const join = () => entry.element.querySelector<HTMLButtonElement>(".code-entry__join")!;
const message = () => entry.element.querySelector<HTMLElement>(".code-entry__message")!;
const values = () =>
  cells()
    .map((c) => c.value)
    .join("");

/** Types characters one by one like a keyboard: the browser puts the char in the focused cell, then fires `input`. */
function type(text: string): void {
  for (const ch of text) {
    const cell = document.activeElement as HTMLInputElement;
    cell.value = ch;
    cell.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function paste(target: HTMLInputElement, text: string): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
  target.dispatchEvent(event);
  return event;
}

function key(target: HTMLElement, name: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  onJoin = vi.fn<(code: string) => void>();
  entry = createCodeEntry({ onJoin, lang: "en" });
  document.body.append(entry.element);
  entry.focus();
});

afterEach(() => {
  entry.element.remove();
});

describe("code entry", () => {
  it("setCode fills the cells like a paste (deep link): canonical, hinted, or too long", () => {
    entry.setError(describeCode("INVALID_CODE", "en"));
    entry.setCode("7kq-4x");
    expect(values()).toBe("7KQ4X");
    expect(message().hidden).toBe(true); // the old error is gone
    expect(join().disabled).toBe(false);
    entry.setCode("7KQ0X");
    expect(message().textContent).toContain("0 or O");
    expect(join().disabled).toBe(true);
    entry.setCode("7KQ4X8");
    expect(values()).toBe("7KQ4X");
    expect(message().textContent).toContain("exactly 5");
    expect(join().disabled).toBe(true);
  });

  it("renders five labelled cells configured for code entry", () => {
    expect(cells()).toHaveLength(5);
    for (const [i, cell] of cells().entries()) {
      expect(cell.getAttribute("autocapitalize")).toBe("characters");
      expect(cell.inputMode).toBe("text");
      expect(cell.getAttribute("aria-label")).toBe(`Code character ${i + 1} of 5`);
      expect(cell.hasAttribute("name")).toBe(false);
    }
    expect(join().disabled).toBe(true);
    expect(document.activeElement).toBe(cells()[0]);
  });

  it("upper-cases typed input, auto-advances and enables Join for 7kq4x (FR-35)", () => {
    type("7kq4x");
    expect(values()).toBe("7KQ4X");
    expect(join().disabled).toBe(false);
    expect(message().hidden).toBe(true);
    expect(document.activeElement).toBe(cells()[4]);
  });

  it("keeps Join disabled and stays quiet while the code is merely incomplete", () => {
    type("7kq");
    expect(join().disabled).toBe(true);
    expect(message().hidden).toBe(true);
    expect(document.activeElement).toBe(cells()[3]);
  });

  it("disables Join and shows the 0/O hint for 7KQ0X (ADR 0008 §7)", () => {
    type("7kq0x");
    expect(values()).toBe("7KQ0X");
    expect(join().disabled).toBe(true);
    expect(message().hidden).toBe(false);
    expect(message().textContent).toContain("0 or O");
    expect(cells()[0]!.getAttribute("aria-invalid")).toBe("true");
  });

  it.each([
    ["7KQ1X", "1, I or L"],
    ["7KQLX", "1, I or L"],
    ["7KQOX", "0 or O"],
    ["7KQ!X", "A–Z"],
  ])("targeted hint for %s", (input, expected) => {
    type(input);
    expect(message().textContent).toContain(expected);
    expect(join().disabled).toBe(true);
  });

  it("clears the hint once the wrong character is replaced", () => {
    type("7kq0x");
    const cell = cells()[3]!;
    cell.focus();
    type("4");
    expect(values()).toBe("7KQ4X");
    expect(message().hidden).toBe(true);
    expect(join().disabled).toBe(false);
  });

  it("fills all cells when a whole code is pasted (FR-35)", () => {
    const event = paste(cells()[2]!, "7KQ4X");
    expect(event.defaultPrevented).toBe(true);
    expect(values()).toBe("7KQ4X");
    expect(join().disabled).toBe(false);
  });

  it("strips separators and whitespace from pasted codes (ADR 0008 §7)", () => {
    paste(cells()[0]!, " ab-cde\n");
    expect(values()).toBe("ABCDE");
    expect(join().disabled).toBe(false);
    paste(cells()[0]!, "a b c–d e");
    expect(values()).toBe("ABCDE");
  });

  it("refuses an over-long paste instead of silently truncating the code", () => {
    paste(cells()[0]!, "7KQ4X8");
    expect(join().disabled).toBe(true);
    expect(message().textContent).toContain("exactly 5");
  });

  it("spreads several characters delivered by autofill into the following cells", () => {
    const first = cells()[0]!;
    first.value = "7kq4x";
    first.dispatchEvent(new Event("input", { bubbles: true }));
    expect(values()).toBe("7KQ4X");
  });

  it("moves back on Backspace in an empty cell and clears the previous one", () => {
    type("7k");
    expect(document.activeElement).toBe(cells()[2]);
    key(cells()[2]!, "Backspace");
    expect(values()).toBe("7");
    expect(document.activeElement).toBe(cells()[1]);
  });

  it("navigates with the arrow keys", () => {
    cells()[2]!.focus();
    key(cells()[2]!, "ArrowLeft");
    expect(document.activeElement).toBe(cells()[1]);
    key(cells()[1]!, "ArrowRight");
    expect(document.activeElement).toBe(cells()[2]);
  });

  it("calls onJoin with the canonical code on submit and prevents the default form submission", () => {
    type("7kq4x");
    const submit = new Event("submit", { bubbles: true, cancelable: true });
    entry.element.dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
    expect(onJoin).toHaveBeenCalledExactlyOnceWith("7KQ4X");
  });

  it("does not join an invalid or incomplete code", () => {
    type("7kq0x");
    entry.element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(onJoin).not.toHaveBeenCalled();
  });

  it("has no action, method or named fields that could put the code in a URL (NFR-15)", () => {
    const form = entry.element as HTMLFormElement;
    expect(form.hasAttribute("action")).toBe(false);
    expect(form.hasAttribute("method")).toBe(false);
    expect(entry.element.querySelectorAll("[name]")).toHaveLength(0);
  });

  it("shows busy state and ignores submit while busy", () => {
    type("7kq4x");
    entry.setBusy(true);
    expect(join().disabled).toBe(true);
    expect(join().textContent).toBe("Joining…");
    expect(cells().every((c) => c.disabled)).toBe(true);
    entry.element.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(onJoin).not.toHaveBeenCalled();
    entry.setBusy(false);
    expect(join().textContent).toBe("Join");
    expect(join().disabled).toBe(false);
  });

  it("offers Leave only while busy, when it is given onLeave; Leave never submits (WEB-22)", () => {
    expect(entry.element.querySelector(".code-entry__leave")).toBeNull(); // no onLeave
    entry.element.remove();
    const onLeave = vi.fn();
    entry = createCodeEntry({ onJoin, onLeave, lang: "en" });
    document.body.append(entry.element);
    const leave = entry.element.querySelector<HTMLButtonElement>(".code-entry__leave")!;
    expect(leave.type).toBe("button");
    expect(leave.textContent).toBe("Leave session");
    expect(leave.hidden).toBe(true);
    entry.focus();
    type("7kq4x");
    entry.setBusy(true);
    expect(leave.hidden).toBe(false);
    expect(leave.disabled).toBe(false); // unlike the cells and Join
    leave.click();
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(onJoin).not.toHaveBeenCalled();
    entry.setBusy(false);
    expect(leave.hidden).toBe(true);
  });

  it("has a polite status line under Join that is always in the accessibility tree (WEB-14)", () => {
    const status = entry.element.querySelector<HTMLElement>(".code-entry__status")!;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("");
    expect(status.previousElementSibling).toBe(join());
    entry.setStatus("Waiting for the presenter");
    expect(status.textContent).toBe("Waiting for the presenter");
    const text = status.firstChild;
    entry.setStatus("Waiting for the presenter"); // unchanged: not announced again
    expect(status.firstChild).toBe(text);
    entry.setStatus(null);
    expect(status.textContent).toBe("");
    expect(status.hidden).toBe(false);
  });

  it("shows an error from the catalogue, and clears it on the next edit", () => {
    type("7kq4x");
    entry.setError(describeCode("INVALID_CODE", "en"));
    expect(message().hidden).toBe(false);
    expect(message().textContent).toContain("Code not recognised");
    expect(message().textContent).not.toContain("INVALID_CODE");
    cells()[4]!.focus();
    type("Z");
    expect(message().hidden).toBe(true);
  });

  it("reset() clears the cells and the error", () => {
    type("7kq4x");
    entry.setError(describeCode("INVALID_CODE", "en"));
    entry.reset();
    expect(values()).toBe("");
    expect(message().hidden).toBe(true);
    expect(join().disabled).toBe(true);
  });

  it("has a localised string for every hint the shared helper can return", () => {
    for (const hint of Object.values(CODE_HINTS)) {
      if (hint === CODE_HINTS.empty || hint === CODE_HINTS.length) continue;
      const probe =
        hint === CODE_HINTS.zeroOrO ? "7KQ0X" : hint === CODE_HINTS.oneIorL ? "7KQ1X" : "7KQ!X";
      entry.reset();
      cells()[0]!.focus();
      type(probe);
      expect(message().hidden, hint).toBe(false);
    }
  });

  it("colours hints as errors", () => {
    type("7kq0x");
    expect(message().classList.contains("code-entry__message--error")).toBe(true);
  });

  it("re-renders its texts, the hint and the error in the other language without losing input (WEB-21)", () => {
    type("7kq0x"); // a hint
    entry.setLang("pl");
    expect(entry.element.querySelector("h1")!.textContent).toBe("Dołącz do sesji");
    expect(cells()[0]!.getAttribute("aria-label")).toBe("Znak kodu 1 z 5");
    expect(join().textContent).toBe("Dołącz");
    expect(message().textContent).toContain("0 ani O");
    expect(values()).toBe("7KQ0X");
    entry.reset();
    entry.setError(describeCode("INVALID_CODE", "en")); // made in another language
    expect(message().textContent).toContain(describeCode("INVALID_CODE", "pl").title);
    entry.setLang("en");
    expect(message().textContent).toContain("Code not recognised");
    entry.setBusy(true);
    entry.setLang("pl");
    expect(join().textContent).toBe("Dołączanie…");
  });

  it("puts the language switch in the title row, after the title (WEB-21)", () => {
    const toggle = document.createElement("button");
    const withToggle = createCodeEntry({ onJoin, lang: "en", languageToggle: toggle });
    const head = withToggle.element.firstElementChild!;
    expect(head.className).toBe("code-entry__head");
    expect([...head.children].map((c) => c.tagName)).toEqual(["H1", "BUTTON"]);
    expect(head.lastElementChild).toBe(toggle);
    expect(entry.element.firstElementChild!.tagName).toBe("H1"); // no switch, no row
  });

  it("localises to Polish", () => {
    entry.element.remove();
    entry = createCodeEntry({ onJoin, lang: "pl" });
    document.body.append(entry.element);
    expect(join().textContent).toBe("Dołącz");
    const withLeave = createCodeEntry({ onJoin, onLeave: () => {}, lang: "pl" });
    expect(withLeave.element.querySelector(".code-entry__leave")!.textContent).toBe("Opuść sesję");
    cells()[0]!.focus();
    type("7kq0x");
    expect(message().textContent).toContain("0 ani O");
  });
});
