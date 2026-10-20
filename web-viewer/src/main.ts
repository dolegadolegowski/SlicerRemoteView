// Entry point: wires the modules. Joining (WEB-03/04), snapshots over the WebSocket stream (WEB-05) or HTTP (WEB-06),
// the scene model (WEB-07) and the viewer (WEB-08); `ui/screens.ts` decides which screen is visible.
import { createConnection } from "./protocol/connection";
import { bindStreamToLoader, createSceneLoader } from "./protocol/scene-loader";
import { bindSnapshotStream, createSnapshotStream } from "./protocol/snapshot-stream";
import { bindModelLifecycle } from "./render/model-lifecycle";
import { createSceneModelStore } from "./render/scene-model";
import { describeState } from "./state/errors";
import type { Description } from "./state/errors";
import { createCodeEntry } from "./ui/code-entry";
import { bindScreens } from "./ui/screens";

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
  loader.on("enterCode", ({ description }) => stop(description));
  loader.on("sessionEnded", ({ description }) => stop(description));

  app.append(entry.element);
  entry.focus();
  app.dataset["ready"] = "true";
}
