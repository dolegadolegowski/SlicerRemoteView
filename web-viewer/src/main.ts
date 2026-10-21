// Entry point: wires the modules. Joining by code (WEB-03/04) or `/j#CODE` (WEB-11), snapshots over the WebSocket
// stream (WEB-05) or HTTP (WEB-06), the scene model (WEB-07), the viewer (WEB-08), live updates (WEB-12),
// reconnecting (WEB-14), the status bar (WEB-15), the wake lock and the renderer test hook (WEB-16), the language
// switch (WEB-21), Leave (WEB-22), WebXR on Meta Quest Browser (WEB-19);
// `ui/screens.ts` decides which screen is visible.
import { browserStorage, createLangStore } from "./i18n/lang";
import { createConnection, endsSession } from "./protocol/connection";
import type { ConnectionState } from "./protocol/connection";
import { createReconnect } from "./protocol/reconnect";
import { currentDevice, snapshotLimit } from "./platform";
import { bindStreamToLoader, createSceneLoader } from "./protocol/scene-loader";
import { bindSceneVersions, createSceneVersions } from "./protocol/scene-versions";
import { bindSnapshotStream, createSnapshotStream } from "./protocol/snapshot-stream";
import { createLiveScene } from "./render/apply-update";
import type { LiveScene } from "./render/apply-update";
import { bindModelLifecycle } from "./render/model-lifecycle";
import { createSceneModelStore } from "./render/scene-model";
import { describeState } from "./state/errors";
import type { Description } from "./state/errors";
import { createCodeEntry } from "./ui/code-entry";
import { startFromDeepLink, takeDeepLink } from "./ui/deep-link";
import { startDevOverlay } from "./ui/dev-overlay";
import { createLangToggle } from "./ui/lang-toggle";
import { bindScreens } from "./ui/screens";
import { bindWakeLock } from "./ui/wake-lock";
import { t } from "./i18n/strings";
import { quest2Concern } from "./xr/budget";
import { enterXr, preloadXr } from "./xr/enter";
import { XR_PANEL_NAME } from "./xr/placement";
import { browserXr, xrMode } from "./xr/support";

