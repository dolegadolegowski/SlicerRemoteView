// QA-14 helpers: a raw publisher that keeps its session id, publisher token and code in memory (fake-slicer never
// exposes them, so the token and isolation cases drive the protocol themselves), token rejoins, scene fetches and
// the "the relay still serves the bystander session" check every negative case ends with (NFR-23).
//
// Secrets (NFR-12): codes and tokens live only in the returned objects. Nothing here prints, logs or throws them;
// error messages name message types and error codes only.

import { readFileSync } from "node:fs";
import { encodeChunkFrame, chunkify, chunkCountFor } from "@slicerremoteview/shared";
import { loadGlb, resolveFixture } from "@slicerremoteview/fake-slicer";
import type { LoadedGlb } from "@slicerremoteview/fake-slicer";
import { expect } from "@playwright/test";
import { FIXTURE_MANIFEST } from "./paths.ts";
import { Client, connect, createSession, joinViewer, nextIp } from "./ws-client.ts";
import type { ClientOptions, Message } from "./ws-client.ts";

/** clientInfo of a harness viewer (§5.1). */
export const VIEWER_INFO = {
  app: "web-viewer",
  version: "0.0.0-qa",
  platform: "web",
  profile: "mobile",
  capabilities: { httpScene: true, maxSnapshotBytes: 67_108_864 },
} as const;

/** clientInfo of a harness publisher (§4.1). */
export const PUBLISHER_INFO = { app: "SlicerRemoteView", version: "0.0.0-qa", platform: "qa-harness" } as const;

interface ManifestEntry {
  byteLength: number;
  sha256: string;
  nodeIds: string[];
}

/** `byteLength`, `sha256` and `nodeIds` of a fixture from `shared/fixtures/glb/manifest.json`. */
export function fixtureInfo(name: string): ManifestEntry {
  const manifest = JSON.parse(readFileSync(FIXTURE_MANIFEST, "utf8")) as { files: Record<string, ManifestEntry> };
  const entry = manifest.files[name];
  if (!entry) throw new Error(`fixture ${name} is not in the manifest`);
  return entry;
}

/** A well-formed token (§5.2: ≥ 43 base64url characters) that no relay issued. */
export function forgedToken(prefix: "pt_" | "vt_"): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let token = prefix;
  for (let i = 0; i < 43; i++) token += alphabet[Math.floor(Math.random() * alphabet.length)];
  return token;
}

/** A publisher socket driven by the spec; `sessionId`, `token` and `code` stay in memory only. */
export interface RawPublisher {
  readonly client: Client;
  readonly sessionId: string;
  readonly token: string;
  readonly code: string;
  /** Last version this publisher used (snapshots and updates share the counter, §8.4). */
  sceneVersion: number;
  /** begin → chunks → end of `fixture` as `sceneVersion`; resolves with `scene.snapshot.ack`. */
  publish(fixture: string, sceneVersion: number, chunkSize?: number): Promise<{ glb: LoadedGlb; ack: Message }>;
  /** `scene.update` from the current version to `sceneVersion` (§8.1). */
  update(sceneVersion: number, changes: Record<string, unknown>[]): void;
}

let idCounter = 0;
const nextId = (): string => `qa14-${++idCounter}`;

/** `session.create` on a fresh address and a handle to publish with. */
export async function rawPublisher(wsUrl: string, options: ClientOptions = {}): Promise<RawPublisher> {
  const { client, created } = await createSession(wsUrl, { ip: nextIp(), ...options });
  const publisher: RawPublisher = {
    client,
    sessionId: String(created["sessionId"]),
    token: String(created["publisherToken"]),
    code: String(created["code"]),
    sceneVersion: 0,
    async publish(fixture, sceneVersion, chunkSize = 65_536) {
      const glb = await loadGlb(resolveFixture(fixture));
      client.send({
        type: "scene.snapshot.begin",
        id: nextId(),
        sceneVersion,
        byteLength: glb.bytes.byteLength,
        sha256: glb.sha256,
        chunkCount: chunkCountFor(glb.bytes.byteLength, chunkSize),
        chunkSize,
        format: "glb",
        extensionsUsed: glb.extensionsUsed,
        extensionsRequired: glb.extensionsRequired,
        profile: "mobile",
        nodeCount: glb.nodeCount,
        triangleCount: glb.triangleCount,
      });
      for (const { chunkIndex, payload } of chunkify(glb.bytes, chunkSize))
        client.sendRaw(Buffer.from(encodeChunkFrame({ sceneVersion, chunkIndex }, payload)), true);
      client.send({ type: "scene.snapshot.end", id: nextId(), sceneVersion, sha256: glb.sha256 });
      const ack = await client.next(
        (m) => (m.type === "scene.snapshot.ack" && m["sceneVersion"] === sceneVersion) || m.type === "error",
        30_000,
      );
      if (ack.type === "error") throw new Error(`snapshot ${sceneVersion} refused: ${String(ack["code"])}`);
      publisher.sceneVersion = sceneVersion;
      return { glb, ack };
    },
    update(sceneVersion, changes) {
      client.send({ type: "scene.update", id: nextId(), sceneVersion, baseVersion: publisher.sceneVersion, changes });
      publisher.sceneVersion = sceneVersion;
    },
  };
  return publisher;
}

