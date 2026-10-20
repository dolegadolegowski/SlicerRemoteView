// Entry point: wires the modules. Joining by code (WEB-03/04) or `/j#CODE` (WEB-11), snapshots over the WebSocket
// stream (WEB-05) or HTTP (WEB-06), the scene model (WEB-07) and the viewer (WEB-08); `ui/screens.ts` decides which
// screen is visible.
import { createConnection } from "./protocol/connection";
import { bindStreamToLoader, createSceneLoader } from "./protocol/scene-loader";
import { bindSnapshotStream, createSnapshotStream } from "./protocol/snapshot-stream";
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
  const loader = createSceneLoader(connection);
  const models = createSceneModelStore();
  bindSnapshotStream(connection, stream);
  bindStreamToLoader(connection, stream, loader);
  // The lifecycle subscribes before the screens, so a different session's model is cleared before they react.
  bindModelLifecycle(connection, [stream, loader], models, () =>
    screens.report(describeState({ kind: "snapshotInvalid" })),
  );
  const entry = createCodeEntry({ onJoin: (code) => screens.join(code) });
  const screens = bindScreens({ app, connection, models, entry });

  /** Leaves the session (the code entry comes back) and shows `description` there. */
  const stop = (description: Description) => {
    connection.leave();
    entry.setError(description);
  };
  const tooLarge = () => screens.report(describeState({ kind: "snapshotTooLarge" }));
  stream.on("tooLarge", tooLarge);
  loader.on("tooLarge", tooLarge);
  // Downloads that gave up (attempts exhausted, repeated 404 or mismatch) must not leave the user on "Joining…".
  loader.on("failed", () => screens.failSnapshot());
  loader.on("enterCode", ({ description }) => stop(description));
  loader.on("sessionEnded", ({ description }) => stop(description));

  app.append(entry.element);
  if (!startFromDeepLink(link, entry, screens)) entry.focus();
  // A link opened again in this tab only changes the fragment (no reload): take it the same way.
  window.addEventListener("hashchange", () => startFromDeepLink(takeDeepLink(), entry, screens));
  app.dataset["ready"] = "true";
}
