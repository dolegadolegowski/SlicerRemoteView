import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConnection } from "../../src/protocol/connection";
import { createReconnect } from "../../src/protocol/reconnect";
import { describe as describeCode, describeState } from "../../src/state/errors";
import { createCodeEntry } from "../../src/ui/code-entry";
import type { CodeEntry } from "../../src/ui/code-entry";
import { DEEP_LINK_PATH, startFromDeepLink, takeDeepLink } from "../../src/ui/deep-link";
import type { HistoryLike } from "../../src/ui/deep-link";
import { bindScreens } from "../../src/ui/screens";
import { FakeDocument } from "../protocol/fake-document";
import { MockSocket } from "../protocol/mock-socket";

const at = (pathname: string, hash = "") => ({ pathname, hash });
let hist: { replaceState: ReturnType<typeof vi.fn<HistoryLike["replaceState"]>> };

beforeEach(() => {
  hist = { replaceState: vi.fn<HistoryLike["replaceState"]>() };
});

describe("takeDeepLink (FR-36, ADR 0008 §5)", () => {
  it("reads /j#CODE, upper-cases it and replaces the URL with /j at once", () => {
    expect(takeDeepLink(at("/j", "#7kq4x"), hist)).toEqual({ kind: "code", code: "7KQ4X" });
    expect(hist.replaceState).toHaveBeenCalledOnce();
    expect(hist.replaceState).toHaveBeenCalledWith(null, "", DEEP_LINK_PATH);
  });

  it.each([
    ["separators", "#7KQ-4X", "7KQ4X"],
    ["a percent-encoded space", "#7KQ%204X", "7KQ4X"],
  ])("accepts %s", (_label, hash, code) => {
    expect(takeDeepLink(at("/j", hash), hist)).toEqual({ kind: "code", code });
  });

  it("an invalid code is reported as such, and the URL is still cleaned (a near-miss may be a real code)", () => {
    expect(takeDeepLink(at("/j", "#7KQ0X"), hist)).toEqual({ kind: "invalid", text: "7KQ0X" });
    expect(hist.replaceState).toHaveBeenCalledWith(null, "", "/j");
  });

  it("malformed percent-encoding or a very long fragment does not throw and is cut short", () => {
    expect(takeDeepLink(at("/j", "#%E0%A4%A"), hist)).toEqual({
      kind: "invalid",
      text: "%E0%A4%A",
    });
    const long = takeDeepLink(at("/j", `#${"A".repeat(10_000)}`), hist);
    expect(long.kind).toBe("invalid");
    expect(long.kind === "invalid" && long.text.length).toBe(64);
  });

  it.each([
    ["/j without a fragment", at("/j")],
    ["a fragment on another path", at("/", "#7KQ4X")],
    ["/j/ (not the deep-link path)", at("/j/", "#7KQ4X")],
  ])("%s is no deep link and leaves the URL alone", (_label, loc) => {
    expect(takeDeepLink(loc, hist)).toEqual({ kind: "none" });
    expect(hist.replaceState).not.toHaveBeenCalled();
  });
});

describe("startFromDeepLink", () => {
  let entry: CodeEntry;
  const cells = () => [...entry.element.querySelectorAll("input")].map((c) => c.value).join("");
  const message = () => entry.element.querySelector(".code-entry__message")!.textContent ?? "";

  beforeEach(() => {
    entry = createCodeEntry({ lang: "en", onJoin: vi.fn() });
    document.body.replaceChildren(entry.element);
  });

  it("a valid code is put into the cells and joined", () => {
    const screens = { join: vi.fn(), report: vi.fn(), live: false };
    expect(startFromDeepLink({ kind: "code", code: "7KQ4X" }, entry, screens)).toBe(true);
    expect(cells()).toBe("7KQ4X");
    expect(screens.join).toHaveBeenCalledWith("7KQ4X");
    expect(screens.report).not.toHaveBeenCalled();
  });

  it("an invalid code shows the 0/O hint in the cells and does not join", () => {
    const screens = {
      join: vi.fn(),
      report: (d: Parameters<CodeEntry["setError"]>[0]) => entry.setError(d),
      live: false,
    };
    expect(startFromDeepLink({ kind: "invalid", text: "7KQ0X" }, entry, screens)).toBe(true);
    expect(cells()).toBe("7KQ0X");
    expect(message()).toBe("Codes never contain 0 or O — check that character.");
    expect(screens.join).not.toHaveBeenCalled();
    expect(entry.element.contains(document.activeElement)).toBe(true);
  });

  it("a code that is too short says the link has no valid code", () => {
    const screens = {
      join: vi.fn(),
      report: (d: Parameters<CodeEntry["setError"]>[0]) => entry.setError(d),
      live: false,
    };
    startFromDeepLink({ kind: "invalid", text: "7KQ" }, entry, screens);
    expect(message()).toContain(describeState({ kind: "linkInvalid" }, "en").title);
  });

  it("no deep link does nothing", () => {
    const screens = { join: vi.fn(), report: vi.fn(), live: false };
    expect(startFromDeepLink({ kind: "none" }, entry, screens)).toBe(false);
    expect(cells()).toBe("");
  });
});