/** A joined viewer with its credentials in memory. */
export interface JoinedViewer {
  readonly client: Client;
  readonly sessionId: string;
  readonly viewerId: string;
  readonly token: string;
  readonly joined: Message;
}

/** `viewer.join{code}` from a fresh address (the per-IP join limit is 10/min, §12). */
export async function viewerByCode(wsUrl: string, code: string): Promise<JoinedViewer> {
  const { client, joined } = await joinViewer(wsUrl, code, { ip: nextIp() });
  return {
    client,
    joined,
    sessionId: String(joined["sessionId"]),
    viewerId: String(joined["viewerId"]),
    token: String(joined["viewerToken"]),
  };
}

/** Sends `viewer.join{sessionId, viewerToken}` on a new socket; resolves with `viewer.joined` or `error`. */
export async function rejoin(
  wsUrl: string,
  sessionId: string,
  viewerToken: string,
): Promise<{ client: Client; reply: Message }> {
  const client = await connect(wsUrl, { ip: nextIp() });
  client.send({ type: "viewer.join", id: "v-rejoin", sessionId, viewerToken, clientInfo: VIEWER_INFO });
  const reply = await client.next((m) => m.type === "viewer.joined" || m.type === "error");
  return { client, reply };
}

/** `GET /api/scene/:v` (or a raw path) with an optional Bearer token. */
export async function fetchScene(
  baseUrl: string,
  pathOrVersion: number | string,
  token?: string,
  method: "GET" | "HEAD" = "GET",
): Promise<{ status: number; body: Buffer; headers: Headers }> {
  const path = typeof pathOrVersion === "number" ? `/api/scene/${pathOrVersion}` : pathOrVersion;
  const response = await fetch(baseUrl + path, {
    method,
    redirect: "manual",
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: Buffer.from(await response.arrayBuffer()), headers: response.headers };
}

/** `ping` → `pong` with `replyTo` on an open socket. */
export async function expectPong(client: Client, id = `hb-${++idCounter}`): Promise<void> {
  client.send({ type: "ping", id });
  const pong = await client.next((m) => m.type === "pong" && m["replyTo"] === id);
  expect(pong.type).toBe("pong");
}

/**
 * The bystander session is still served (NFR-23): its earlier viewer is open and answers `ping`, a new viewer joins
 * by code (`snapshotAvailable`, the expected GLB hash) and fetches the cached GLB over HTTP.
 */
export async function expectStillServing(
  wsUrl: string,
  baseUrl: string,
  code: string,
  bystander: Client,
  fixture = "asymmetric-2nodes.glb",
  sceneVersion = 1,
): Promise<void> {
  const info = fixtureInfo(fixture);
  expect(bystander.closeInfo, "the bystander viewer was closed").toBeUndefined();
  await expectPong(bystander);
  const fresh = await viewerByCode(wsUrl, code);
  try {
    expect(fresh.joined["snapshotAvailable"]).toBe(true);
    expect((fresh.joined["snapshot"] as { sha256?: string } | undefined)?.sha256).toBe(info.sha256);
    const scene = await fetchScene(baseUrl, sceneVersion, fresh.token);
    expect(scene.status).toBe(200);
    expect(scene.body.byteLength).toBe(info.byteLength);
  } finally {
    fresh.client.close();
  }
}
