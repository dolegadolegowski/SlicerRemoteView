// Status bar (WEB-15): one line at the top of the viewer — the connection as the user should read it (connected,
// reconnecting, presenter offline), the number of viewers in the session (`viewer.joined` / `viewer.count`, §5.3)
// and the scene version shown (§8.4), then the controls: the language switch (WEB-21) and Leave (WEB-22: the installed
// app has no address bar, reload or, on iOS, back button to get out of a session). DOM only; the screens feed it.
//
// Only the connection state is a live region: viewer counts change with every join and leave and would chatter.

import { detectLang, t } from "../i18n/strings";
import type { Lang } from "../i18n/strings";

export type ConnectionLabel = "connected" | "reconnecting" | "presenterOffline";

export interface StatusBar {
  readonly element: HTMLElement;
  setConnection(state: ConnectionLabel): void;
  /** `null` hides the count (not joined yet). */
  setViewers(count: number | null): void;
  /** `null` hides the version (no scene shown). */
  setSceneVersion(version: number | null): void;
  /** Re-renders the texts in `lang` (WEB-21). */
  setLang(lang: Lang): void;
}

export interface StatusBarOptions {
  readonly lang?: Lang;
  readonly document?: Document;
  /** Leave pressed (WEB-22); without it the bar has no Leave button. */
  readonly onLeave?: () => void;
  /** The language switch (WEB-21), before Leave. */
  readonly languageToggle?: HTMLElement;
}

const CONNECTION_KEYS = {
  connected: "statusBar.connected",
  reconnecting: "state.reconnecting.title",
  presenterOffline: "state.presenterOffline.title",
} as const;

export function createStatusBar(options: StatusBarOptions = {}): StatusBar {
  const doc = options.document ?? document;
  let lang = options.lang ?? detectLang();
  let state: ConnectionLabel = "connected";
  let count: number | null = null;
  let sceneVersion: number | null = null;
  const element = doc.createElement("div");
  element.className = "status-bar";
  element.setAttribute("role", "group");
  const connection = doc.createElement("span");
  connection.className = "status-bar__connection";
  connection.setAttribute("role", "status");
  const viewers = doc.createElement("span");
  viewers.className = "status-bar__viewers";
  const version = doc.createElement("span");
  version.className = "status-bar__version";
  element.append(connection, viewers, version);
  // The controls stay together on one line when the bar wraps on a narrow phone: their 44 px targets never reach
  // over each other.
  const actions = doc.createElement("span");
  actions.className = "status-bar__actions";
  if (options.languageToggle) actions.append(options.languageToggle);
  const onLeave = options.onLeave;
  const leave = doc.createElement("button");
  leave.type = "button";
  leave.className = "status-bar__leave";
  if (onLeave) {
    leave.addEventListener("click", () => onLeave());
    actions.append(leave);
  }
  if (actions.childElementCount > 0) element.append(actions);

  /** Sets text only when it changes: an unchanged live region is not announced again. */
  const write = (target: HTMLElement, text: string) => {
    if (target.textContent !== text) target.textContent = text;
    target.hidden = text === "";
  };

  function paint(): void {
    element.setAttribute("aria-label", t(lang, "statusBar.label"));
    element.dataset["connection"] = state;
    if (connection.textContent !== t(lang, CONNECTION_KEYS[state]))
      connection.textContent = t(lang, CONNECTION_KEYS[state]);
    write(viewers, count === null ? "" : t(lang, "statusBar.viewers", { count }));
    write(
      version,
      sceneVersion === null ? "" : t(lang, "statusBar.scene", { version: sceneVersion }),
    );
    leave.textContent = t(lang, "statusBar.leave");
  }

  paint();
  return {
    element,
    setConnection(next) {
      state = next;
      paint();
    },
    setViewers(next) {
      count = next;
      paint();
    },
    setSceneVersion(next) {
      sceneVersion = next;
      paint();
    },
    setLang(next) {
      lang = next;
      paint();
    },
  };
}
