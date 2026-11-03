# docs/

Dokumentacja projektu powstaje z promptu celu (`prompts/00-goal.md`) i jest utrzymywana przez workstreamy
zgodnie z regułą własności plików w `CLAUDE.md` (zasada 4).

| Plik / katalog             | Zawartość                                                                  | Kto utrzymuje |
|----------------------------|----------------------------------------------------------------------------|---------------|
| `research/<temat>.md`      | notatki z rozpoznania technologii (z linkami do źródeł i wersjami)         | `architect` (nowe pliki — każdy workstream) |
| `requirements.md`          | persony, user stories, FR-xx / NFR-xx, out of scope, ryzyka                 | goal, potem `release` |
| `architecture.md`          | komponenty, sekwencje (Mermaid), model sesji, **threat model (kanoniczny)** | goal, potem `release` |
| `protocol.md`              | **kontrakt**: wersja, wiadomości JSON, ramki binarne, endpointy HTTP, błędy | `protocol` + zmiany wg `CLAUDE.md` zasada 2 |
| `adr/NNNN-*.md`            | decyzje architektoniczne (kontekst → decyzja → konsekwencje)               | każdy, kto podejmuje decyzję (nowe pliki) |
| `plan/00-overview.md`      | milestone'y M0–M4, `Active milestone:`, ścieżka krytyczna, mapa zależności | goal, potem `release` |
| `plan/<komponent>.md`      | zadania z ID, zależnościami, kryteriami akceptacji i statusem              | dany workstream |
| `testing/strategy.md`      | strategia testów (co automatyczne, co manualne, środowiska, dane testowe)  | `qa`          |
| `testing/<komponent>.md`   | kroki testów manualnych per komponent (`slicer`, `web`, `quest`, …)        | dany workstream; `qa` porządkuje w scenariusze |
| `testing/reports/<data>.md`| zgłoszenia błędów między komponentami (triage przez właściciela na starcie) | `qa` (zgłasza), właściciel (przenosi do planu) |
| `security.md`              | checklista bezpieczeństwa i prywatności (RODO), wyniki testów negatywnych   | `qa`          |
| `deploy.md`                | kroki konfiguracji Railway (klik po kliku), zmienne środowiskowe            | `deploy`      |
| `release/<temat>.md`       | listy kroków wydania (np. `extensions-index.md`: zgłoszenie do Slicer Extensions Index) | `release`     |
| `user-guide/{pl,en}/`      | dokumentacja użytkownika (instalacja pluginu, łączenie urządzeń)            | `release`     |

Prefiksy ID zadań: `PRO-` protokół, `SRV-` relay-server, `WEB-` web-viewer, `SLC-` slicer-plugin,
`QST-` quest-app, `DEP-` deploy/CI, `QA-` testy/bezpieczeństwo. Integracja (`release`) nie ma własnych zadań —
śledzi milestone'y w `plan/00-overview.md`.
