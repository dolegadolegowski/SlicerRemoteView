# SlicerRemoteView — instrukcje dla Claude Code

## Co to za projekt

Zdalny podgląd sceny 3D z **3D Slicer** na goglach **Meta Quest** i w przeglądarce urządzeń
mobilnych (iPhone/iPad/Android). Urządzenia łączą się z konkretną sesją 3D Slicera przez
**5-znakowy kod**. Monorepo; stos domyślny poniżej obowiązuje, o ile ADR w `docs/adr/` nie mówi inaczej.

## Mapa komponentów (jedyne źródło nazw używanych w regułach, planach i gałęziach)

| `<komponent>` | Katalog(i)                          | Gałąź         | Plan                    | ID zadań | Subagent     | Stos domyślny                                   |
|---------------|-------------------------------------|---------------|-------------------------|----------|--------------|-------------------------------------------------|
| `protocol`    | `shared/`, `tools/`                 | `ws/protocol` | `docs/plan/protocol.md` | `PRO-`   | `server-dev` | JSON Schema, generowane typy TS/Python/C#, symulator `tools/fake-slicer` |
| `server`      | `relay-server/` (incl. Dockerfile)  | `ws/server`   | `docs/plan/server.md`   | `SRV-`   | `server-dev` | Node.js 22 LTS, TypeScript, `ws`, Fastify, Docker, Railway |
| `web`         | `web-viewer/`                       | `ws/web`      | `docs/plan/web.md`      | `WEB-`   | `web-dev`    | Vite, TypeScript, three.js, opcjonalnie WebXR    |
| `slicer`      | `slicer-plugin/`                    | `ws/slicer`   | `docs/plan/slicer.md`   | `SLC-`   | `slicer-dev` | Python (Slicer 5.x), PythonQt, VTK, numpy        |
| `quest`       | `quest-app/`                        | `ws/quest`    | `docs/plan/quest.md`    | `QST-`   | `quest-dev`  | Unity LTS, OpenXR, Meta XR SDK, glTFast          |
| `deploy`      | `.github/`, `.railway/`, `docs/deploy.md` | `ws/deploy`   | `docs/plan/deploy.md`   | `DEP-`   | `server-dev` | GitHub Actions, Docker, Railway                  |
| `qa`          | `tests/`, `docs/security.md`        | `ws/qa`       | `docs/plan/qa.md`       | `QA-`    | `qa`         | Playwright, k6                                   |
| `release`     | integracja na `main`                | `main`        | `docs/plan/00-overview.md` | —     | `reviewer`   | —                                                |

Pozostałe katalogi: `docs/` (wymagania, architektura, **protokół = kontrakt**, plany, ADR, testy, user guide),
`prompts/` (prompty uruchamiane w Claude Code; komendy w `.claude/skills/` tylko je wczytują), `.claude/agents/`
(subagenci). Jeśli katalogu komponentu jeszcze nie ma, tworzy go jego workstream.

## Zasady pracy (obowiązują każdego agenta i subagenta)

1. **Najpierw czytaj, potem rób**: `docs/protocol.md` i plan swojego komponentu (tabela wyżej). Jeśli plan nie
   istnieje — zatrzymaj się i poproś o uruchomienie promptu celu (`/project-goal`, plik `prompts/00-goal.md`).
2. **Protokół jest kontraktem.** Zmieniasz go tylko świadomie: najpierw `docs/protocol.md` + numer wersji,
   osobny commit `docs(protocol): …`, dopiero potem kod. Zmianę oznacz w planach komponentów, których dotyczy
   (`[protocol change: vX.Y]`).
3. **Przyrostowo.** Jedno zadanie z planu = jeden commit (≤ ~300 linii zmian, działający stan). Kolejność:
   implementacja + testy → testy/lint przechodzą → `reviewer` → poprawki → commit → status `done` w planie
   (w tym samym commicie).
4. **Gałęzie i własność plików.** Każdy workstream pracuje na własnej gałęzi (tabela) i edytuje tylko:
   katalogi swojego komponentu, swój plan, `docs/testing/<komponent>.md`, `README.md` swojego komponentu,
   nowe pliki w `docs/research/` i `docs/adr/`, oraz `docs/protocol.md` wg zasady 2. Wyjątek: `qa` może
   porządkować wszystkie `docs/testing/*.md` w scenariusze (bez zmiany treści kroków) i utrzymuje
   `docs/testing/strategy.md`, `docs/testing/reports/` oraz `docs/security.md`. Wszystko inne
   (cudze plany, `CLAUDE.md`, `docs/plan/00-overview.md`, `docs/architecture.md`) zmienia tylko `release`
   na `main`. Błędy w cudzym komponencie zgłaszasz w `docs/testing/reports/<data>.md` (zasada 9), nie w cudzym planie.
