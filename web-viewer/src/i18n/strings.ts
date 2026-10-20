// All user-visible strings live here, one table per language (prompt 03: single i18n file, PL/EN).
// EN is the source of truth for the key set; test/i18n asserts that PL has exactly the same keys
// (FR-51, NFR-33). Raw protocol codes (`INVALID_CODE`, `4004`) never appear in a string (NFR-31).

export type Lang = "en" | "pl";
export const LANGS: readonly Lang[] = ["en", "pl"];
export const FALLBACK_LANG: Lang = "en";

const en = {
  "action.retry": "Try again",
  "action.enterCode": "Enter a code",
  "action.askPresenter": "Ask the presenter to share the scene again",

  "message.invalidCode.title": "Code not recognised",
  "message.invalidCode.body":
    "No live session uses this code. Check the code shown in 3D Slicer and enter it again.",
  "message.sessionNotFound.title": "Session not found",
  "message.sessionNotFound.body":
    "The session you were in is no longer available. Enter the code again to join.",
  "message.sessionFull.title": "Session is full",
  "message.sessionFull.body": "This session has reached its viewer limit. Try again in a moment.",
  "message.sessionEnded.title": "Presentation ended",
  "message.sessionEnded.body":
    "The presenter closed the session or it expired. Enter a new code to join another one.",
  "message.rateLimited.title": "Too many attempts",
  "message.rateLimited.body": "Please wait a little before trying again.",
  "message.capacity.title": "Service is busy",
  "message.capacity.body": "The service is at capacity right now. Try again in a few minutes.",
  "message.updateRequired.title": "Update required",
  "message.updateRequired.body":
    "This version of the viewer is too old for the service. Close this tab and open the link or QR code again.",
  "message.unexpected.title": "Unexpected message",
  "message.unexpected.body": "The service sent something this viewer does not understand.",
  "message.invalidMessage.title": "Connection needs a restart",
  "message.invalidMessage.body": "The viewer and the service got out of step. Try again to resync.",
  "message.payloadTooLarge.title": "Scene is too large",
  "message.payloadTooLarge.body":
    "The scene is larger than this service accepts. Ask the presenter to share a lighter scene.",
  "message.badSequence.title": "Scene out of sync",
  "message.badSequence.body": "Some data arrived out of order. The scene is being requested again.",
  "message.checksumMismatch.title": "Scene download was damaged",
  "message.checksumMismatch.body":
    "The scene did not arrive intact. Try again to download it again.",
  "message.unauthorized.title": "Access denied",
  "message.unauthorized.body":
    "This device is no longer allowed in the session. Enter the code again.",
  "message.refused.title": "Connection refused",
  "message.refused.body":
    "The service refused this connection. Close this tab and open the link or QR code again.",
  "message.slowConsumer.title": "Connection too slow",
  "message.slowConsumer.body": "Your connection could not keep up. Reconnecting may help.",
  "message.internal.title": "Service problem",
  "message.internal.body": "Something went wrong on the service side. Try again in a moment.",
  "message.normalClose.title": "Disconnected",
  "message.normalClose.body": "The connection was closed. You can connect again.",
  "message.connectionLost.title": "Connection lost",
  "message.connectionLost.body": "The connection dropped. Try again when your network is back.",
  "message.relayRestarting.title": "Service is restarting",
  "message.relayRestarting.body": "The service is restarting. The viewer will reconnect by itself.",
  "message.heartbeatTimeout.title": "No answer from the service",
  "message.heartbeatTimeout.body": "The connection went quiet. Reconnecting may help.",
  "message.replaced.title": "Opened somewhere else",
  "message.replaced.body":
    "This session was opened on another tab or device, so this one was disconnected.",
  "message.handshakeTimeout.title": "Connection timed out",
  "message.handshakeTimeout.body": "The service did not answer in time. Try again.",
  "message.unknown.title": "Something went wrong",
  "message.unknown.body": "An unexpected problem occurred. Try again.",

  "state.connecting.title": "Connecting…",
  "state.connecting.body": "Contacting the service.",
  "state.waitingForScene.title": "Waiting for the presenter",
  "state.waitingForScene.body": "You are connected. The scene will appear as soon as it is shared.",
  "state.downloading.title": "Loading the scene…",
  "state.downloading.body": "Downloading the scene: {percent}%",
  "state.reconnecting.title": "Reconnecting…",
  "state.reconnecting.body":
    "The connection dropped. The last scene stays visible while we reconnect.",
  "state.presenterOffline.title": "Presenter is offline",
  "state.presenterOffline.body":
    "The presenter lost their connection. The scene will update when they return.",
  "state.sessionEnded.title": "Presentation ended",
  "state.sessionEnded.body":
    "The presenter closed the session or it expired. Enter a new code to join another one.",
  "state.webgl2Unavailable.title": "3D is not available",
  "state.webgl2Unavailable.body":
    "This browser or device cannot run WebGL 2, which the viewer needs. Try a current Safari or Chrome.",
  "state.snapshotTooLarge.title": "Scene is too large for this device",
  "state.snapshotTooLarge.body":
    "The scene is larger than this device can load. Ask the presenter to share a lighter scene.",
  "state.snapshotInvalid.title": "Scene could not be opened",
  "state.snapshotInvalid.body":
    "The scene that was shared is damaged or uses features this viewer does not support. Ask the presenter to share it again.",
  "state.snapshotFailed.title": "Scene could not be downloaded",
  "state.snapshotFailed.body": "Check the connection and tap Join to try again.",
  "state.snapshotUpdateFailed.title": "New scene could not be downloaded",
  "state.snapshotUpdateFailed.body":
    "You are still seeing the previous scene. Check the connection, or ask the presenter to share the scene again.",
  "state.linkInvalid.title": "The link has no valid code",
  "state.linkInvalid.body":
    "The link you opened does not contain a valid session code. Check the code shown in 3D Slicer.",
  "viewer.updating": "Updating the scene…",
  "viewer.fit": "Fit view",
  "viewer.dismiss": "Dismiss",
  "viewer.canvasLabel":
    "3D scene. Drag with one finger to rotate, pinch with two fingers to zoom and move, double-tap to fit.",
  "nodePanel.title": "Structures",
  "nodePanel.toggle": "Structures ({count})",
  "nodePanel.showAll": "Show all",
  "nodePanel.unnamed": "Unnamed {n}",
  "nodePanel.empty": "This scene has no structures.",
  "codeEntry.title": "Join a session",
  "codeEntry.lead": "Enter the 5-character code shown in 3D Slicer.",
  "codeEntry.cellLabel": "Code character {n} of {total}",
  "codeEntry.join": "Join",
  "codeEntry.joining": "Joining…",
  "codeEntry.hint.zeroOrO": "Codes never contain 0 or O — check that character.",
  "codeEntry.hint.oneIorL": "Codes never contain 1, I or L — check that character.",
  "codeEntry.hint.notInAlphabet":
    "Codes use only the letters A–Z (except I, L, O) and the digits 2–9.",
  "codeEntry.hint.length": "Codes have exactly 5 characters.",
} as const;

