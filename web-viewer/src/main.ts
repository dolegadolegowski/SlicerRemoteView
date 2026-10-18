// Entry point: mounts the code entry screen. The connection (WEB-04 onwards) is wired through `onJoin`.
import { createCodeEntry } from "./ui/code-entry";

const app = document.getElementById("app");
if (app) {
  const entry = createCodeEntry({
    onJoin: () => {
      // No connection layer yet: show the busy state only. The code stays in memory, never in the URL.
      entry.setBusy(true);
    },
  });
  app.append(entry.element);
  entry.focus();
  app.dataset["ready"] = "true";
}