5. **Nie zgaduj API** (Slicer/VTK, Railway, three.js, Meta XR SDK, glTFast). Sprawdź w dokumentacji lub źródłach;
   link do źródła zostaw w ADR, komentarzu lub notatce w `docs/research/`. Niezweryfikowane → oznacz `[TODO verify]`.
6. **Dane medyczne.** Relay nigdy nie zapisuje modeli na dysk ani do logów; kody sesji i tokeny nie trafiają do
   ścieżek URL ani logów; kody wygasają; cały ruch przez TLS; ochrona przed zgadywaniem kodów. Nie commituj
   sekretów (`.env` w `.gitignore`). Kanoniczny opis zagrożeń: threat model w `docs/architecture.md`.
7. **Język.** Kod, komentarze, commity, dokumentacja w repo — **po angielsku**. Rozmowa z użytkownikiem — **po polsku**.
   (Jeśli chcesz zmienić tę zasadę, zmień ją tutaj, nie w pojedynczych plikach.)
8. **Pytaj zamiast zgadywać**, gdy decyzja jest nieodwracalna lub niejasna (wybór silnika, format transportu,
   zmiana kontraktu). Pytanie blokujące zadawaj pod nagłówkiem `PYTANIE DO UŻYTKOWNIKA` (zwięźle, z proponowanym
   wariantem domyślnym) i zakończ turę — tryb `/goal` rozpoznaje ten nagłówek jako zatrzymanie. W pozostałych
   przypadkach wybierz rozsądny wariant domyślny i napisz, że tak zrobiłeś.
9. **Zgłoszenia między komponentami.** Każdy workstream na starcie sprawdza `docs/testing/reports/` pod kątem
   zgłoszeń dla swojego komponentu i dopisuje je do swojego planu jako zadania `todo`.
10. **Środowisko.** W sandboxie nie ma 3D Slicera ani Unity. Logikę pisz tak, by była testowalna bez nich
    (adaptery, czyste funkcje); testy wymagające Slicera/Unity opisuj jako manualne kroki w `docs/testing/<komponent>.md`.
11. **Commity**: Conventional Commits z ID zadania, np. `feat(server): session code generator (SRV-02)`,
    `docs(plan): mark WEB-04 done`. Nie łącz zadań z różnych komponentów w jednym commicie.

## Subagenci (`.claude/agents/`)

| Agent         | Rola                                                                       | Pisze kod?            |
|---------------|----------------------------------------------------------------------------|-----------------------|
| `architect`   | rozpoznanie technologii, decyzje, ADR, weryfikacja w dokumentacji           | nie (tylko `docs/`)   |
| `slicer-dev`  | implementacja w `slicer-plugin/`                                            | tak                   |
| `server-dev`  | implementacja w `relay-server/`, `shared/`, `tools/`, CI/Docker/Railway     | tak                   |
| `web-dev`     | implementacja w `web-viewer/`                                               | tak                   |
| `quest-dev`   | implementacja w `quest-app/`                                                | tak                   |
| `reviewer`    | przegląd diffu przed commitem (kryteria akceptacji, protokół, testy, bezpieczeństwo) | nie          |
| `qa`          | testy E2E/obciążeniowe/bezpieczeństwa w `tests/`, plany testów, raporty     | tak (tylko testy)     |

Zadania niezależne uruchamiaj **równolegle** (kilka wywołań subagentów w jednej wiadomości). Wynik subagenta
zawsze streść użytkownikowi i zapisz do plików — nie polegaj na tym, że zostanie w kontekście.

## Komendy projektu

Aktualne komendy testów/buildu każdego komponentu są w `README.md` tego komponentu (utrzymuje je jego
workstream). Poniższa lista jest uzupełniana wyłącznie przez `release` na `main`:

- Root (npm workspaces: `shared`, `relay-server`, `web-viewer`, `tools/fake-slicer`): `npm test`, `npm run lint`,
  `npm run typecheck`, `npm run build` — każdy przechodzi po workspace'ach z `--if-present`.
- `shared/`: `[TODO]` · `relay-server/`: `[TODO]` · `web-viewer/`: `[TODO]` · `slicer-plugin/`: `[TODO]`
- `quest-app/`: Unity Test Runner (EditMode) — manualnie · `tests/`: `[TODO]` (nie jest workspace'em; `npm --prefix tests`)
- Obraz relay: `docker build -f relay-server/Dockerfile .` z katalogu głównego repo (ADR 0007).
