// Entry point: wires the modules. Joining by code (WEB-03/04) or `/j#CODE` (WEB-11), snapshots over the WebSocket
// stream (WEB-05) or HTTP (WEB-06), the scene model (WEB-07), the viewer (WEB-08) and live updates (WEB-12);
// `ui/screens.ts` decides which screen is visible.
import { createConnection } from "./protocol/connection";
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
import { bindScreens } from "./ui/screens";

// First of all: a `/j#CODE` link leaves the address bar before anything can reach the network (WEB-11, T6).
const link = takeDeepLink();
const app = document.getElementById("app");
if (app) {
  const connection = createConnection();
  const stream = createSnapshotStream();
  // Live updates go to the scene shown, in version order (WEB-12); `live` follows the model.
  let live: LiveScene | null = null;
  const versions = createSceneVersions({
    apply(message) {
      if (message.type === "scene.nodeAdded") return screens.updating(true); // a snapshot follows (§8.2)
      if (!live) return;
      screens.sceneChanged(
        message.type === "scene.update"
          ? live.apply(message.changes)
          : live.remove(message.nodeIds),
      );
    },
    applyState(state) {
      if (!live) return;
      const changed = live.apply(state.nodes);
      const removed = live.remove(state.removed);
      screens.sceneChanged({
        changed: changed.changed || removed.changed,
        removed: removed.removed,
      });
    },
    requestResync: (reason) => void loader.requestResync(reason),
  });
  const loader = createSceneLoader(connection, {
    haveSceneVersion: () => versions.sceneVersion ?? loader.loadedVersion ?? 0,
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
  bindModelLifecycle(connection, [stream, loader], models, (sceneVersion) => {
    abandon(sceneVersion);
    screens.report(describeState({ kind: "snapshotInvalid" }));
  });
  bindSceneVersions(connection, versions);
  // The "updating" hint of scene.nodeAdded waits for the snapshot it announces; a SUPERSEDED one has a newer
  // begin right behind it (§6.2).
  connection.onMessage("scene.snapshot.begin", () => screens.snapshotComing());
  connection.onMessage("scene.snapshot.ready", () => screens.snapshotComing());
  connection.onMessage("scene.snapshot.abort", (m) => {
    if (m.reason !== "SUPERSEDED") screens.updating(false);
  });
  const entry = createCodeEntry({ onJoin: (code) => screens.join(code) });
  const screens = bindScreens({ app, connection, models, entry });
  // After the screens: a new model is on screen (with its node panel) before queued updates are applied to it.
  models.onChange((model) => {
    live = model ? createLiveScene(model) : null;
    versions.shown(model?.snapshotVersion ?? null);
  });

  /** Leaves the session (the code entry comes back) and shows `description` there. */
  const stop = (description: Description) => {
    connection.leave();
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

  app.append(entry.element);
  if (!startFromDeepLink(link, entry, screens)) entry.focus();
  // A link opened again in this tab only changes the fragment (no reload): take it the same way.
  window.addEventListener("hashchange", () => startFromDeepLink(takeDeepLink(), entry, screens));
  app.dataset["ready"] = "true";
}
