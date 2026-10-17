# Gotowe linie `/goal` (tryb autonomiczny Claude Code)

`/goal <warunek>` w Claude Code ustawia cel sesji: po każdej turze mały model sprawdza na podstawie
**transkrypcji** (nie czyta plików, nie uruchamia narzędzi), czy warunek jest spełniony, i jeśli nie —
Claude pracuje dalej. Dlatego każdy warunek poniżej wymaga, żeby Claude **wypisał dowody** (`git log`,
`ls`, wynik testów) i ma ogranicznik tur. Zatrzymanie: `/goal clear`. Status: `/goal`.

Źródła (dokumentacja Claude Code): `code.claude.com/docs/en/goal`, `…/skills`, `…/sub-agents`, `…/worktrees`,
`…/headless`, `…/permission-modes`.

Zasady, które warto znać:

- Jedna linia = jedna sesja (`/goal` zastępuje poprzedni cel). Limit 4000 znaków.
- Warunek nie zmienia trybu uprawnień. Do pracy bez pytań o zgodę uruchom sesję w trybie automatycznym
  (np. `claude --permission-mode auto`; w nowszych wersjach dodatkowo `--permission-prompts none`),
  albo zostań przy sesji i odpowiadaj na prompty.
- Headless: `claude -p "/goal …" --max-turns 60` (plus `--output-format stream-json --verbose`, żeby widzieć postęp).
- Każdy warunek zawiera klauzulę „PYTANIE DO UŻYTKOWNIKA” — gdy Claude utknie na decyzji, kończy z takim
  nagłówkiem, warunek uznaje się za zakończony i sesja czeka na Ciebie.

Liczby (zadań, tur) są do zmiany. Linie są jednowierszowe — skopiuj całą.

## 00 — plan projektu (na `main`)

Bez `defaults` prompt celu zatrzyma się po fazie A z pytaniami (`PYTANIE DO UŻYTKOWNIKA`) — to dobry
wariant, gdy siedzisz przy sesji; dla `/goal` i uruchomień bez nadzoru zostaw `defaults`.

```
/goal Wykonaj prompts/00-goal.md z argumentem defaults (najpierw przeczytaj CLAUDE.md i prompts/00-goal.md narzędziem Read; pracuj zgodnie z nimi, używaj subagentów z .claude/agents; argument defaults oznacza: nie zadawaj pytań o decyzje, użyj wariantów domyślnych i wypisz je w podsumowaniu). Cel jest osiągnięty, gdy w transkrypcji widać: wynik `ls docs/research docs/adr docs/plan` zawierający research/slicer.md, research/relay.md, research/web.md, research/quest.md, co najmniej trzy pliki ADR oraz plan/00-overview.md i plan/{protocol,server,web,slicer,quest,deploy,qa}.md; `ls docs` zawierający requirements.md, architecture.md, protocol.md; `git status --porcelain` bez wyjścia; `git log --oneline` z osobnymi commitami dla research notes, requirements, architecture+protocol, plan i scaffold; oraz końcowe podsumowanie po polsku z listą decyzji i pytań otwartych. Cel jest też zakończony, gdy ostatnia wiadomość zawiera nagłówek "PYTANIE DO UŻYTKOWNIKA" z pytaniem blokującym dalszą pracę. W każdym razie zatrzymaj się po 40 turach.
```

## 01–07 — workstreamy (szablon; podmień nazwę promptu, plan, gałąź, komendę testów i liczbę zadań)

```
/goal Wykonaj prompts/_workflow.md i prompts/02-relay-server.md z argumentem 3 (najpierw przeczytaj CLAUDE.md i oba pliki narzędziem Read; używaj subagentów server-dev i reviewer). Cel jest osiągnięty, gdy w transkrypcji widać: 3 zadania z docs/plan/server.md zmienione na status done (lub mniej, jeśli nie ma więcej wykonalnych zadań — wtedy jest to jasno napisane wraz z powodem), każde z osobnym commitem widocznym w wyniku `git log --oneline main..ws/server`, wynik `npm test` zakończony sukcesem po ostatnim zadaniu, werdykt APPROVE reviewera dla każdego zadania, `git status --porcelain` bez wyjścia oraz propozycja PR ws/server → main (tytuł i opis). Cel jest też zakończony, gdy ostatnia wiadomość zawiera nagłówek "PYTANIE DO UŻYTKOWNIKA" z pytaniem blokującym dalszą pracę. W każdym razie zatrzymaj się po 40 turach.
```

Podstawienia dla pozostałych workstreamów:

| Workstream | prompt                             | plan                    | gałąź         | subagent     | testy                                   |
|------------|------------------------------------|-------------------------|---------------|--------------|-----------------------------------------|
| protocol   | `prompts/01-protocol.md`           | `docs/plan/protocol.md` | `ws/protocol` | `server-dev` | `npm test` w `shared/` i `pytest` w `shared/py` |
| web        | `prompts/03-web-viewer.md`         | `docs/plan/web.md`      | `ws/web`      | `web-dev`    | `npm test` (+ E2E, jeśli zadanie tego wymaga) |
| slicer     | `prompts/04-slicer-plugin.md`      | `docs/plan/slicer.md`   | `ws/slicer`   | `slicer-dev` | `pytest` w `slicer-plugin/`; kroki manualne w `docs/testing/slicer.md` |
| quest      | `prompts/05-quest-app.md`          | `docs/plan/quest.md`    | `ws/quest`    | `quest-dev`  | `dotnet test` jeśli dostępne; inaczej kroki EditMode w `docs/testing/quest.md` |
| deploy     | `prompts/06-deploy-ci.md`          | `docs/plan/deploy.md`   | `ws/deploy`   | `server-dev` | walidacja workflow (`actionlint`/`act` jeśli są) |
| qa         | `prompts/07-qa-security.md`        | `docs/plan/qa.md`       | `ws/qa`       | `qa`         | uruchomienie `tests/` (E2E/load) |

## 08 — integracja milestone'u (na `main`)

```
/goal Wykonaj prompts/08-integration-release.md z argumentem M1 (najpierw przeczytaj CLAUDE.md, prompts/_workflow.md i ten prompt narzędziem Read). Cel jest osiągnięty, gdy w transkrypcji widać: wszystkie gałęzie ws/* z gotowymi zadaniami milestone'u M1 scalone do main (wynik `git branch --merged main`), zielone testy każdego scalonego komponentu i E2E (wyniki komend), docs/plan/00-overview.md z milestone M1 oznaczonym jako zakończony, docs/user-guide/pl i docs/user-guide/en z plikami, CHANGELOG.md zaktualizowany, `git status --porcelain` bez wyjścia oraz podsumowanie po polsku. Cel jest też zakończony, gdy ostatnia wiadomość zawiera nagłówek "PYTANIE DO UŻYTKOWNIKA" (np. konflikt w docs/protocol.md lub decyzja o tagu). W każdym razie zatrzymaj się po 60 turach.
```
