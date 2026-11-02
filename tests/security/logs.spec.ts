// QA-07 log grep: drive a whole viewer session against the built relay at `LOG_LEVEL=trace` — join by typing the
// code, a deep link `/j#code`, both late joins that fetch `GET /api/scene/1`, a second viewer, a raw `ws` join with
// a wrong code, a raw publisher of our own (tokens captured in memory), a raw viewer and a `session.close` — then
// grep the relay log, fake-slicer's outputs and the browser's requests (in-memory list + HAR) for anything secret.
// The grep rules live in `harness/qa07-log-grep.ts` (pure); a mutation test proves they flag each kind of leak.
// With `LOG_FILE=<file or directory>` (a CI artefact, DEP-10) an extra test applies the secret-independent rules.
//
// Requirements / threats: FR-29 (no secrets in logs), FR-31 + NFR-15 (codes never in URLs; tokens only in
// `Authorization`), NFR-12 (code not printed), T6 (information disclosure through logs), CLAUDE.md rule 6.
// Protocol: §3.1 (no code/token in the URL), §4.2 / §5.2 (token format), §9.2 (logs carry no codes, tokens or
// scene content; node ids are scene content), §10 (`/j#code` fragment, `Authorization: Bearer` for /api/scene).
//
// Secrets stay in memory: every assertion about them is a boolean or a list of `{kind, line}` findings; failure
// locations are redacted; the code is typed over CDP and the deep link opened from `Evaluate`, so no Playwright
// step title (`Type "<code>"`, `Navigate to "<url>"`) carries it into the HTML report.

import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserContext, Page, Request } from "@playwright/test";
import { loadGlb, resolveFixture, sendSnapshot } from "@slicerremoteview/fake-slicer";
import { expect, test } from "../harness/fixtures.ts";
import {
  describeFindings,
  glbBinOffset,
  glbByteForms,
  glbSecrets,
  grepLog,
} from "../harness/qa07-log-grep.ts";
import type { Finding, FindingKind, Secrets } from "../harness/qa07-log-grep.ts";
import { connect, createSession, joinViewer, nextIp } from "../harness/ws-client.ts";
import type { Message } from "../harness/ws-client.ts";
import { expectModelLoaded } from "../e2e/support/viewer.ts";

const STACK_FIXTURE = "asymmetric-2nodes.glb";
/** The raw publisher's GLB: its raw segment id `left lung` is the PHI-like string of §7.3. */
const RAW_FIXTURE = "aliased-segments.glb";
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
/** How browsers and local clients reach the relay (no `X-Forwarded-For`): never in a log line. */
const LOOPBACK = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

/** A well-formed code that is none of `taken`. */
function otherCode(taken: readonly string[]): string {
  for (;;) {
    let code = "";
    for (let i = 0; i < 5; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!taken.includes(code)) return code;
  }
}

/** The scene strings and byte forms of a fixture, in the shape `grepLog` takes. */
function fixtureSecrets(name: string): Pick<Secrets, "nodeNames" | "nodeIds" | "glbForms"> {
  const file = resolveFixture(name);
  const glb = readFileSync(file);
  const { nodeNames, nodeIds } = glbSecrets(glb);
  // The plan names `manifest.json` as the source of node ids: every id it lists must be among those read from the
  // GLB's JSON chunk, so the grep forbids at least the manifest's ids (and the names/raw ids the manifest omits).
  const manifest = JSON.parse(readFileSync(path.join(path.dirname(file), "manifest.json"), "utf8")) as {
    files: Record<string, { nodeIds?: string[] }>;
  };
  const listed = manifest.files[name]?.nodeIds ?? [];
  expect(listed.length, `manifest.json lists node ids for ${name}`).toBeGreaterThan(0);
  expect(listed.every((id) => nodeIds.includes(id)), `${name}: manifest node ids read from the GLB`).toBe(true);
  // Whole file at every offset (header, JSON chunk, BIN chunk); the BIN start is included by construction.
  return { nodeNames, nodeIds, glbForms: glbByteForms(glb) };
}

