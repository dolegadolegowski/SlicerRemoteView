# SlicerRemoteView — instrukcje dla Claude Code

## Co to za projekt

Zdalny podgląd sceny 3D z **3D Slicer** na goglach **Meta Quest** i w przeglądarce urządzeń
mobilnych (iPhone/iPad/Android). Urządzenia łączą się z konkretną sesją 3D Slicera przez
**5‑znakowy kod**. Komponenty (monorepo):

| Katalog          | Co to jest                                                                 | Stos (domyślny — patrz `docs/adr/`)        |
|------------------|----------------------------------------------------------------------------|--------------------------------------------|
| `slicer-plugin/` | moduł/extension 3D Slicer: start sesji, kod + QR, eksport sceny, wysyłka    | Python (Slicer 5.x), PythonQt, VTK         |
| `relay-server/`  | serwer pośredniczący: sesje i kody, relay WebSocket, hosting web‑viewera    | Node.js/TypeScript, Docker, Railway        |
| `web-viewer/`    | viewer 3D w przeglądarce: kod → model, obracanie/zoom, lista elementów      | Vite, TypeScript, three.js (opcj. WebXR)   |
| `quest-app/`     | natywna aplikacja Meta Quest                                               | Unity LTS, OpenXR, Meta XR SDK, glTFast    |
| `shared/`        | definicja protokołu (JSON Schema / typy) używana przez wszystkie komponenty | JSON Schema + wygenerowane typy            |
| `docs/`          | wymagania, architektura, **protokół (kontrakt)**, plany per komponent, ADR  | Markdown + Mermaid                          |
| `prompts/`       | prompty do uruchamiania w Claude Code (cel + niezależne workstreamy)        | —                                          |

Jeśli katalogu jeszcze nie ma, tworzy go pierwszy workstream, który go potrzebuje.

## Zasady pracy (obowiązują każdego agenta i subagenta)

1. **Najpierw czytaj, potem rób**: `docs/protocol.md` i plan swojego komponentu `docs/plan/<komponent>.md`.
   Jeśli plan nie istnieje — zatrzymaj się i poproś o uruchomienie promptu celu (`prompts/00-goal.md`).
2. **Protokół jest kontraktem.** Zmieniasz go tylko świadomie: najpierw `docs/protocol.md` + numer wersji,
   osobny commit `docs(protocol): …`, dopiero potem kod. Zmianę oznacz w planach innych komponentów (`[protocol change]`).
3. **Przyrostowo.** Jedno zadanie z planu = jeden commit (≤ ~300 linii zmian, działający stan). Kolejność:
   implementacja + testy → testy/lint przechodzą → `reviewer` → poprawki → commit → status `done` w planie (w tym samym commicie).
4. **Gałęzie.** Każdy workstream pracuje na własnej gałęzi `ws/<komponent>` i nie dotyka katalogów innych
   komponentów (wyjątek: `docs/plan/<swój>.md`, `docs/protocol.md` wg zasady 2). Integracja do `main` przez PR.
5. **Nie zgaduj API** (Slicer/VTK, Railway, three.js, Meta XR SDK, glTFast). Sprawdź w dokumentacji lub źródłach;
   link do źródła zostaw w ADR, komentarzu lub notatce w `docs/research/`. Niezweryfikowane → oznacz `[TODO verify]`.
6. **Dane medyczne.** Relay nigdy nie zapisuje modeli na dysk ani do logów, kody sesji wygasają, cały ruch przez TLS,
   ochrona przed zgadywaniem kodów. Nie commituj sekretów (`.env` w `.gitignore`).
7. **Język.** Kod, komentarze, commity, dokumentacja w repo — **po angielsku**. Rozmowa z użytkownikiem — **po polsku**.
   (Jeśli chcesz zmienić tę zasadę, zmień ją tutaj, nie w pojedynczych plikach.)
8. **Pytaj zamiast zgadywać**, gdy decyzja jest nieodwracalna lub niejasna (wybór silnika, format transportu,
   zmiana kontraktu). W pozostałych przypadkach wybierz rozsądny domyślny wariant i napisz, że tak zrobiłeś.
9. **Środowisko.** W sandboxie nie ma 3D Slicera ani Unity. Logikę pisz tak, by była testowalna bez nich
   (adaptery, czyste funkcje); testy wymagające Slicera/Unity opisuj jako manualne kroki dla użytkownika.
10. **Commity**: Conventional Commits z ID zadania, np. `feat(server): session code generator (SRV-02)`,
    `docs(plan): mark WEB-04 done`. Nie łącz zadań z różnych komponentów w jednym commicie.

## Subagenci (`.claude/agents/`)

| Agent         | Rola                                                            | Pisze kod? |
|---------------|-----------------------------------------------------------------|------------|
| `architect`   | rozpoznanie technologii, decyzje, ADR, weryfikacja w dokumentacji | nie (tylko `docs/`) |
| `slicer-dev`  | implementacja w `slicer-plugin/`                                 | tak        |
| `server-dev`  | implementacja w `relay-server/` i `shared/`                      | tak        |
| `web-dev`     | implementacja w `web-viewer/`                                    | tak        |
| `quest-dev`   | implementacja w `quest-app/`                                     | tak        |
| `reviewer`    | przegląd diffu przed commitem (kryteria akceptacji, protokół, testy, bezpieczeństwo) | nie |
| `qa`          | testy E2E, obciążeniowe, plany testów manualnych                 | tak (tylko testy) |

Zadania niezależne uruchamiaj **równolegle** (kilka wywołań subagentów w jednej wiadomości). Wynik subagenta
zawsze streść użytkownikowi i zapisz do plików — nie polegaj na tym, że zostanie w kontekście.

## Komendy projektu

Uzupełniane przez workstreamy w miarę powstawania kodu (zostaw aktualne):

- relay-server: `npm test`, `npm run lint`, `npm run build`, `docker build .`  `[TODO]`
- web-viewer: `npm test`, `npm run build`, `npm run dev`  `[TODO]`
- slicer-plugin: `pytest` (logika bez Slicera); self-testy w Slicerze — manualnie  `[TODO]`
- quest-app: Unity Test Runner (EditMode) — manualnie  `[TODO]`
