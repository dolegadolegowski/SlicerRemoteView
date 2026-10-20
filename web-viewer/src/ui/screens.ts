// Which screen the user sees (WEB-08): the 3D viewer with its node panel (WEB-09) while a model is loaded and the
// session is live, the code entry otherwise. Also routes messages to the screen that is visible, gates Join on
// WebGL 2 and moves focus with the screen. Kept out of `main.ts` so every transition is unit-tested.

import { detectLang, t } from "../i18n/strings";
import type { Connection } from "../protocol/connection";
import type { Applied } from "../render/apply-update";
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
  /**
   * A snapshot download gave up. While a scene is shown it stays, with a notice over it; before that, the session
   * is left and the code entry says so with the code still typed — Join tries again. Ignored unless connected: a
   * late failure must not cancel a new join or replace a "connection lost" message.
   */
  failSnapshot(): void;
  /** Live changes were applied to the shown scene (WEB-12): draw them, refresh or rebuild the node list. */
  sceneChanged(applied: Pick<Applied, "changed" | "removed">): void;
  /**
   * `scene.nodeAdded`: a new snapshot is on its way (§8.2); the hint goes when it is shown or abandoned, or after
   * `UPDATING_HINT_MS` if no snapshot is announced (the relay may refuse it before any viewer hears of it).
   */
  updating(on: boolean): void;
  /** A newer snapshot was announced (`scene.snapshot.begin` / `.ready`): the hint waits for it, however long. */
  snapshotComing(): void;
  readonly viewer: Viewer | null;
  readonly nodePanel: NodePanel | null;
  /** Joining or joined: the code entry's cells hold the code of this session. */
  readonly live: boolean;
}

/** How long the "updating" hint waits for the snapshot that `scene.nodeAdded` promises to be announced. */
export const UPDATING_HINT_MS = 10_000;

export function bindScreens(options: ScreensOptions): Screens {
  const { app, connection, models, entry } = options;
  const create = options.createViewer ?? (() => createViewer());
  const canRender = options.webGL2Available ?? webGL2Available;
  let viewer: Viewer | null = null;
  let panel: NodePanel | null = null;
  let shown: SceneModel | null = null;
  let hintTimer: ReturnType<typeof setTimeout> | undefined;

  function setHint(on: boolean): void {
    clearTimeout(hintTimer);
    hintTimer = undefined;
    viewer?.setStatus(on ? t(detectLang(), "viewer.updating") : null);
  }

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
      setHint(false);
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
    failSnapshot() {
      if (connection.state.kind !== "connected") return;
      if (viewerVisible())
        return viewer?.setNotice(describeState({ kind: "snapshotUpdateFailed" }));
      connection.leave(); // out of "Joining…": the code entry is usable again
      entry.setError(describeState({ kind: "snapshotFailed" }));
    },
    get viewer() {
      return viewer;
    },
    get nodePanel() {
      return panel;
    },
    sceneChanged({ changed, removed }) {
      if (!shown) return;
      if (removed)
        panel?.setModel(shown); // rows of removed nodes go; open state and focus are kept
      else if (changed) panel?.refresh();
      if (changed || removed) viewer?.contentChanged(); // nodes may have moved: clip planes follow
    },
    updating(on) {
      setHint(on);
      if (on) hintTimer = setTimeout(() => setHint(false), UPDATING_HINT_MS);
    },
    snapshotComing() {
      clearTimeout(hintTimer);
      hintTimer = undefined;
    },
    get live() {
      return connection.state.kind === "connecting" || connection.state.kind === "connected";
    },
  };
}
