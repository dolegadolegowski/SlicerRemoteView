// Which screen the user sees (WEB-08): the 3D viewer with its node panel (WEB-09) while a model is loaded and the
// session is live, the code entry otherwise. Also routes messages to the screen that is visible, gates Join on
// WebGL 2 and moves focus with the screen. Kept out of `main.ts` so every transition is unit-tested.

import type { Connection } from "../protocol/connection";
import type { SceneModel, SceneModelStore } from "../render/scene-model";
import { createViewer, webGL2Available } from "../render/viewer";
import type { CreateViewerResult, Viewer } from "../render/viewer";
import { describeState } from "../state/errors";
import type { Description } from "../state/errors";
import type { CodeEntry } from "./code-entry";
import { createNodePanel } from "./node-panel";
import type { NodePanel } from "./node-panel";

export interface ScreensOptions {
  readonly app: HTMLElement;
  readonly connection: Pick<Connection, "state" | "connect" | "leave" | "on" | "onMessage">;
  readonly models: SceneModelStore;
  readonly entry: CodeEntry;
  readonly createViewer?: () => CreateViewerResult;
  readonly webGL2Available?: () => boolean;
}

export interface Screens {
  /** Join from the code entry: refused at once without WebGL 2 (no join slot, no download spent on it). */
  join(code: string): void;
  /** Shows a message where the user is looking: over the scene while it is shown, else on the code entry. */
  report(description: Description): void;
  readonly viewer: Viewer | null;
  readonly nodePanel: NodePanel | null;
}

export function bindScreens(options: ScreensOptions): Screens {
  const { app, connection, models, entry } = options;
  const create = options.createViewer ?? (() => createViewer());
  const canRender = options.webGL2Available ?? webGL2Available;
  let viewer: Viewer | null = null;
  let panel: NodePanel | null = null;
  let shown: SceneModel | null = null;

  const viewerVisible = () => viewer !== null && !viewer.element.hidden;

  function showEntry(focus: boolean): void {
    if (viewer) viewer.element.hidden = true;
    entry.element.hidden = false;
    if (focus) entry.focus();
  }

  function showViewer(model: SceneModel): void {
    if (!viewer) {
      // Context creation can still fail after the probe (GPU blocklist, lost context): nothing can be shown.
      const created = create();
      if (!created.ok) {
        connection.leave();
        entry.setError(describeState({ kind: "webgl2Unavailable" }));
        return;
      }
      const shownViewer = created.viewer;
      viewer = shownViewer;
      panel = createNodePanel({ onChange: () => shownViewer.invalidate() });
      viewer.element.append(panel.element);
      viewer.element.hidden = true;
      app.append(viewer.element);
    }
    const appearing = !viewerVisible();
    entry.element.hidden = true;
    viewer.element.hidden = false;
    if (model !== shown) {
      viewer.setNotice(null);
      viewer.setModel(model); // a new model is fitted from the front
      panel?.setModel(model);
    } else {
      viewer.resize(); // the same model again (rejoin after a drop) keeps the user's camera
      viewer.invalidate();
      panel?.refresh();
    }
    shown = model;
    if (appearing) viewer.focus(); // focus was on the now hidden code entry
  }

  models.onChange((model) => {
    if (model) {
      // Only on a live session: a download finishing after a drop must not cover the "connection lost" message;
      // the model is kept and shown when the same session is rejoined (below).
      if (connection.state.kind === "connected") showViewer(model);
      return;
    }
    shown = null;
    viewer?.setModel(null);
    viewer?.setNotice(null);
    panel?.setModel(null);
    if (viewerVisible()) showEntry(false); // the state handler focuses once the entry is usable again
  });

  // A rejoin of the same session keeps the model (no download): show it again. The model lifecycle registered its
  // handler first, so a different session has already cleared the old model here.
  connection.onMessage("viewer.joined", () => {
    if (models.current) showViewer(models.current);
  });

  connection.on("state", (state) => {
    switch (state.kind) {
      case "connecting":
        entry.setError(null);
        entry.setBusy(true);
        return;
      case "connected":
        return;
      case "idle":
        entry.setBusy(false);
        showEntry(true);
        return;
      default:
        // Until WEB-14 reconnects automatically, every closed state goes back to the code entry with its message;
        // after a retryable drop the model stays and is shown again when the same session is rejoined.
        entry.setBusy(false);
        entry.setError(state.description);
        showEntry(true);
    }
  });

  return {
    join(code) {
      if (!canRender()) return entry.setError(describeState({ kind: "webgl2Unavailable" }));
      // The code travels only in the body of `viewer.join`, never in the URL (NFR-15).
      connection.connect({ code });
    },
    report(description) {
      if (viewerVisible()) viewer?.setNotice(description);
      else entry.setError(description);
    },
    get viewer() {
      return viewer;
    },
    get nodePanel() {
      return panel;
    },
  };
}