// First of all: a `/j#CODE` link leaves the address bar before anything can reach the network (WEB-11, T6).
const link = takeDeepLink();
const app = document.getElementById("app");
if (app) {
  // The user's language choice, else the browser's; `<html lang>` follows it. Only the language is stored (WEB-21).
  const langs = createLangStore({ storage: browserStorage(), root: document.documentElement });
  // `clientInfo.platform`/`profile` from the user agent (WEB-15); nothing else about the device is sent (§5.1). The
  // snapshot limit follows the profile and is the same for the announcement, the stream and the download.
  const device = currentDevice();
  const maxSnapshotBytes = snapshotLimit(device.profile);
  const connection = createConnection({ clientInfo: device, maxSnapshotBytes });
  const session = createReconnect(connection); // memory only: the code and the token (CLAUDE.md rule 6)
  // A closed state the reconnect logic retries (e.g. the code not re-created yet after a relay restart) keeps the
  // scene, the token and the versions; the new session's `viewer.joined` replaces them (WEB-14).
  const ends = (state: ConnectionState) => endsSession(state) && !session.willRetry(state);
  const stream = createSnapshotStream({ maxSnapshotBytes });
  // Live updates go to the scene shown, in version order (WEB-12); `live` follows the model.
  let live: LiveScene | null = null;
  const versions = createSceneVersions({
    apply(message) {
      screens.sceneVersion(message.sceneVersion); // the status bar (WEB-15)
      if (message.type === "scene.nodeAdded") return screens.updating(true); // a snapshot follows (§8.2)
      if (!live) return;
      const applied =
        message.type === "scene.update"
          ? live.apply(message.changes)
          : live.remove(message.nodeIds);
      screens.sceneChanged(applied);
      screens.presenterChanged(applied.overridden); // WEB-13: a local choice was replaced
    },
    applyState(state) {
      if (!live) return;
      screens.sceneVersion(state.sceneVersion);
      const changed = live.apply(state.nodes);
      const removed = live.remove(state.removed);
      screens.sceneChanged({
        changed: changed.changed || removed.changed,
        removed: removed.removed,
      });
      screens.presenterChanged(changed.overridden);
    },
    requestResync: (reason) => void loader.requestResync(reason),
  });
  const loader = createSceneLoader(connection, {
    haveSceneVersion: () => versions.sceneVersion ?? loader.loadedVersion ?? 0,
    ends,
    maxSnapshotBytes,
  });
  const models = createSceneModelStore();
  bindSnapshotStream(connection, stream);
  bindStreamToLoader(connection, stream, loader);
  /** A snapshot that will not be shown: updates go back to the scene shown, and the "updating" hint goes. */
  const abandon = (sceneVersion: number) => {
    versions.abandon(sceneVersion);
    screens.updating(false);
  };
  // The lifecycle subscribes before the screens, so a different session's model is cleared before they react.
  bindModelLifecycle(
    connection,
    [stream, loader],
    models,
    (sceneVersion) => {
      abandon(sceneVersion);
      screens.report(describeState({ kind: "snapshotInvalid" }));
    },
    ends,
  );
  bindSceneVersions(connection, versions, ends);
  // The "updating" hint of scene.nodeAdded waits for the snapshot it announces; a SUPERSEDED one has a newer
  // begin right behind it (§6.2).
  connection.onMessage("scene.snapshot.begin", () => screens.snapshotComing());
  connection.onMessage("scene.snapshot.ready", () => screens.snapshotComing());
  connection.onMessage("scene.snapshot.abort", (m) => {
    if (m.reason !== "SUPERSEDED") screens.updating(false);
  });
  const entry = createCodeEntry({
    onJoin: (code) => screens.join(code),
    onLeave: () => screens.leave(), // WEB-22
    lang: langs.lang,
    languageToggle: createLangToggle(langs, { className: "code-entry__lang" }).element,
  });
  const screens = bindScreens({
    app,
    connection,
    session,
    models,
    entry,
    downloading: () => loader.pendingVersion !== null || stream.activeVersion !== null,
    lang: langs,
  });
  // After the screens: a new model is on screen (with its node panel) before queued updates are applied to it.
  models.onChange((model) => {
    live = model ? createLiveScene(model) : null;
    // First the snapshot's version: `shown` applies a waiting `scene.state` and queued updates, which raise it.
    screens.sceneVersion(model?.snapshotVersion ?? null);
    versions.shown(model?.snapshotVersion ?? null);
  });

  /** Leaves the session (the code entry comes back) and shows `description` there. */
  const stop = (description: Description) => {
    session.leave();
    entry.setError(description);
  };
  const tooLarge = ({ sceneVersion }: { readonly sceneVersion: number }) => {
    abandon(sceneVersion);
    screens.report(describeState({ kind: "snapshotTooLarge" }));
  };
  stream.on("tooLarge", tooLarge);
  loader.on("tooLarge", tooLarge);
  // Downloads that gave up (attempts exhausted, repeated 404 or mismatch) must not leave the user on "Joining…".
  loader.on("failed", ({ sceneVersion }) => {
    abandon(sceneVersion);
    screens.failSnapshot();
  });
  loader.on("enterCode", ({ description }) => stop(description));
  loader.on("sessionEnded", ({ description }) => stop(description));

  bindWakeLock(connection, { ends }); // the screen stays on during the session (WEB-16, FR-46)
  // Quest Browser with WebXR: the viewer offers AR (passthrough) or VR (WEB-19, FR-47).
  const xr = browserXr();
  void xrMode(xr, device.platform).then((mode) => {
    if (!mode || !xr) return;
    preloadXr();
    // On a Quest 2 a scene above its budget may stutter: the headset says so (WEB-20, §7.5).
    const warning = () => {
      const concern =
        device.profile === "quest2" && models.current ? quest2Concern(models.current) : null;
      if (!concern) return null;
      return t(langs.lang, concern === "triangles" ? "xr.quest2Budget" : "xr.quest2Profile");
    };
    // The status lines, which the page shows, are repeated in the headset (WEB-23).
    const status = () => screens.xrStatus;
    screens.offerXr(mode, (host, ended) =>
      enterXr(host, xr, mode, { onEnd: ended, warning: warning(), status }),
    );
  });
  // Test hook (WEB-16): GPU resource counts only — no scene content, names or credentials.
  const rendererInfo = () => screens.viewer?.rendererInfo() ?? null;
  // Test hook (WEB-20): where the scene stands in XR — numbers only.
  const xrStage = () => screens.viewer?.xr?.stageMatrix().toArray() ?? null;
  // Test hook (WEB-23): how many text panels the headset shows — a count, not their text.
  const xrPanels = () =>
    screens.viewer?.xr?.scene.getObjectsByProperty("name", XR_PANEL_NAME).length ?? 0;
  (window as unknown as { __rv: object }).__rv = { rendererInfo, xrStage, xrPanels };
  if (import.meta.env.DEV) startDevOverlay(rendererInfo);

  app.append(entry.element);
  if (!startFromDeepLink(link, entry, screens)) entry.focus();
  // A link opened again in this tab only changes the fragment (no reload): take it the same way.
  window.addEventListener("hashchange", () => startFromDeepLink(takeDeepLink(), entry, screens));
  app.dataset["ready"] = "true";
}
