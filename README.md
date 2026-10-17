# SlicerRemoteView

Zdalny podgląd sceny 3D z **3D Slicer** na goglach **Meta Quest** i w przeglądarce urządzeń mobilnych
(iPhone/iPad/Android). Urządzenia łączą się z konkretną sesją 3D Slicera przez **5‑znakowy kod**
wyświetlany przez plugin.

```
3D Slicer + plugin ──WSS──▶  relay-server (Docker @ Railway)  ◀──WSS/HTTPS──  web-viewer (telefon/tablet; Quest Browser/WebXR)
                              • sesje + kody • relay sceny      ◀──WSS────────  quest-app (natywna aplikacja Meta Quest)
                              • hosting web-viewera
```

| Komponent        | Rola                                                                        |
|------------------|-----------------------------------------------------------------------------|
| `slicer-plugin/` | moduł 3D Slicer: start sesji, kod + QR, eksport sceny (glTF), aktualizacje   |
| `relay-server/`  | serwer pośredniczący: kody, sesje, relay WebSocket, strona www               |
| `web-viewer/`    | viewer 3D w przeglądarce: obracanie, zoom, lista elementów; opcjonalnie WebXR |
| `quest-app/`     | natywna aplikacja Meta Quest                                                 |
| `shared/`        | protokół (JSON Schema, typy TS/Python/C#, fixtures) — wspólny kontrakt        |
| `tools/`         | symulator Slicera (`fake-slicer`), fixtures                                   |
| `docs/`          | wymagania, architektura, protokół, plany per komponent, ADR, testy, user guide |

Repo jest przygotowane do pracy z **Claude Code**: `CLAUDE.md` (zasady), `.claude/agents/` (subagenci),
`.claude/commands/` (komendy `/…`), `prompts/` (pełne prompty — te same, które uruchamiają komendy).

## Jak pracować z Claude Code

1. **Raz, na początku** — prompt celu: `/project-goal` (plik `prompts/00-goal.md`). Powstają
   `docs/requirements.md`, `docs/architecture.md`, `docs/protocol.md`, ADR‑y i plany
   `docs/plan/<komponent>.md` z zadaniami o ID (`SRV-03`, `WEB-07`, …), zależnościami i kryteriami akceptacji.
2. **Potem niezależnie** — workstreamy 01–07. Każdy czyta swój plan i protokół, pracuje na własnej gałęzi
   `ws/<komponent>`, robi kolejne zadania **małymi commitami** (implementacja → testy → `reviewer` → commit
   → status w planie) i zatrzymuje się po kilku zadaniach z propozycją PR. Argument komendy steruje
   uruchomieniem: liczba zadań (`/ws-server 5`), konkretne zadanie (`/ws-server SRV-04`), `status`, `plan`.
3. **Integracja** — `/ws-release M1` scala gałęzie, uruchamia pełne testy, pisze dokumentację użytkownika
   i wydanie.

| #  | Komenda          | Prompt                             | Gałąź         | Sensowne po            |
|----|------------------|------------------------------------|---------------|------------------------|
| 00 | `/project-goal`  | `prompts/00-goal.md`               | `main`        | —                      |
| 01 | `/ws-protocol`   | `prompts/01-protocol.md`           | `ws/protocol` | 00                     |
| 02 | `/ws-server`     | `prompts/02-relay-server.md`       | `ws/server`   | 00 (01 w `main` = łatwiej) |
| 03 | `/ws-web`        | `prompts/03-web-viewer.md`         | `ws/web`      | 00 (01, 02 = E2E)      |
| 04 | `/ws-slicer`     | `prompts/04-slicer-plugin.md`      | `ws/slicer`   | 00 (01)                |
| 05 | `/ws-quest`      | `prompts/05-quest-app.md`          | `ws/quest`    | 00 (01); zwykle M3     |
| 06 | `/ws-deploy`     | `prompts/06-deploy-ci.md`          | `ws/deploy`   | 02                     |
| 07 | `/ws-qa`         | `prompts/07-qa-security.md`        | `ws/qa`       | 02, 03                 |
| 08 | `/ws-release`    | `prompts/08-integration-release.md`| `main`        | PR‑y gotowe            |

Wspólna pętla pracy wszystkich workstreamów: `prompts/_workflow.md`.

### Równolegle

Każdy workstream może działać w osobnej sesji Claude Code w osobnym worktree, bez konfliktów
(każdy dotyka tylko swojego katalogu i swojego planu):

```bash
git worktree add ../srv-server ws/server   # albo: claude --worktree w każdym terminalu
cd ../srv-server && claude
> /ws-server 3
```

Zmiany protokołu (`docs/protocol.md`, `shared/`) są wyjątkiem — robi się je świadomie, najpierw dokument,
potem kod (patrz `CLAUDE.md`, zasada 2).

### Bez komend

Treść każdego promptu można też wkleić do Claude Code bezpośrednio (plik z `prompts/`), np. gdy pracujesz
w innym narzędziu — prompty są samowystarczalne.

## Stan projektu

Repo zawiera na razie **plan pracy** (prompty, subagenci, zasady). Dokumentacja i kod powstają po
uruchomieniu `/project-goal` i workstreamów.
