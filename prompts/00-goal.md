# 00 — Cel: wymagania i pełny plan implementacji SlicerRemoteView

> Uruchom w katalogu głównym repo, na gałęzi `main`, **raz na początku** (i ponownie, gdy chcesz
> przeplanować). Ten prompt **nie implementuje produktu** — tworzy wymagania, architekturę, kontrakt
> protokołu, plany per komponent i szkielet repo. Jest idempotentny: jeśli dokumenty już istnieją,
> uzupełnij/zaktualizuj je zamiast tworzyć duplikaty.

## Cel

Opracuj wymagania i pełny plan implementacji systemu **SlicerRemoteView**: pluginu do programu
**3D Slicer**, który umożliwia zdalny podgląd sceny 3D z 3D Slicera bezpośrednio w goglach
**Meta Quest** oraz na stronie www na urządzeniu mobilnym (np. iPhone, iPad, Android).

Po uruchomieniu plugin wyświetla **unikalny 5-znakowy kod**, który służy do połączenia gogli
i urządzeń mobilnych z odpowiednią instancją 3D Slicera.

System składa się z trzech elementów:

1. **Plugin do 3D Slicera** (Python; scripted loadable module pakowany jako extension).
2. **Aplikacja pośrednicząca (relay)** — serwer w Dockerze uruchomiony na **Railway**, którego zadaniem
   jest łączenie urządzeń z odpowiednią sesją 3D Slicera; serwuje też stronę www dla urządzeń mobilnych.
3. **Aplikacja na gogle Meta Quest** (natywna).

Użytkownicy smartfonów/tabletów wchodzą na stronę www serwera, podają kod wygenerowany przez nową sesję
3D Slicera i widzą w przeglądarce model 3D, który można obracać i którym można manipulować.

## Argument uruchomienia

- brak → tryb interaktywny (pytania z sekcji „Decyzje” po fazie A);
- `defaults` → nie zadawaj pytań, użyj wszystkich wariantów domyślnych i wypisz podjęte decyzje w podsumowaniu
  (tryb dla `/goal` i uruchomień bez nadzoru);
- `replan` → dokumenty już istnieją: zaktualizuj je wg nowych ustaleń z rozmowy/ADR (nie twórz od zera),
  rozbij lub przenumeruj zadania tylko tam, gdzie to konieczne, i opisz zmiany w podsumowaniu.

## Wymagania nienegocjowalne (doprecyzuj, nie zmieniaj)

- **5-znakowy kod sesji**, czytelny i łatwy do przepisania: alfabet bez znaków mylących (bez `0/O`, `1/I/L`),
  generowany po stronie relay, unikalny wśród aktywnych sesji, z czasem ważności i odświeżaniem (heartbeat).
- Relay działa jako **kontener Docker na Railway**. Slicer i urządzenia łączą się **wychodząco** (WSS/HTTPS):
  u użytkownika Slicera nie otwieramy portów, działa zza NAT/firewalla uczelni lub szpitala.
- **Przeglądarka mobilna bez instalacji** (Safari iOS, Chrome Android): strona → kod → model 3D;
  obracanie, zoom, przesuwanie, włączanie/wyłączanie i przezroczystość elementów; kod wpisany ręcznie
  lub przez QR/deep link z kodem **we fragmencie URL** (`https://<host>/j#ABCDE` — fragment nie trafia do
  serwera ani do logów Railway).
- **Gogle Meta Quest: aplikacja natywna** (docelowo). Oceń i zaproponuj, czy etap pośredni
  „WebXR w Quest Browser przez web-viewer” ma być osobnym kamieniem milowym przed aplikacją natywną.