function merge(...parts: Secrets[]): Secrets {
  const out: Required<Secrets> = {
    codes: [],
    publisherTokens: [],
    viewerTokens: [],
    nodeNames: [],
    nodeIds: [],
    clientIps: [],
    glbForms: [],
  };
  for (const part of parts)
    for (const key of Object.keys(out) as (keyof Secrets)[]) out[key] = [...out[key], ...(part[key] ?? [])];
  return out;
}

const kinds = (findings: readonly Finding[]): Set<FindingKind> => new Set(findings.map((f) => f.kind));

/** Captures the viewer tokens a page's own WebSocket receives (in memory) and whether a frame body carried `code`. */
function watchSockets(
  page: Page,
  sink: { viewerTokens: string[]; framesWithCode: number; urls: string[] },
  code: () => string,
) {
  // Page 'websocket' event and WebSocket 'framesent'/'framereceived' (playwright-core/types/types.d.ts); the
  // upgrade is not a `request` event, so its URL is checked from here.
  page.on("websocket", (socket) => {
    sink.urls.push(socket.url());
    socket.on("framesent", ({ payload }) => {
      if (typeof payload === "string" && payload.includes(code())) sink.framesWithCode++;
    });
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      try {
        const message = JSON.parse(payload) as Message;
        if (message.type === "viewer.joined" && typeof message.viewerToken === "string")
          sink.viewerTokens.push(message.viewerToken);
      } catch {
        // binary-as-text or not JSON: nothing to capture
      }
    });
  });
}

interface RecordedRequest {
  url: string;
  headers: [string, string][];
  /** Response headers (empty when the request got no response). */
  responseHeaders: [string, string][];
}

/** Every request the context makes, with all request and response headers (Request.allHeaders(),
 * Request.response(), Response.allHeaders(): playwright-core/types/types.d.ts). */
function recordContextRequests(context: BrowserContext): () => Promise<RecordedRequest[]> {
  const requests: Request[] = [];
  context.on("request", (request) => requests.push(request));
  return async () =>
    Promise.all(
      requests.map(async (request) => {
        const response = await request.response();
        return {
          url: request.url(),
          headers: Object.entries(await request.allHeaders()),
          responseHeaders: response ? Object.entries(await response.allHeaders()) : [],
        };
      }),
    );
}

/** `text` with every secret replaced by a placeholder, for the location part of a failure message. */
function redact(text: string, secrets: readonly string[]): string {
  return secrets.reduce((out, secret) => (secret ? out.split(secret).join("[secret]") : out), text);
}

/**
 * Types the code into the code-entry cells as key presses sent over CDP. `page.keyboard.type(code)` would put the
 * code into its step title (`Type "<code>"`, playwright-core coreBundle protocol metainfo), which the HTML reporter
 * writes to disk; `CDPSession.send` has the fixed title "Send CDP command". Input.dispatchKeyEvent with `text`
 * inserts the character like a real key (chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchKeyEvent);
 * the security project is Chromium (Desktop Chrome), where `BrowserContext.newCDPSession` exists (types.d.ts).
 */
async function typeCodeQuietly(page: Page, baseUrl: string, code: string): Promise<void> {
  await page.goto(`${baseUrl}/`);
  await page.locator(".code-entry__cell").first().click();
  const cdp = await page.context().newCDPSession(page);
  for (const ch of code) {
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
  }
  await cdp.detach();
  await page.locator(".code-entry__join").click();
}

/**
 * Starts navigating to `url` (which carries the code in its fragment) without `page.goto(url)`, whose step title
 * (`Navigate to "<url>"`) and error text would hold it: the page navigates itself from an `Evaluate` step (fixed
 * title; the argument is not shown). No `waitForURL`: its timeout call log lists `navigated to "<url>"`; the
 * caller waits on a locator assertion instead, which retries across the navigation.
 */
