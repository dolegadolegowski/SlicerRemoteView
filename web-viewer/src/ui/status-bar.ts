// Status bar (WEB-15): one line at the top of the viewer — the connection as the user should read it (connected,
// reconnecting, presenter offline), the number of viewers in the session (`viewer.joined` / `viewer.count`, §5.3)
// and the scene version shown (§8.4), then the Leave button (WEB-22: the installed app has no address bar, reload or,
// on iOS, back button to get out of a session). DOM only; the screens feed it.
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
}

export interface StatusBarOptions {
  readonly lang?: Lang;
  readonly document?: Document;
  /** Leave pressed (WEB-22); without it the bar has no Leave button. */
  readonly onLeave?: () => void;
}

const CONNECTION_KEYS = {
  connected: "statusBar.connected",
  reconnecting: "state.reconnecting.title",
  presenterOffline: "state.presenterOffline.title",
} as const;

export function createStatusBar(options: StatusBarOptions = {}): StatusBar {
  const doc = options.document ?? document;
  const lang = options.lang ?? detectLang();
  const element = doc.createElement("div");
  element.className = "status-bar";
  element.setAttribute("role", "group");
  element.setAttribute("aria-label", t(lang, "statusBar.label"));
  const connection = doc.createElement("span");
  connection.className = "status-bar__connection";
  connection.setAttribute("role", "status");
  const viewers = doc.createElement("span");
  viewers.className = "status-bar__viewers";
  const version = doc.createElement("span");
  version.className = "status-bar__version";
  element.append(connection, viewers, version);
  const onLeave = options.onLeave;
  if (onLeave) {
    const leave = doc.createElement("button");
    leave.type = "button";
    leave.className = "status-bar__leave";
    leave.textContent = t(lang, "statusBar.leave");
    leave.addEventListener("click", () => onLeave());
    element.append(leave);
  }

  /** Sets text only when it changes: an unchanged live region is not announced again. */
  const write = (target: HTMLElement, text: string) => {
    if (target.textContent !== text) target.textContent = text;
    target.hidden = text === "";
  };

  const bar: StatusBar = {
    element,
    setConnection(state) {
      element.dataset["connection"] = state;
      if (connection.textContent !== t(lang, CONNECTION_KEYS[state]))
        connection.textContent = t(lang, CONNECTION_KEYS[state]);
    },
    setViewers(count) {
      write(viewers, count === null ? "" : t(lang, "statusBar.viewers", { count }));
    },
    setSceneVersion(sceneVersion) {
      write(
        version,
        sceneVersion === null ? "" : t(lang, "statusBar.scene", { version: sceneVersion }),
      );
    },
  };
  bar.setConnection("connected");
  bar.setViewers(null);
  bar.setSceneVersion(null);
  return bar;
}