export type StringKey = keyof typeof en;

const pl: Record<StringKey, string> = {
  "action.retry": "Spróbuj ponownie",
  "action.enterCode": "Wpisz kod",
  "action.askPresenter": "Poproś prezentera o ponowne udostępnienie sceny",

  "message.invalidCode.title": "Nie rozpoznano kodu",
  "message.invalidCode.body":
    "Żadna aktywna sesja nie używa tego kodu. Sprawdź kod widoczny w 3D Slicerze i wpisz go ponownie.",
  "message.sessionNotFound.title": "Nie znaleziono sesji",
  "message.sessionNotFound.body":
    "Sesja, do której dołączono, jest już niedostępna. Wpisz kod ponownie.",
  "message.sessionFull.title": "Sesja jest pełna",
  "message.sessionFull.body": "Ta sesja osiągnęła limit widzów. Spróbuj za chwilę.",
  "message.sessionEnded.title": "Prezentacja zakończona",
  "message.sessionEnded.body":
    "Prezenter zamknął sesję albo wygasła. Wpisz nowy kod, aby dołączyć do innej.",
  "message.rateLimited.title": "Zbyt wiele prób",
  "message.rateLimited.body": "Odczekaj chwilę, zanim spróbujesz ponownie.",
  "message.capacity.title": "Usługa jest zajęta",
  "message.capacity.body": "Usługa jest teraz przeciążona. Spróbuj za kilka minut.",
  "message.updateRequired.title": "Wymagana aktualizacja",
  "message.updateRequired.body":
    "Ta wersja podglądu jest zbyt stara dla usługi. Zamknij tę kartę i otwórz link lub kod QR ponownie.",
  "message.unexpected.title": "Nieoczekiwana wiadomość",
  "message.unexpected.body": "Usługa wysłała coś, czego ten podgląd nie rozumie.",
  "message.invalidMessage.title": "Połączenie wymaga restartu",
  "message.invalidMessage.body": "Przeglądarka i usługa się rozsynchronizowały. Spróbuj ponownie.",
  "message.payloadTooLarge.title": "Scena jest za duża",
  "message.payloadTooLarge.body":
    "Scena jest większa, niż usługa przyjmuje. Poproś prezentera o udostępnienie lżejszej sceny.",
  "message.badSequence.title": "Scena rozsynchronizowana",
  "message.badSequence.body":
    "Część danych dotarła w złej kolejności. Scena jest pobierana ponownie.",
  "message.checksumMismatch.title": "Pobieranie sceny uszkodzone",
  "message.checksumMismatch.body": "Scena nie dotarła w całości. Spróbuj pobrać ją ponownie.",
  "message.unauthorized.title": "Brak dostępu",
  "message.unauthorized.body": "To urządzenie nie ma już dostępu do sesji. Wpisz kod ponownie.",
  "message.refused.title": "Połączenie odrzucone",
  "message.refused.body":
    "Usługa odrzuciła to połączenie. Zamknij tę kartę i otwórz link lub kod QR ponownie.",
  "message.slowConsumer.title": "Połączenie jest zbyt wolne",
  "message.slowConsumer.body": "Twoje połączenie nie nadąża. Ponowne połączenie może pomóc.",
  "message.internal.title": "Problem po stronie usługi",
  "message.internal.body": "Coś poszło nie tak po stronie usługi. Spróbuj za chwilę.",
  "message.normalClose.title": "Rozłączono",
  "message.normalClose.body": "Połączenie zostało zamknięte. Możesz połączyć się ponownie.",
  "message.connectionLost.title": "Utracono połączenie",
  "message.connectionLost.body": "Połączenie zostało przerwane. Spróbuj, gdy wróci sieć.",
  "message.relayRestarting.title": "Usługa się restartuje",
  "message.relayRestarting.body": "Usługa się restartuje. Przeglądarka połączy się sama.",
  "message.heartbeatTimeout.title": "Brak odpowiedzi usługi",
  "message.heartbeatTimeout.body": "Połączenie zamilkło. Ponowne połączenie może pomóc.",
  "message.replaced.title": "Otwarto w innym miejscu",
  "message.replaced.body":
    "Ta sesja została otwarta w innej karcie lub na innym urządzeniu, więc to połączenie zakończono.",
  "message.handshakeTimeout.title": "Upłynął czas połączenia",
  "message.handshakeTimeout.body": "Usługa nie odpowiedziała na czas. Spróbuj ponownie.",
  "message.unknown.title": "Coś poszło nie tak",
  "message.unknown.body": "Wystąpił nieoczekiwany problem. Spróbuj ponownie.",

  "state.connecting.title": "Łączenie…",
  "state.connecting.body": "Nawiązywanie połączenia z usługą.",
  "state.waitingForScene.title": "Czekamy na prezentera",
  "state.waitingForScene.body":
    "Połączenie nawiązane. Scena pojawi się, gdy tylko zostanie udostępniona.",
  "state.downloading.title": "Wczytywanie sceny…",
  "state.downloading.body": "Pobieranie sceny: {percent}%",
  "state.reconnecting.title": "Ponowne łączenie…",
  "state.reconnecting.body": "Połączenie zostało przerwane. Ostatnia scena pozostaje widoczna.",
  "state.presenterOffline.title": "Prezenter jest offline",
  "state.presenterOffline.body": "Prezenter stracił połączenie. Scena odświeży się, gdy wróci.",
  "state.sessionEnded.title": "Prezentacja zakończona",
  "state.sessionEnded.body":
    "Prezenter zamknął sesję albo wygasła. Wpisz nowy kod, aby dołączyć do innej.",
  "state.webgl2Unavailable.title": "Grafika 3D jest niedostępna",
  "state.webgl2Unavailable.body":
    "Ta przeglądarka lub urządzenie nie obsługuje WebGL 2, którego wymaga podgląd. Spróbuj w aktualnym Safari lub Chrome.",
  "state.snapshotTooLarge.title": "Scena jest za duża dla tego urządzenia",
  "state.snapshotTooLarge.body":
    "Scena jest większa, niż to urządzenie może wczytać. Poproś prezentera o lżejszą scenę.",
  "state.snapshotInvalid.title": "Nie udało się otworzyć sceny",
  "state.snapshotInvalid.body":
    "Udostępniona scena jest uszkodzona albo używa funkcji, których podgląd nie obsługuje. Poproś prezentera o ponowne udostępnienie.",
  "state.snapshotFailed.title": "Nie udało się pobrać sceny",
  "state.snapshotFailed.body": "Sprawdź połączenie i stuknij „Dołącz”, aby spróbować ponownie.",
  "state.snapshotUpdateFailed.title": "Nie udało się pobrać nowej sceny",
  "state.snapshotUpdateFailed.body":
    "Nadal widzisz poprzednią scenę. Sprawdź połączenie albo poproś prezentera o ponowne udostępnienie sceny.",
  "state.linkInvalid.title": "Link nie zawiera prawidłowego kodu",
  "state.linkInvalid.body":
    "Otwarty link nie zawiera prawidłowego kodu sesji. Sprawdź kod widoczny w 3D Slicerze.",
  "viewer.updating": "Aktualizowanie sceny…",
  "viewer.fit": "Dopasuj widok",
  "viewer.dismiss": "Zamknij",
  "viewer.canvasLabel":
    "Scena 3D. Przeciągnij jednym palcem, aby obrócić, rozsuń dwa palce, aby przybliżyć i przesunąć, stuknij dwukrotnie, aby dopasować.",
  "nodePanel.title": "Struktury",
  "nodePanel.toggle": "Struktury ({count})",
  "nodePanel.showAll": "Pokaż wszystkie",
  "nodePanel.unnamed": "Bez nazwy {n}",
  "nodePanel.empty": "Ta scena nie zawiera struktur.",
  "codeEntry.title": "Dołącz do sesji",
  "codeEntry.lead": "Wpisz 5-znakowy kod widoczny w 3D Slicerze.",
  "codeEntry.cellLabel": "Znak kodu {n} z {total}",
  "codeEntry.join": "Dołącz",
  "codeEntry.joining": "Dołączanie…",
  "codeEntry.hint.zeroOrO": "Kody nigdy nie zawierają 0 ani O — sprawdź ten znak.",
  "codeEntry.hint.oneIorL": "Kody nigdy nie zawierają 1, I ani L — sprawdź ten znak.",
  "codeEntry.hint.notInAlphabet": "Kody składają się z liter A–Z (bez I, L, O) i cyfr 2–9.",
  "codeEntry.hint.length": "Kod ma dokładnie 5 znaków.",
};

export const STRINGS: Record<Lang, Record<StringKey, string>> = { en, pl };

/**
 * Picks the UI language from `navigator.languages` / `navigator.language` style input: the first tag whose
 * primary subtag is supported wins; anything else falls back to EN.
 */
export function pickLang(languages: readonly string[] | string | undefined): Lang {
  const list = typeof languages === "string" ? [languages] : (languages ?? []);
  for (const tag of list) {
    const primary = tag.toLowerCase().split("-")[0];
    const match = LANGS.find((lang) => lang === primary);
    if (match) return match;
  }
  return FALLBACK_LANG;
}

/** Language of the running browser; EN outside a browser. */
export function detectLang(): Lang {
  const nav = (globalThis as { navigator?: { languages?: readonly string[]; language?: string } })
    .navigator;
  return pickLang(nav?.languages?.length ? nav.languages : nav?.language);
}

/** Looks a string up; `{name}` placeholders are replaced from `params`. */
export function t(
  lang: Lang,
  key: StringKey,
  params?: Readonly<Record<string, string | number>>,
): string {
  const template = STRINGS[lang][key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}