- **Dane medyczne**: relay nie utrwala modeli (tylko pamięć, TTL), brak logowania treści, kody i tokeny nigdy
  w ścieżkach URL (logi edge'a Railway), całość przez TLS, kody wygasają, ochrona przed zgadywaniem kodów
  (rate limiting, blokada po N próbach).
- Jeden Slicer → wielu widzów jednocześnie (podaj limit i uzasadnij).

## Decyzje do podjęcia (zaproponuj i uzasadnij)

Zanim zaczniesz pisać plan, zadaj mi **maksymalnie 6 pytań** (pod nagłówkiem `PYTANIE DO UŻYTKOWNIKA`,
po fazie A, bo rozpoznanie może je zmienić) — tylko o decyzje, które realnie zmieniają architekturę i są
trudne do odwrócenia. Jeśli odpowiem „domyślnie” albo nie odpowiem, użyj wariantów domyślnych:

1. **Transport sceny** — domyślnie: **geometria (glTF/GLB) renderowana lokalnie** na urządzeniu + inkrementalne
   aktualizacje stanu (widoczność, kolor, przezroczystość, transformacje; opcjonalnie kamera), **nie** strumień
   wideo. Uwzględnij decymację siatek po stronie Slicera i limity rozmiaru (pamięć iOS Safari, Quest).
2. **Stos relay + web** — domyślnie: **Node.js 22 LTS / TypeScript** (`ws` + Fastify lub Hono), web-viewer
   **Vite + TypeScript + three.js**, pakiet `shared/` (JSON Schema protokołu + wygenerowane typy).
   Alternatywa: Python/FastAPI — oceń krótko.
3. **Silnik Quest** — domyślnie: **Unity LTS + OpenXR + Meta XR SDK + glTFast (runtime GLB)**; alternatywy:
   Unreal, WebXR-only. Kontekst: zespół uczy Unity na zajęciach z XR w medycynie.
4. **Zakres MVP (M1)** — domyślnie: jeden Slicer → wielu widzów, tylko odczyt, kamera sterowana lokalnie.
   Synchronizacja kamery/wskaźnika ze Slicerem oraz interakcje zwrotne (telepointer, zmiana widoczności
   z urządzenia) w późniejszych milestone'ach.
5. **Eksport sceny ze Slicera** — domyślnie: **własny writer GLB** z węzłów MRML (modele + segmentacje →
   zamknięte powierzchnie → `vtkPolyData` → GLB; czysty Python + numpy, testowalny bez Slicera, stabilne
   `nodeId`, kolory/przezroczystość per węzeł). Alternatywa do oceny: `vtkGLTFExporter` (eksportuje widok z
   okna renderowania — zweryfikuj, czy daje GLB, czy tylko `.gltf`, i jak traktuje segmentacje). Zweryfikuj
   w dokumentacji/źródłach Slicera 5.x: segmentacje, kolory, przezroczystość, układ współrzędnych
   (RAS → glTF Y-up), jednostki (mm → m).
6. **Hosting web-viewera** — domyślnie razem z relay (statyczne pliki w tym samym kontenerze, jeden host,
   brak CORS); alternatywa: osobny serwis Railway.
7. **Okablowanie monorepo** — domyślnie: npm workspaces w głównym `package.json` (`shared`, `relay-server`,
   `web-viewer`, `tools/fake-slicer`, jeden lockfile); `shared/py` kopiowane (vendorowane) do extension
   Slicera skryptem budowania, bo zainstalowany moduł nie może importować z `../shared`; `shared/cs` generowane
   do `quest-app/Assets/RemoteView/Protocol/Generated/`; obraz Dockera budowany z **kontekstu = katalog główny
   repo** (`relay-server/Dockerfile`, główny `.dockerignore`), żeby zbudować web-viewer w środku; relay na
   Railway w **jednej replice** (sesje w pamięci). Zapisz jako ADR i uwzględnij w szkielecie (faza E).

Dodatkowo zapytaj o licencję (domyślnie MIT) i nazwę extension w Slicerze (domyślnie `SlicerRemoteView`,
moduł `RemoteView`).

## Sposób pracy — podziel pracę na subagentów

Używaj subagentów z `.claude/agents/` (`architect`, `reviewer`), **równolegle** tam, gdzie zadania są
niezależne. Wynik każdego subagenta zapisz do pliku i streść mi — nie polegaj na tym, że zostanie w kontekście.
Niezweryfikowane twierdzenia oznaczaj `[TODO verify]` zamiast udawać pewność.

### Faza A — Rozpoznanie (4 subagenci `architect` równolegle → `docs/research/<temat>.md`)

Każdy weryfikuje założenia w dokumentacji/źródłach (nie zgaduje) i oddaje notatkę z linkami, wersjami i
ograniczeniami:

- **A1 `slicer.md`**: scripted module/extension w 3D Slicer 5.x (struktura, `CMakeLists.txt`, test modułu),
  dostęp do węzłów MRML (modele, segmentacje, display nodes), obserwowanie zmian (eventy, debounce),
  eksport do glTF/OBJ (co i jak wspiera `vtkGLTFExporter`, alternatywy), decymacja (`vtkQuadricDecimation`,
  `vtkDecimatePro`), `slicer.util.pip_install` i biblioteki WebSocket w Pythonie Slicera, wątki vs główny
  wątek Qt (`qt.QTimer`, kolejki), generowanie QR w UI (`qrcode`/`segno`), pakowanie extension,
  wymagania Extension Index.
- **A2 `relay.md`**: Railway (deploy z Dockerfile, `PORT`, WebSockety, limity czasu/rozmiaru, healthcheck,
  domeny i TLS, region EU, plany/ceny Hobby vs Pro, usypianie serwisów), wzorce relay/signaling, backpressure
  i chunkowanie dużych wiadomości binarnych w `ws`, sesje w pamięci z TTL, rate limiting, obserwowalność
  bez logowania treści.
- **A3 `web.md`**: three.js (GLTFLoader, dekodery Draco/meshopt, OrbitControls na dotyk, limity pamięci
  Safari iOS, utrata kontekstu WebGL), WebXR na Quest Browser (`VRButton`, kontrolery/ręce), PWA,
  obsługa deep linku z kodem we fragmencie URL (`/j#ABCDE`), reconnect WebSocket.
- **A4 `quest.md`**: Unity LTS (wersja), OpenXR + Meta XR SDK (pakiety, minimalne wersje), glTFast (runtime
  GLB, limity), klient WebSocket (NativeWebSocket lub inne), interakcja rękami/kontrolerami (XR Interaction
  Toolkit vs Meta Interaction SDK), passthrough (MR), build APK z macOS i instalacja (adb, Meta Quest
  Developer Hub), limity pamięci/trójkątów, testy EditMode/PlayMode.

### Faza B — Wymagania → `docs/requirements.md`

Persony (lekarz prezentujący przypadek, student, prowadzący zajęcia), user stories z kryteriami akceptacji,
wymagania funkcjonalne (`FR-xx`) i niefunkcjonalne (`NFR-xx`): wydajność (czas od wpisania kodu do widocznego
modelu, maksymalny rozmiar sceny, liczba widzów), bezpieczeństwo/prywatność (RODO, brak PHI w eksporcie, TTL),
kompatybilność (wersje Slicera, iOS/Android, Quest 2/3/3S), UX (kod czytelny z 2 m, QR, stany błędów).
Osobno: poza zakresem, ryzyka, założenia.

### Faza C — Architektura → `docs/architecture.md`, `docs/protocol.md`, `docs/adr/`

- Diagram komponentów i sekwencje (Mermaid): start sesji, dołączenie urządzenia, snapshot sceny, aktualizacja
  inkrementalna, spóźniony widz (late join — pobranie bieżącej sceny z pamięci relay), rozłączenie i reconnect,
  wygaśnięcie sesji, zakończenie sesji przez Slicer.
- `docs/protocol.md` = **kontrakt v1**: `protocolVersion` w kopercie każdej wiadomości JSON, typy wiadomości
  z pełnymi przykładami (w tym wznowienie sesji Slicera tokenem i dołączenie widza), ramki binarne
  (chunkowanie GLB, hash, limity), endpointy HTTP (`/` i `/j` — viewer, kod tylko we fragmencie URL;
  `/api/scene/:version` — pobranie bieżącej sceny przez spóźnionego widza, autoryzowane nagłówkiem z tokenem
  widza, nigdy kodem w ścieżce; `/healthz`; `/metrics` chroniony), kody błędów (jeden typ `error` z polem
  `code`), timeouts/heartbeat, uprawnienia (kto może co wysyłać: Slicer vs widz), wersjonowanie i zgodność wsteczna.
- Model danych sesji, cykl życia kodu, limity (rozmiar, liczba klientów), threat model w punktach
  (zgadywanie kodu, DoS dużymi blobami, podszywanie się pod Slicer, podsłuch, wyciek przez logi i ścieżki URL,
  utrata sesji przy redeployu/jednej replice). Threat model w `docs/architecture.md` jest kanoniczny — inne
  dokumenty odsyłają do niego zamiast powtarzać reguły.
- ADR-y (`docs/adr/0001-….md`) dla każdej decyzji z sekcji „Decyzje”: kontekst → decyzja → konsekwencje.

### Faza D — Plan → `docs/plan/00-overview.md` + `docs/plan/<komponent>.md`

- Milestone'y z definicją „done” (propozycja do dostosowania):
  - **M0 Fundamenty**: repo, protokół v1, szkielety komponentów, CI.
  - **M1 MVP web**: Slicer → relay → przeglądarka mobilna (kod, jeden model, obracanie/zoom, lista elementów).
  - **M2 Scena na żywo**: wiele modeli + segmentacje, aktualizacje widoczności/koloru/przezroczystości,
    late join, reconnect, QR, decymacja i limity.
  - **M3 Quest**: (jeśli zdecydowano) WebXR w Quest Browser → natywna aplikacja Quest z podstawową manipulacją.
  - **M4 Dopracowanie**: synchronizacja kamery/telepointer, bezpieczeństwo, dokumentacja użytkownika,
    pakowanie extension, release.
- Plan per komponent: `protocol.md`, `server.md`, `web.md`, `slicer.md`, `quest.md`, `deploy.md`, `qa.md`.
  Każdy jako tabela: **ID** (prefiksy: `PRO-`, `SRV-`, `WEB-`, `SLC-`, `QST-`, `DEP-`, `QA-`), **zadanie**,
  **milestone**, **zależności** (ID z innych komponentów), **kryteria akceptacji**, **test**,
  **status** (`todo`/`doing`/`done`). Zadania małe: każde kończy się działającym stanem i jednym commitem
  (≤ ~300 linii). Zaznacz **ścieżkę krytyczną** i co można robić równolegle.
- Mapa zależności między workstreamami (Mermaid) w `00-overview.md` oraz linia **`Active milestone: M0`**
  (workstreamy odczytują z niej, który milestone jest bieżący; `release` ją przesuwa).

### Faza E — Szkielet repo i porządek

- Katalogi komponentów z `README.md` (cel, jak uruchomić — na razie `TODO`), `.editorconfig`, `LICENSE`
  (wg odpowiedzi), uzupełniony `docs/README.md`, główny `package.json` z workspaces i główny `.dockerignore`
  (wg decyzji 7), puste `docs/testing/reports/` z `README.md` opisującym format zgłoszenia.
- Zaktualizuj `CLAUDE.md`: mapa komponentów i sekcja „Komendy projektu”, jeśli decyzje zmieniły stos.
- **Przegląd**: subagent `reviewer` czyta requirements/architecture/protocol/plany i wypisuje sprzeczności,
  luki, niejasne kryteria akceptacji, brakujące zależności między planami — popraw przed zakończeniem.

## Zasady

- Nie pisz kodu produkcyjnego w tym prompcie (poza szkieletami i przykładami w protokole).
- Każda faza = osobny commit na `main`: `docs: research notes`, `docs: requirements`, `docs: architecture
  and protocol v1`, `docs: implementation plan`, `chore: repo scaffold`. Nie rób jednego wielkiego commita.
- Dokumenty po angielsku; rozmowa ze mną po polsku (patrz `CLAUDE.md`).
- Na koniec: krótkie podsumowanie po polsku — co powstało, najważniejsze decyzje, otwarte pytania i którą
  komendę uruchomić jako następną (zwykle `/ws-protocol`, potem równolegle `/ws-server`, `/ws-web`, `/ws-slicer`).

## Definition of Done tego promptu

- [ ] `docs/research/{slicer,relay,web,quest}.md` z linkami i wersjami
- [ ] `docs/requirements.md` (persony, user stories, FR/NFR z ID, out of scope, ryzyka)
- [ ] `docs/architecture.md` (diagramy, sekwencje, model sesji, threat model)
- [ ] `docs/protocol.md` (kontrakt v1 z przykładami każdej wiadomości)
- [ ] `docs/adr/0001…000N.md`
- [ ] `docs/plan/00-overview.md` + plan dla każdego komponentu (ID, zależności, kryteria, status)
- [ ] szkielet katalogów, `LICENSE`, `.editorconfig`, główny `package.json`/`.dockerignore`, zaktualizowany `CLAUDE.md`
- [ ] przegląd `reviewer` wykonany, uwagi wdrożone
- [ ] wszystko w osobnych commitach na `main`, drzewo czyste
