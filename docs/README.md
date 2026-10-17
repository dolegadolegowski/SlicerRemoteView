# docs/

Dokumentacja projektu powstaje z promptu celu (`prompts/00-goal.md`) i jest utrzymywana przez workstreamy.

| Plik / katalog           | Zawartość                                                                 | Kto utrzymuje |
|--------------------------|---------------------------------------------------------------------------|---------------|
| `research/<temat>.md`    | notatki z rozpoznania technologii (z linkami do źródeł)                   | `architect`   |
| `requirements.md`        | persony, user stories, FR-xx / NFR-xx, out of scope, ryzyka                | goal          |
| `architecture.md`        | komponenty, sekwencje (Mermaid), model sesji, bezpieczeństwo               | goal          |
| `protocol.md`            | **kontrakt**: wersja, wiadomości JSON, ramki binarne, endpointy HTTP, błędy | `/ws-protocol` + zmiany wg CLAUDE.md zasada 2 |
| `adr/NNNN-*.md`          | decyzje architektoniczne (kontekst → decyzja → konsekwencje)              | każdy, kto podejmuje decyzję |
| `plan/00-overview.md`    | milestone'y M0–M4, ścieżka krytyczna, mapa zależności workstreamów        | goal          |
| `plan/<komponent>.md`    | zadania z ID, zależnościami, kryteriami akceptacji i statusem             | dany workstream |
| `testing/`               | plany testów manualnych (Slicer, iPhone, Quest), raporty QA               | `qa`          |
| `user-guide/`            | dokumentacja użytkownika (instalacja pluginu, łączenie urządzeń)          | release       |

Prefiksy ID zadań: `PRO-` protokół, `SRV-` relay-server, `WEB-` web-viewer, `SLC-` slicer-plugin,
`QST-` quest-app, `DEP-` deploy/CI, `QA-` testy/bezpieczeństwo, `REL-` integracja/release.
