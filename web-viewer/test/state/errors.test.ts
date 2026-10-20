import { describe, expect, it } from "vitest";
import { LANGS } from "../../src/i18n/strings";
import {
  CLOSE_CODES,
  ERROR_CODES,
  describe as describeCode,
  describeState,
} from "../../src/state/errors";
import type { Action, AppState } from "../../src/state/errors";

const ACTIONS: readonly Action[] = ["retry", "enterCode", "askPresenter", "none"];
// Raw protocol identifiers must never reach the user (NFR-31): SCREAMING_SNAKE codes, 4xxx close codes.
const BARE_CODE = /[A-Z]{2,}_[A-Z_]+|\b4\d{3}\b|\b1(000|001|008|009|011)\b/;
const FATAL_CLOSE_CODES = [4000, 4001, 4002, 4003, 4004, 4011];

describe("error catalogue", () => {
  it("covers all 15 error codes and 18 close codes of docs/protocol.md §9", () => {
    expect(ERROR_CODES).toHaveLength(15);
    expect(CLOSE_CODES).toHaveLength(18);
  });

  describe.each(LANGS)("language %s", (lang) => {
    it.each([...ERROR_CODES])("error code %s has text and an action", (code) => {
      const d = describeCode(code, lang);
      expect(d.title.length).toBeGreaterThan(0);
      expect(d.body.length).toBeGreaterThan(0);
      expect(ACTIONS).toContain(d.action);
      expect(d.actionLabel === "").toBe(d.action === "none");
    });

    it.each([...CLOSE_CODES])("close code %i has text and an action", (code) => {
      const d = describeCode(code, lang);
      expect(d.title.length).toBeGreaterThan(0);
      expect(d.body.length).toBeGreaterThan(0);
      expect(ACTIONS).toContain(d.action);
      expect(d.title).not.toBe(describeCode("no-such-code", lang).title);
    });

    it("never contains a bare protocol code in any text", () => {
      const all = [
        ...ERROR_CODES.map((c) => describeCode(c, lang)),
        ...CLOSE_CODES.map((c) => describeCode(c, lang)),
        describeCode("SOMETHING_NEW", lang),
        describeCode(4999, lang),
      ];
      for (const d of all) {
        for (const text of [d.title, d.body, d.actionLabel]) {
          expect(text).not.toMatch(BARE_CODE);
        }
      }
    });
  });

  it("is fatal exactly for close codes 4000-4004 and 4011 (architecture §7 'stop on')", () => {
    const fatal = CLOSE_CODES.filter((c) => describeCode(c, "en").fatal);
    expect(fatal).toEqual(FATAL_CLOSE_CODES);
  });

  it("maps the join failures of US-13 to the code-entry action", () => {
    expect(describeCode("INVALID_CODE", "en")).toMatchObject({ action: "enterCode", fatal: true });
    expect(describeCode(4004, "en").title).toBe(describeCode("INVALID_CODE", "en").title);
    expect(describeCode(4001, "en").action).toBe("enterCode");
    expect(describeCode("SESSION_FULL", "en").action).toBe("retry");
  });

  it("is fatal for exactly the error codes whose usual close is fatal", () => {
    const fatal = ERROR_CODES.filter((c) => describeCode(c, "en").fatal);
    expect(fatal).toEqual([
      "INVALID_CODE",
      "SESSION_CLOSED",
      "UNSUPPORTED_VERSION",
      "UNAUTHORIZED",
    ]);
  });

  it("keeps SESSION_NOT_FOUND retryable (the client falls back to joining by code)", () => {
    expect(describeCode("SESSION_NOT_FOUND", "en").fatal).toBe(false);
  });

  it("answers unknown codes with a generic retryable message instead of throwing", () => {
    for (const unknown of ["BRAND_NEW_CODE", 4999, 1006]) {
      expect(describeCode(unknown, "pl")).toMatchObject({ action: "retry", fatal: false });
    }
  });
});

describe("app state catalogue", () => {
  const states: AppState[] = [
    { kind: "connecting" },
    { kind: "waitingForScene" },
    { kind: "downloading", progress: 0.42 },
    { kind: "reconnecting" },
    { kind: "presenterOffline" },
    { kind: "sessionEnded" },
    { kind: "webgl2Unavailable" },
    { kind: "snapshotTooLarge" },
    { kind: "snapshotInvalid" },
    { kind: "snapshotFailed" },
    { kind: "snapshotUpdateFailed" },
    { kind: "linkInvalid" },
  ];

  it.each(LANGS.flatMap((lang) => states.map((s) => [lang, s] as const)))(
    "%s: %j has text and no bare code",
    (lang, state) => {
      const d = describeState(state, lang);
      expect(d.title.length).toBeGreaterThan(0);
      expect(d.body.length).toBeGreaterThan(0);
      expect(d.body).not.toContain("{");
      expect(`${d.title} ${d.body}`).not.toMatch(BARE_CODE);
    },
  );

  it("shows download progress as a clamped percentage", () => {
    expect(describeState({ kind: "downloading", progress: 0.424 }, "en").body).toContain("42%");
    expect(describeState({ kind: "downloading", progress: 7 }, "pl").body).toContain("100%");
    expect(describeState({ kind: "downloading", progress: -1 }, "en").body).toContain("0%");
  });

  it("gives the dead-end states the right next action", () => {
    expect(describeState({ kind: "sessionEnded" }, "en")).toMatchObject({
      action: "enterCode",
      fatal: true,
    });
    expect(describeState({ kind: "snapshotTooLarge" }, "en").action).toBe("askPresenter");
    expect(describeState({ kind: "snapshotInvalid" }, "en")).toMatchObject({
      action: "askPresenter",
      fatal: false,
    });
    expect(describeState({ kind: "webgl2Unavailable" }, "en")).toMatchObject({
      action: "none",
      fatal: true,
    });
    expect(describeState({ kind: "reconnecting" }, "en").fatal).toBe(false);
    expect(describeState({ kind: "snapshotFailed" }, "en")).toMatchObject({
      action: "retry",
      fatal: false,
    });
  });
});
