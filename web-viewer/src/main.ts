// Entry point: mounts the code entry screen and joins through the connection client (WEB-04). Snapshots arrive
// over the WebSocket stream (WEB-05) or over HTTP (WEB-06); parsing and rendering them is WEB-07/WEB-08, so a
// successful join keeps the busy state until then.
import { createConnection } from "./protocol/connection";
import { bindStreamToLoader, createSceneLoader } from "./protocol/scene-loader";
import { bindSnapshotStream, createSnapshotStream } from "./protocol/snapshot-stream";
import { describeState } from "./state/errors";
import type { Description } from "./state/errors";
import { createCodeEntry } from "./ui/code-entry";

const app = document.getElementById("app");
if (app) {
  const connection = createConnection();
  const stream = createSnapshotStream();
  const loader = createSceneLoader(connection);
  bindSnapshotStream(connection, stream);
  bindStreamToLoader(connection, stream, loader);
  const entry = createCodeEntry({
    // The code travels only in the body of `viewer.join`, never in the URL (NFR-15).
    onJoin: (code) => connection.connect({ code }),
  });

  /** Leaves the session and shows `description` on the code entry screen. */
  const stop = (description: Description) => {
    connection.leave();
    entry.setError(description);
  };
  const tooLarge = () => entry.setError(describeState({ kind: "snapshotTooLarge" }));
  stream.on("tooLarge", tooLarge);
  loader.on("tooLarge", tooLarge);
  loader.on("enterCode", ({ description }) => stop(description));
  loader.on("sessionEnded", ({ description }) => stop(description));

  connection.on("state", (state) => {
    switch (state.kind) {
      case "connecting":
        entry.setError(null);
        entry.setBusy(true);
        break;
      case "connected":
        break;
      case "idle":
        entry.setBusy(false);
        break;
      default:
        entry.setBusy(false);
        entry.setError(state.description);
    }
  });
  app.append(entry.element);
  entry.focus();
  app.dataset["ready"] = "true";
}
