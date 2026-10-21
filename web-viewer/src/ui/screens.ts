// Which screen the user sees (WEB-08): the 3D viewer with its node panel (WEB-09) while a model is loaded and the
// session is live, the code entry otherwise. Also routes messages to the screen that is visible, gates Join on
// WebGL 2, moves focus with the screen and keeps the status lines: over the scene the status bar (WEB-15: connection,
// viewers, scene version) and a short notice line (presenter changes, "updating"); on the code entry one line
// (reconnecting, presenter offline, waiting for or loading the scene, WEB-14). Leave (WEB-22) is in the status bar and
// on the busy code entry; the language switch (WEB-21) is in the status bar, and a switch re-renders every screen.
// Kept out of `main.ts` so every transition is unit-tested.

import type { LangStore } from "../i18n/lang";
import { detectLang, t } from "../i18n/strings";
import type { Lang } from "../i18n/strings";
import type { Connection } from "../protocol/connection";
import type { Reconnect } from "../protocol/reconnect";
import type { Applied } from "../render/apply-update";
import type { SceneModel, SceneModelStore } from "../render/scene-model";
import { createViewer, webGL2Available } from "../render/viewer";
import type { CreateViewerResult, Viewer } from "../render/viewer";
import { describeState } from "../state/errors";
import type { Description } from "../state/errors";
import type { CodeEntry } from "./code-entry";
import { createLangToggle } from "./lang-toggle";
import { createNodePanel } from "./node-panel";
import type { NodePanel } from "./node-panel";
import { createStatusBar } from "./status-bar";
import type { StatusBar } from "./status-bar";

export interface ScreensOptions {
  readonly app: HTMLElement;
  readonly connection: Pick<Connection, "state" | "leave" | "on" | "onMessage">;
  /** Joins by code, leaves and decides about retries (WEB-14). */
  readonly session: Pick<Reconnect, "join" | "leave" | "willRetry" | "explain">;
  readonly models: SceneModelStore;
  readonly entry: CodeEntry;
  readonly createViewer?: () => CreateViewerResult;
  readonly webGL2Available?: () => boolean;
  /** A snapshot is being received right now (stream or HTTP), so "Loading the scene…" is true; default never. */
  readonly downloading?: () => boolean;
  /** The UI language (WEB-21); without it the browser's, and the status bar has no language switch. */
  readonly lang?: Pick<LangStore, "lang" | "set" | "onChange">;
}

export interface Screens {
  /** Join from the code entry: refused at once without WebGL 2 (no join slot, no download spent on it). */
  join(code: string): void;
  /**
   * The user leaves the live session (WEB-22): `viewer.leave` + `1000`, or the pending retry is cancelled; the scene
   * goes and the code entry comes back empty and focused. Nothing happens outside a live session.
   */
  leave(): void;
  /** Shows a message where the user is looking: over the scene while it is shown, else on the code entry. */
  report(description: Description): void;
  /**
   * A snapshot download gave up. While a scene is shown it stays, with a notice over it; before that, the session
   * is left and the code entry says so with the code still typed — Join tries again. Ignored unless connected: a
   * late failure must not cancel a new join or replace a message about the connection.
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
  /** A presenter change replaced the local choice for these nodes (FR-40, US-09): a short notice names them. */
  presenterChanged(nodeIds: readonly string[]): void;
  /** The scene version shown (§8.4), for the status bar; `null` when there is none. */
  sceneVersion(version: number | null): void;
  readonly viewer: Viewer | null;
  readonly nodePanel: NodePanel | null;
  /** Joining, joined or reconnecting: the code entry's cells hold the code of this session. */
  readonly live: boolean;
}

/** How long the "updating" hint waits for the snapshot that `scene.nodeAdded` promises to be announced. */
export const UPDATING_HINT_MS = 10_000;
/** How long "The presenter changed …" stays (WEB-13: 3 s). */
export const PRESENTER_NOTICE_MS = 3_000;

