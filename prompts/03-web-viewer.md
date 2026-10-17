# 03 — Workstream `web`: web-viewer (przeglądarka mobilna, opcjonalnie WebXR)

> Komponent: `web` · gałąź `ws/web` · plan `docs/plan/web.md` · subagent: `web-dev` (+ `reviewer`, `qa` do E2E)
> · wymaga: `prompts/00-goal.md`; do testów E2E przydaje się `relay-server` i `tools/fake-slicer` z `main`
> (jeśli ich nie ma, zbuduj mały mock serwera WebSocket w testach i oznacz `[stub: SRV-xx]`).
> Stosuj pętlę pracy z `prompts/_workflow.md` (argument uruchomienia: podany przy komendzie lub na początku wiadomości; brak = domyślny).

## Cel workstreamu

Aplikacja www w `web-viewer/`, którą użytkownik telefonu/tabletu otwiera bez instalacji: wpisuje 5‑znakowy kod
(lub wchodzi przez QR/deep link `/j/ABCDE`), a następnie ogląda model 3D ze Slicera: obraca, przybliża, przesuwa,
włącza/wyłącza elementy i zmienia ich przezroczystość. Scena aktualizuje się na żywo. Opcjonalnie: tryb VR
w Quest Browser (WebXR) jako szybka ścieżka na gogle przed aplikacją natywną.

## Stos (domyślny, zgodny z ADR)

Vite + TypeScript + three.js (GLTFLoader z dekoderami Draco/meshopt, OrbitControls z obsługą dotyku), bez
frameworka UI (lub lekki, jeśli ADR tak mówi), vitest (jednostkowe), Playwright (E2E, w tym emulacja iPhone'a).
Build trafia do `web-viewer/dist` i jest serwowany przez relay-server (ten sam origin).

## Wymagania UX (mobile‑first)

- Ekran dołączania: 5 dużych pól (auto‑przeskok, wklejanie całego kodu, klawiatura alfanumeryczna wielkie
  litery), czytelne komunikaty błędów (zły kod, sesja wygasła, brak sieci), stan „łączenie”.
- Deep link `/j/:code` od razu łączy; po sukcesie adres bez kodu (nie zostawiaj kodu w historii).
- Widok 3D na całym ekranie, sterowanie: jeden palec obrót, dwa palce zoom/przesunięcie, podwójne dotknięcie
  = reset widoku; przycisk „dopasuj do ekranu”.
- Panel elementów (nazwa, kolor, widoczność, przezroczystość) zwijany; na tablecie może być boczny.
- Pasek stanu: połączono / aktualizacja / rozłączono (auto‑reconnect z backoffem), liczba widzów, wersja sceny.
- Ciemny motyw, wysoki kontrast, działanie w poziomie i pionie, brak przewijania strony pod canvasem.
- Dostępność podstawowa (etykiety, focus), i18n gotowe na PL/EN (teksty w jednym pliku).

## Wymagania techniczne

- Warstwa protokołu (`src/protocol/`) oddzielona od three.js: maszyna stanów połączenia, składanie chunków GLB,
  weryfikacja hasha, obsługa wersji sceny — testowana jednostkowo na fixtures z `shared/`.
- Mapowanie `nodeId` → obiekty three.js; aktualizacje (`scene.update`) bez przeładowania całej sceny.
- Pamięć: limit pixel ratio (max 2), zwalnianie geometrii/materiałów przy nowym snapshotcie, obsługa
  `webglcontextlost`, informacja gdy scena przekracza limity urządzenia.
- Bezpieczeństwo: brak `eval`, CSP‑friendly, kod sesji nigdy w query stringu poza deep linkiem wejściowym.
- PWA manifest + ikony (bez service workera cache'ującego scenę).
- **WebXR (zadanie opcjonalne, M3)**: `VRButton`, kontrolery/ręce do obracania i skalowania modelu, model
  umieszczany przed użytkownikiem; działa w Quest Browser. Nie blokuje ścieżki mobilnej.

## Kolejność zadań (sugerowana; plan `WEB-xx` jest źródłem prawdy)

1. Szkielet Vite+TS, lint, vitest, Playwright, `README.md`, strona dołączania (bez sieci).
2. Klient protokołu + testy jednostkowe (fixtures).
3. Ładowanie GLB i sterowanie kamerą; test E2E „kod → model widoczny” z fake‑slicer.
4. Panel elementów + aktualizacje na żywo.
5. Reconnect, late join, błędy, stany; test E2E na emulowanym iPhonie.
6. Wydajność i pamięć (duża scena z fixtures), PWA.
7. (M3) WebXR.

## Definition of Done tego uruchomienia

- zadania wg argumentu z testami (`npm test`, E2E jeśli dotyczy), lint czysty, `npm run build` działa;
- krótkie nagranie/opis manualnego testu na iPhonie w `docs/testing/web.md` (co kliknąć, czego oczekiwać);
- plan zaktualizowany, propozycja PR `ws/web → main`.