/** The real code entry, screens and connection over a mock socket; `order` records URL rewrites and sockets. */
function app() {
  MockSocket.reset();
  const order: string[] = [];
  hist.replaceState.mockImplementation((_d, _u, url) => void order.push(`replace ${url}`));
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  const connection = createConnection({
    location: { protocol: "https:", host: "x.example", hostname: "x.example" },
    createSocket: (url) => {
      order.push(`socket ${url}`);
      return new MockSocket(url);
    },
    log: vi.fn(),
    lang: "en",
  });
  const models = { current: null, load: vi.fn(), clear: vi.fn(), onChange: () => () => {} };
  const entry = createCodeEntry({ lang: "en", onJoin: (code) => screens.join(code) });
  const session = createReconnect(connection, {
    document: new FakeDocument(),
    window: new EventTarget(),
  });
  const screens = bindScreens({
    app: root,
    connection,
    session,
    models,
    entry,
    webGL2Available: () => true,
  });
  root.append(entry.element);
  const cells = () => [...entry.element.querySelectorAll("input")].map((c) => c.value).join("");
  const message = () => entry.element.querySelector(".code-entry__message")!.textContent ?? "";
  return { order, connection, entry, screens, cells, message };
}

describe("start-up order (T6)", () => {
  it("the URL is cleaned before the socket is opened, and only viewer.join carries the code", () => {
    const { order, entry, screens } = app();
    startFromDeepLink(takeDeepLink(at("/j", "#7KQ4X"), hist), entry, screens);
    expect(order).toEqual(["replace /j", "socket wss://x.example/ws"]);
    MockSocket.last.open();
    expect(MockSocket.last.frames[0]).toMatchObject({ type: "viewer.join", code: "7KQ4X" });
  });
});

describe("a link opened during a session (hashchange)", () => {
  it("an invalid one is reported but leaves the joined code in the cells: a drop still says so, Join retries", () => {
    const { connection, entry, screens, cells, message } = app();
    startFromDeepLink(takeDeepLink(at("/j", "#7KQ4X"), hist), entry, screens);
    MockSocket.last.open();
    expect(screens.live).toBe(true);
    startFromDeepLink(takeDeepLink(at("/j", "#7KQ0X"), hist), entry, screens);
    expect(cells()).toBe("7KQ4X");
    expect(message()).toContain(describeState({ kind: "linkInvalid" }, "en").title);
    expect(connection.state.kind).toBe("connecting"); // the join goes on
    MockSocket.last.serverClose(1006);
    expect(screens.live).toBe(false);
    expect(cells()).toBe("7KQ4X");
    expect(message()).toContain(describeCode(1001, "en").title); // "connection lost", not a hint
    expect(entry.element.querySelector<HTMLButtonElement>(".code-entry__join")!.disabled).toBe(
      false,
    );
  });

  it("also when joined or reconnecting: the cells keep the joined code", () => {
    vi.useFakeTimers(); // the reconnect's retry timer must not outlive the test
    const { connection, entry, screens, cells } = app();
    startFromDeepLink(takeDeepLink(at("/j", "#7KQ4X"), hist), entry, screens);
    MockSocket.last.open();
    MockSocket.last.receive({
      type: "viewer.joined",
      sessionId: "sess_01K7Q4XMB2TJ9RD6",
      viewerId: "vw_1",
      viewerToken: "vt_8dKq2ZrT7nWbY4mCfH6vJ9xLpA3sE5uG1oRtN0iQkDw",
      sceneVersion: 1,
      snapshotVersion: 1,
      snapshotAvailable: false,
      publisherOnline: true,
      viewerCount: 1,
      viewerLimit: 20,
      profile: "mobile",
    });
    expect(connection.state.kind).toBe("connected");
    expect(screens.live).toBe(true);
    startFromDeepLink(takeDeepLink(at("/j", "#7KQ0X"), hist), entry, screens);
    expect(cells()).toBe("7KQ4X");
    MockSocket.last.serverClose(1006); // WEB-14 rejoins by itself: still this session
    expect(screens.live).toBe(true);
    startFromDeepLink(takeDeepLink(at("/j", "#7KQ0X"), hist), entry, screens);
    expect(cells()).toBe("7KQ4X");
    vi.useRealTimers();
  });

  it("a valid one joins that session instead", () => {
    const { entry, screens, cells } = app();
    startFromDeepLink(takeDeepLink(at("/j", "#7KQ4X"), hist), entry, screens);
    startFromDeepLink(takeDeepLink(at("/j", "#AB2CD"), hist), entry, screens);
    expect(cells()).toBe("AB2CD");
    expect(MockSocket.instances).toHaveLength(2);
    MockSocket.last.open();
    expect(MockSocket.last.frames[0]).toMatchObject({ type: "viewer.join", code: "AB2CD" });
  });
});