export function bindScreens(options: ScreensOptions): Screens {
  const { app, connection, models, entry, session } = options;
  const currentLang = (): Lang => options.lang?.lang ?? detectLang();
  const create = options.createViewer ?? (() => createViewer({ lang: currentLang() }));
  const canRender = options.webGL2Available ?? webGL2Available;
  const downloading = options.downloading ?? (() => false);
  let viewer: Viewer | null = null;
  let panel: NodePanel | null = null;
  let bar: StatusBar | null = null;
  let shown: SceneModel | null = null;
  let viewerCount: number | null = null;
  let version: number | null = null;
  // Over the scene the status bar says reconnecting / presenter offline, the notice line a presenter notice over the
  // "updating" hint (which comes back after it); the code entry says the most important of all of them.
  let joined = false; // `viewer.joined` of this session seen
  let reconnecting = false;
  let presenterOffline = false;
  let loading = false; // joined without a scene shown: a snapshot is being received
  let hint = false;
  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  /** The notice line's text in a given language: it follows a language switch while shown. */
  let notice: ((lang: Lang) => string) | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;

  function paintStatus(): void {
    const lang = currentLang();
    const urgent = reconnecting
      ? t(lang, "state.reconnecting.title")
      : presenterOffline
        ? t(lang, "state.presenterOffline.title")
        : null;
    bar?.setConnection(
      reconnecting ? "reconnecting" : presenterOffline ? "presenterOffline" : "connected",
    );
    viewer?.setStatus(notice?.(lang) ?? (hint ? t(lang, "viewer.updating") : null));
    const waiting = loading ? "state.downloading.title" : "state.waitingForScene.title";
    entry.setStatus(urgent ?? (joined ? t(lang, waiting) : null));
  }

  /** The session is over for this viewer (or not yet joined): no status of it is left. */
  function sessionGone(): void {
    joined = reconnecting = presenterOffline = loading = false;
    viewerCount = null;
    bar?.setViewers(null);
    paintStatus();
  }

  function setHint(on: boolean): void {
    clearTimeout(hintTimer);
    hintTimer = undefined;
    hint = on;
    paintStatus();
  }

  /** The hint goes after `UPDATING_HINT_MS` unless a snapshot is announced meanwhile. */
  function armHint(): void {
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => setHint(false), UPDATING_HINT_MS);
  }

  /** A short notice in the notice line (WEB-13), for `PRESENTER_NOTICE_MS`. */
  function flash(text: (lang: Lang) => string): void {
    notice = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      notice = null;
      paintStatus();
    }, PRESENTER_NOTICE_MS);
    paintStatus();
  }

  function clearStatus(): void {
    clearTimeout(noticeTimer);
    notice = null;
    setHint(false);
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
      panel = createNodePanel({ lang: currentLang(), onChange: () => shownViewer.invalidate() });
      viewer.element.append(panel.element);
      bar = createStatusBar({
        lang: currentLang(),
        onLeave: () => leave(),
        ...(options.lang && {
          languageToggle: createLangToggle(options.lang, { className: "status-bar__lang" }).element,
        }),
      });
      viewer.overlay.prepend(bar.element); // above the notice and the notice line
      bar.setViewers(viewerCount);
      bar.setSceneVersion(version);
      viewer.element.hidden = true;
      app.append(viewer.element);
    }
    const appearing = !viewerVisible();
    entry.element.hidden = true;
    viewer.element.hidden = false;
    if (model !== shown) {
      viewer.setNotice(null);
      loading = false;
      clearStatus(); // the notice and the hint talk about the previous scene
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
      // Only on a live session: a download finishing after a drop waits for the rejoin of the same session, which
      // shows the kept model (below); a first join that dropped keeps its "connection lost" message.
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
  // The scene loader registered first too: whether it started a download is known here.
  connection.onMessage("viewer.joined", (m) => {
    joined = true;
    viewerCount = m.viewerCount;
    bar?.setViewers(viewerCount);
    reconnecting = false;
    presenterOffline = !m.publisherOnline;
    loading = downloading(); // else waiting for the presenter to share a scene (§13 step 9)
    // A hint whose snapshot died with the old socket: it gets the usual time to be announced again.
    if (hint && !loading) armHint();
    paintStatus(); // the bar's "Connected" after "Reconnecting…" is the cue that the link is back
    if (models.current) showViewer(models.current);
  });
  // §5.3: sent on every join and leave; shown at once (WEB-15).
  connection.onMessage("viewer.count", (m) => {
    viewerCount = m.viewerCount;
    bar?.setViewers(viewerCount);
  });
  // §4.6: the scene stays frozen while the presenter is away (grace) and updates when they are back.
  connection.onMessage("session.publisherState", (m) => {
    presenterOffline = !m.online;
    paintStatus();
  });

  const isLive = () => {
    const state = connection.state;
    return state.kind === "connecting" || state.kind === "connected" || session.willRetry(state);
  };

  function leave(): void {
    if (!isLive()) return;
    entry.reset(); // first: the `idle` state below focuses the first empty cell
    session.leave(); // the state becomes `idle`: the model goes, the code entry comes back
  }

  // A language switch (WEB-21): every text on every screen, the status lines included, in the new language.
  options.lang?.onChange((lang) => {
    entry.setLang(lang);
    viewer?.setLang(lang);
    panel?.setLang(lang);
    bar?.setLang(lang);
    paintStatus();
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
        sessionGone();
        entry.setBusy(false);
        showEntry(true);
        return;
      default:
        if (session.willRetry(state)) {
          // A retry follows without the user (WEB-14): the scene, or the waiting code entry, stays and says so.
          reconnecting = true;
          entry.setBusy(true);
          return paintStatus();
        }
        // Over: back to the code entry with the message. After a drop the model stays and is shown again when the
        // same session is joined again (Join keeps the code).
        sessionGone();
        entry.setBusy(false);
        entry.setError(session.explain(state) ?? state.description);
        showEntry(true);
    }
  });

  return {
    join(code) {
      if (!canRender()) return entry.setError(describeState({ kind: "webgl2Unavailable" }));
      // The code travels only in the body of `viewer.join`, never in the URL (NFR-15).
      session.join(code);
    },
    leave,
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
      if (!on) loading = downloading(); // abandoned: back to waiting for the presenter
      setHint(on);
      if (on) armHint();
    },
    snapshotComing() {
      clearTimeout(hintTimer);
      hintTimer = undefined;
      // The stream and the loader have seen the announcement first: one that is refused (too large) loads nothing.
      if (!shown) {
        loading = downloading();
        paintStatus();
      }
    },
    presenterChanged(changed) {
      const model = shown;
      // A node removed in the same `scene.state` is not named or counted.
      const nodeIds = model ? changed.filter((id) => model.nodes.has(id)) : [];
      if (!model || nodeIds.length === 0) return;
      const node = model.nodes.get(nodeIds[0]!);
      // Names are shown, never logged (PHI, §7.3).
      const name = (lang: Lang) =>
        node && (node.manifest.name.trim() || t(lang, "nodePanel.unnamed", { n: node.order + 1 }));
      flash((lang) =>
        nodeIds.length === 1 && node
          ? t(lang, "viewer.presenterChanged", { name: name(lang)! })
          : t(lang, "viewer.presenterChangedMany", { count: nodeIds.length }),
      );
    },
    sceneVersion(next) {
      version = next;
      bar?.setSceneVersion(next);
    },
    get live() {
      return isLive();
    },
  };
}
