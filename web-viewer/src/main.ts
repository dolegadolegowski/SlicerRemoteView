// Entry point: mounts the code entry screen and joins through the connection client (WEB-04). The snapshot,
// scene and viewer UI are wired by WEB-05 onwards; until then a successful join keeps the busy state.
import { createConnection } from "./protocol/connection";
import { createCodeEntry } from "./ui/code-entry";

const app = document.getElementById("app");
if (app) {
  const connection = createConnection();
  const entry = createCodeEntry({
    // The code travels only in the body of `viewer.join`, never in the URL (NFR-15).
    onJoin: (code) => connection.connect({ code }),
  });
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