async function openQuietly(page: Page, url: string): Promise<void> {
  await page.evaluate((target) => void setTimeout(() => location.assign(target), 0), url);
}

// No Playwright trace for this file: it would store the Authorization headers (viewer tokens) and the typed code
// in `trace.zip`, which CI uploads (NFR-12). Failures are diagnosed from the findings (kind + line).
test.use({ trace: "off" });

test.describe("QA-07 log grep (FR-29, FR-31, NFR-12, NFR-15, T6)", () => {
  test("mutation: the grep flags each injected kind of leak in a clean log, by kind and line only", () => {
    const secrets: Secrets = {
      codes: ["7KQ4X"],
      publisherTokens: ["pt_Mn3Vq8YtK2cR9xLwZaBdE7fGhJ4uP6sTvW1yXoNQ5kA"],
      viewerTokens: ["vt_8dKq2ZrT7nWbY4mCfH6vJ9xLpA3sE5uG1oRtN0iQkDw"],
      ...fixtureSecrets(STACK_FIXTURE),
      clientIps: [...LOOPBACK, "198.51.100.7"],
    };
    const clean = [
      `{"level":"info","time":1,"port":8787,"message":"relay listening"}`,
      `{"level":"info","time":2,"sessionId":"sess_01K7Q4XMB2TJ9RD6","profile":"mobile","message":"session created"}`,
      `{"level":"info","time":3,"errorCode":"INVALID_CODE","message":"viewer join refused"}`,
      `{"level":"debug","time":4,"sha256":"2a3bb2bcf4ae09c2bebda8e29dbfb9f3ef18324f95790ca8e2accef95829e89c","message":"x"}`,
      `{"level":"info","time":5,"heapSizeLimit":4345298944,"version":"0.3.0","message":"relay starting"}`,
      "",
    ].join("\n");
    expect(grepLog(clean, { secrets }), "the clean sample must pass").toEqual([]);

    const glb = readFileSync(resolveFixture(STACK_FIXTURE));
    const bin = glbBinOffset(glb);
    const injections: [FindingKind, string][] = [
      ["session-code", `"note":"${secrets.codes![0]}x"`],
      ["session-code", `"note":"${secrets.codes![0]!.toLowerCase()}"`],
      ["publisher-token", `"t":"${secrets.publisherTokens![0]}"`],
      ["viewer-token", `"t":"${secrets.viewerTokens![0]}"`],
      ["node-name", `"n":"${secrets.nodeNames![0]}"`],
      ["node-id", `"n":"${secrets.nodeIds![0]}"`],
      ["client-ip", `"remoteAddress":"127.0.0.1"`],
      ["client-ip", `"remoteAddress":"::ffff:127.0.0.1"`],
      ["client-ip", `"ip":"198.51.100.7"`],
      ["glb-bytes", `"b":"${Buffer.from(glb.subarray(bin, bin + 24)).toString("base64")}"`],
      ["glb-bytes", `"b":"${Buffer.from(glb.subarray(bin + 5, bin + 30)).toString("hex")}"`],
      ["glb-magic", `"b":"glTF"`],
      ["ip-literal", `"peer":"203.0.113.9"`],
      ["ip-literal", `"peer":"2001:db8::1"`],
      ["token-shaped", `"t":"vt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"`],
      ["bearer-credential", `"auth":"Bearer abcdefgh12345678"`],
      ["code-shaped", `"code":"ZZZZZ"`],
      ["code-shaped", `"note":"HJK23"`],
      ["code-shaped", `"url":"/j#hjk23"`],
    ];
    const lines = clean.split("\n");
    for (const [kind, field] of injections) {
      const target = 2; // 0-based index: the "session created" line
      const mutated = [...lines];
      mutated[target] = mutated[target]!.replace(`"message"`, `${field},"message"`);
      const findings = grepLog(mutated.join("\n"), { secrets });
      expect(
        findings.some((f) => f.kind === kind && f.line === target + 1),
        `injected ${kind} not flagged at line ${target + 1}`,
      ).toBe(true);
      // A finding never repeats the value.
      expect(JSON.stringify(findings).includes(field), "a finding carries the matched text").toBe(false);
    }

    // Structure rules: a non-JSON line, a JSON line without level, one without message.
    const structural: [FindingKind, string][] = [
      ["not-json", "Server listening at port 8787"],
      ["not-json", `[1,2,3]`],
      ["missing-level", `{"time":1,"message":"x"}`],
      ["missing-level", `{"level":30,"time":1,"message":"x"}`],
      ["missing-message", `{"level":"info","time":1,"msg":"x"}`],
    ];
    for (const [kind, line] of structural) {
      const findings = grepLog([...lines.slice(0, 3), line, ...lines.slice(3)].join("\n"), { secrets });
      expect(findings, `${kind} not flagged`).toContainEqual({ kind, line: 4 });
    }
    // Without the secret list the generic rules still catch the token and IP shapes (LOG_FILE mode).
    const generic = grepLog(`{"level":"info","t":"${secrets.viewerTokens![0]}","ip":"::1","message":"m"}`);
    expect([...kinds(generic)].sort()).toEqual(["ip-literal", "token-shaped"]);
    // Timestamps and versions are not IP literals.
    expect(grepLog(`{"level":"info","at":"10:11:12","v":"1.2.3","bind":"0.0.0.0","message":"m"}`)).toEqual([]);
  });

  test("a whole session at trace level leaves no code, token, address, node name or GLB byte in logs or requests", async ({
    stack,
    browser,
  }) => {
    test.setTimeout(120_000);
    const code = stack.code;
    const usedIps: string[] = [];
    const ip = () => {
      const value = nextIp();
      usedIps.push(value);
      return value;
    };
    const captured = { viewerTokens: [] as string[], publisherTokens: [] as string[], codes: [code] };
    const sockets = { viewerTokens: captured.viewerTokens, framesWithCode: 0, urls: [] as string[] };

    // HAR outside the test output directory (never uploaded) and deleted below. `/api/scene` requests are not
    // recorded in it: their `Authorization` header is a viewer token, which must not reach a file (NFR-12); the
    // in-memory request list covers them. recordHar options: playwright-core/types/types.d.ts (urlFilter, content).
    const harDir = mkdtempSync(path.join(tmpdir(), "qa07-har-"));
    const harPath = path.join(harDir, "session.har");
    let harText = "";
    let requests: RecordedRequest[] = [];
    try {
      const context = await browser.newContext({
        recordHar: { path: harPath, content: "omit", urlFilter: /^(?!.*\/api\/scene\/)/ },
      });
      const collect = recordContextRequests(context);

      await test.step("viewer 1 joins by typing the code (late join: GET /api/scene/1)", async () => {
        const page = await context.newPage();
        watchSockets(page, sockets, () => code);
        await typeCodeQuietly(page, stack.baseUrl, code);
        await expectModelLoaded(page);
      });
      await test.step("viewer 2 joins through the deep link /j#code", async () => {
        const page = await context.newPage();
        watchSockets(page, sockets, () => code);
        await openQuietly(page, `${stack.baseUrl}/j#${code}`);
        await expectModelLoaded(page);
        // The viewer removed the fragment with history.replaceState (§10): the code left the address bar.
        expect(page.url().includes(code), "the code is still in the address bar").toBe(false);
        await stack.publisher!.waitForEvent((e) => "event" in e && e.event === "viewer.count" && e.count === 2);
      });

      await test.step("a raw viewer with a wrong code is refused (INVALID_CODE, 4004)", async () => {
        // The guessed code is user input the relay must not echo into its log either: forbidden like a real code.
        const wrong = otherCode([code]);
        captured.codes.push(wrong);
        const guesser = await connect(stack.wsUrl, { ip: ip() });
        guesser.send({
          type: "viewer.join",
          id: "v-1",
          code: wrong,
          clientInfo: { app: "web-viewer", version: "0.0.0-qa", platform: "web", profile: "mobile" },
        });
        expect((await guesser.next("error")).code).toBe("INVALID_CODE");
        expect((await guesser.closedWithin()).code).toBe(4004);
      });

      await test.step("a raw viewer joins the stack's session and fetches the scene with its token", async () => {
        const viewerIp = ip();
        const { client, joined } = await joinViewer(stack.wsUrl, code, { ip: viewerIp });
        captured.viewerTokens.push(joined.viewerToken as string);
        const response = await fetch(`${stack.baseUrl}/api/scene/1`, {
          headers: { Authorization: `Bearer ${joined.viewerToken as string}`, "X-Forwarded-For": viewerIp },
        });
        expect(response.status).toBe(200);
        await response.arrayBuffer();
        client.close();
        await client.closedWithin();
      });

      await test.step("a raw publisher creates a session, publishes, gets a viewer, and closes it", async () => {
        const { client: publisher, created } = await createSession(stack.wsUrl, { ip: ip() });
        captured.codes.push(created.code as string);
        captured.publisherTokens.push(created.publisherToken as string);
        const glb = await loadGlb(resolveFixture(RAW_FIXTURE));
        let id = 1;
        await sendSnapshot(publisher.socket, { glb, sceneVersion: 1, chunkSize: 65_536, profile: "mobile" }, () =>
          `p-${++id}`,
        );
        await publisher.next("scene.snapshot.ack", 10_000);

        const viewerIp = ip();
        const { client: viewer, joined } = await joinViewer(stack.wsUrl, created.code as string, { ip: viewerIp });
        captured.viewerTokens.push(joined.viewerToken as string);
        const response = await fetch(`${stack.baseUrl}/api/scene/1`, {
          headers: { Authorization: `Bearer ${joined.viewerToken as string}`, "X-Forwarded-For": viewerIp },
        });
        expect(response.status).toBe(200);
        await response.arrayBuffer();

        publisher.send({ type: "session.close", id: "p-close", reason: "USER_STOPPED" });
        expect((await viewer.next("session.closed")).reason).toBe("PUBLISHER_CLOSED");
        expect((await viewer.closedWithin()).code).toBe(4001);
        await publisher.closedWithin().catch(() => publisher.close());
        // The closed session's token now answers 410 (§10): one more /api/scene line in the log.
        const gone = await fetch(`${stack.baseUrl}/api/scene/1`, {
          headers: { Authorization: `Bearer ${joined.viewerToken as string}`, "X-Forwarded-For": viewerIp },
        });
        expect(gone.status).toBe(410);
      });

      expect(sockets.framesWithCode, "the code travelled in the pages' WebSocket frame bodies").toBeGreaterThan(0);
      expect(captured.viewerTokens.length, "viewer tokens captured (2 pages + 2 raw)").toBeGreaterThanOrEqual(4);
      requests = await collect();
      await context.close(); // writes the HAR
      harText = readFileSync(harPath, "utf8");
    } finally {
      rmSync(harDir, { recursive: true, force: true });
    }

    // Stop publisher and relay: pino's async destination is flushed on exit.
    await stack.stop();
    expect(await stack.relay.exited).toBe(0);

    const secrets = merge(
      captured,
      fixtureSecrets(STACK_FIXTURE),
      fixtureSecrets(RAW_FIXTURE),
      // Raw addresses, and their unsalted SHA-256 (reversible for IPv4): the relay logs only an HMAC under a
      // per-boot key (architecture §5 "Logging").
      { clientIps: [...LOOPBACK, ...usedIps].flatMap((a) => [a, createHash("sha256").update(a).digest("hex")]) },
    );

    await test.step("relay log: JSON lines with level/message and nothing secret", async () => {
      const log = stack.relay.log();
      const lines = log.split("\n").filter((l) => l.trim() !== "");
      expect(lines.length, "the trace log has content").toBeGreaterThan(20);
      // Sanity: the scenarios really reached the log (counts only).
      for (const message of ["session created", "viewer joined", "viewer join refused", "session closed by publisher"])
        expect(log.includes(`"message":"${message}"`), `log line "${message}" present`).toBe(true);
      const findings = grepLog(log, { secrets });
      expect(findings, describeFindings(findings, "relay log")).toEqual([]);

      // Mutation on the real log (acceptance 1): each injected secret is flagged at its line.
      const injections: [FindingKind, string][] = [
        ["session-code", code],
        ["publisher-token", captured.publisherTokens[0]!],
        ["viewer-token", captured.viewerTokens[0]!],
        ["client-ip", usedIps[0]!],
        ["client-ip", "127.0.0.1"],
        ["node-name", secrets.nodeNames![0]!],
        ["node-id", secrets.nodeIds![0]!],
      ];
      const target = Math.floor(lines.length / 2);
      for (const [kind, value] of injections) {
        const mutated = [...lines];
        mutated[target] = mutated[target]!.replace(`"message":"`, `"message":"${value} `);
        const found = grepLog(mutated.join("\n"), { secrets });
        expect(found.some((f) => f.kind === kind && f.line === target + 1), `injected ${kind} not flagged`).toBe(true);
      }
      const broken = [...lines.slice(0, target), "plain text line", ...lines.slice(target)].join("\n");
      expect(grepLog(broken, { secrets }), "non-JSON line not flagged").toContainEqual({
        kind: "not-json",
        line: target + 1,
      });
    });

    await test.step("fake-slicer stdout/stderr: no code and no scene content", async () => {
      const { stdout, stderr } = stack.publisher!.outputs();
      for (const [name, text] of [
        ["fake-slicer stdout", stdout],
        ["fake-slicer stderr", stderr],
      ] as const) {
        const findings = grepLog(text, { secrets, json: false });
        expect(findings, describeFindings(findings, name)).toEqual([]);
      }
    });

    await test.step("every file the harness wrote for this stack (CI artefacts): nothing secret", async () => {
      // relay.log, publisher.log and whatever else lands next to them in the stack directory: these are the
      // files CI uploads (tests/README.md), so they get the secret rules; only relay.log must be pino JSON.
      const dir = path.dirname(stack.logPath);
      const files = readdirSync(dir).filter((name) => statSync(path.join(dir, name)).isFile());
      expect(files.includes("relay.log") && files.includes("publisher.log"), "both logs on disk").toBe(true);
      for (const name of files) {
        const text = readFileSync(path.join(dir, name), "utf8");
        const findings = grepLog(text, { secrets, json: name === "relay.log" });
        expect(findings, describeFindings(findings, name)).toEqual([]);
      }
    });

    await test.step("browser requests (in memory): no code in any URL or header; tokens only in Authorization", async () => {
      const tokens = [...captured.viewerTokens, ...captured.publisherTokens];
      const allSecrets = [...captured.codes, ...tokens];
      const scene = requests.filter((r) => new URL(r.url).pathname.startsWith("/api/scene/"));
      expect(scene.length, "both pages fetched /api/scene/1 (late join)").toBeGreaterThanOrEqual(2);
      for (const r of scene)
        expect(
          r.headers.some(([k, v]) => k === "authorization" && captured.viewerTokens.some((t) => v === `Bearer ${t}`)),
          "a scene request carries its viewer token in Authorization",
        ).toBe(true);
      expect(sockets.urls.length, "the pages opened their WebSockets").toBeGreaterThanOrEqual(2);
      for (const url of sockets.urls) {
        const ws = new URL(url);
        expect(ws.pathname === "/ws" && ws.search === "" && ws.hash === "", "WebSocket URL is the bare /ws").toBe(true);
        expect(captured.codes.some((c) => url.includes(c)), "code in the WebSocket URL").toBe(false);
      }
      requests.forEach((r, index) => {
        // The fragment of `/j#code` is not part of what goes on the wire (RFC 3986 §3.5): check the sent URL.
        const sent = new URL(r.url);
        sent.hash = "";
        // The location in a failure message is redacted: a leaked code in the path must not reach the CI log.
        const where = `request ${index} (${redact(sent.pathname, allSecrets)})`;
        expect(captured.codes.some((c) => sent.href.includes(c)), `${where}: code in the URL`).toBe(false);
        for (const [name, value] of r.headers) {
          const header = redact(name, allSecrets);
          expect(captured.codes.some((c) => value.includes(c)), `${where}: code in header ${header}`).toBe(false);
          const token = tokens.some((t) => value.includes(t));
          if (token) expect(header, `${where}: a token outside Authorization`).toBe("authorization");
        }
        // Nor does the relay answer with one: no code or token in any response header (FR-31).
        for (const [name, value] of r.responseHeaders) {
          const header = redact(name, allSecrets);
          expect(allSecrets.some((s) => value.includes(s)), `${where}: secret in response header ${header}`).toBe(false);
        }
      });
      expect(requests.filter((r) => r.responseHeaders.length > 0).length, "responses were recorded").toBeGreaterThan(3);
      // The deep link's navigation is the only request whose URL had a fragment, and it is `/j`.
      const withHash = requests.filter((r) => new URL(r.url).hash !== "");
      for (const r of withHash)
        expect(new URL(r.url).pathname === "/j", "only the /j navigation carried a fragment").toBe(true);
    });

    await test.step("HAR: no code in any recorded URL or header", async () => {
      const har = JSON.parse(harText) as {
        log: { entries: { request: { url: string; headers: { name: string; value: string }[] } }[] };
      };
      expect(har.log.entries.length, "the HAR recorded the session").toBeGreaterThan(3);
      // Nothing anywhere in the file (responses and timings included) holds a code or token.
      expect(captured.codes.some((c) => harText.includes(c)), "a code in the HAR").toBe(false);
      const tokens = [...captured.viewerTokens, ...captured.publisherTokens];
      expect(tokens.some((t) => harText.includes(t)), "a token in the HAR").toBe(false);
      har.log.entries.forEach((entry, index) => {
        const sent = new URL(entry.request.url);
        sent.hash = "";
        const where = `HAR entry ${index} (${redact(sent.pathname, [...captured.codes, ...tokens])})`;
        expect(captured.codes.some((c) => sent.href.includes(c)), `${where}: code in the URL`).toBe(false);
        for (const { name, value } of entry.request.headers) {
          const header = redact(name, [...captured.codes, ...tokens]);
          expect(captured.codes.some((c) => value.includes(c)), `${where}: code in header ${header}`).toBe(false);
          const token = tokens.some((t) => value.includes(t));
          if (token) expect(header.toLowerCase(), `${where}: a token outside Authorization`).toBe("authorization");
        }
      });
    });
  });

  test("LOG_FILE artefact: JSON lines, no IP literal, glTF magic, token- or code-shaped value", async () => {
    const input = process.env["LOG_FILE"];
    test.skip(!input, "set LOG_FILE=<relay log or directory of relay.log files> to grep a CI artefact (DEP-10)");
    // A file, or a directory (an unpacked test-results artefact) whose `relay.log` files are all grepped;
    // `readdirSync(…, { recursive: true })` is Node ≥ 20.1 (nodejs.org/api/fs.html#fsreaddirsyncpath-options).
    const files = statSync(input!).isDirectory()
      ? readdirSync(input!, { recursive: true, encoding: "utf8" })
          .filter((name) => path.basename(name) === "relay.log")
          .map((name) => path.join(input!, name))
      : [input!];
    expect(files.length, "LOG_FILE names no relay log").toBeGreaterThan(0);
    let lines = 0;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      lines += text.split("\n").filter((l) => l.trim() !== "").length;
      const findings = grepLog(text);
      expect(findings, describeFindings(findings, path.relative(input!, file) || path.basename(file))).toEqual([]);
    }
    expect(lines, "LOG_FILE holds no log lines").toBeGreaterThan(0);
  });
});
