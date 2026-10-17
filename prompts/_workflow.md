# Pętla pracy workstreamu (wspólna dla promptów 01–07)

Ten plik jest częścią każdego promptu `ws-*` oprócz `ws-release` (08 ma własny przebieg). Oznaczenia:
`<komponent>` = nazwa z promptu (np. `server`), `<GAŁĄŹ>` = `ws/<komponent>`, `<PLAN>` =
`docs/plan/<komponent>.md`, `<DEV>` = subagent implementujący (np. `server-dev`) — pełna mapa w `CLAUDE.md`.

## Argument uruchomienia

Podawany przy komendzie (np. `/ws-server 5`) lub w pierwszej linii wiadomości (np. `Argument: SRV-04`). Znaczenie:

- liczba, np. `3` → wykonaj maksymalnie tyle zadań z planu (domyślnie **3**);
- ID zadania, np. `SRV-04` → wykonaj tylko to zadanie (plus jego niezrobione, małe zależności w tym komponencie);
- `status` → nie implementuj; pokaż stan planu, zadania zablokowane i propozycję następnego kroku;
- `plan` → tylko zaktualizuj/rozbij zadania w `<PLAN>` (za duże zadania, nieaktualne zależności), bez kodu.

## Start

1. Przeczytaj `CLAUDE.md`, `docs/protocol.md`, `<PLAN>` i `docs/plan/00-overview.md`. Jeśli `<PLAN>` nie
   istnieje → **zatrzymaj się** i poproś o uruchomienie `prompts/00-goal.md`. Nie wymyślaj własnego planu.
2. `git status` musi być czyste. `git fetch` (jeśli jest remote). Przełącz się na `<GAŁĄŹ>` (utwórz z `main`,
   jeśli nie istnieje). Jeśli `git worktree list` pokazuje, że `<GAŁĄŹ>` jest już wyewidencjonowana w innym
   worktree, nie twórz drugiej gałęzi — pracuj w tamtym worktree albo zapytaj. Jeśli `main` ma nowe commity
   dotykające `docs/protocol.md` lub `shared/`, zrób `git rebase main` (lub merge, gdy rebase jest ryzykowny)
   i powiedz mi o tym.
3. Sprawdź `docs/testing/reports/` pod kątem zgłoszeń dla swojego komponentu bez wpisu w `<PLAN>` — dopisz je
   jako zadania `todo` (następne wolne ID) w osobnym commicie `docs(plan): triage reports`.
4. Pokaż mi w 3–5 linijkach: co jest `done`, co jest zablokowane (brakujące zależności z innych komponentów),
   który milestone jest aktywny (`Active milestone:` w `docs/plan/00-overview.md`) i które zadania zrobisz teraz.

## Dla każdego zadania

1. Wybierz pierwsze zadanie `todo` o spełnionych zależnościach (statusy zależności sprawdzaj w planach innych
   komponentów na `main`). Jeśli zależność nie jest `done`, ale da się ją zastubować w ramach tego komponentu —
   zrób stub i zapisz w planie `[stub: <ID>]`. Ustaw status `doing`.
2. Krótki plan (3–6 kroków) i implementacja przez subagenta `<DEV>` (lub samodzielnie, gdy zadanie jest małe).
   Testy piszesz w tym samym zadaniu — **zadanie bez testu nie jest `done`** (wyjątek: zadania czysto
   dokumentacyjne lub wymagające Slicera/Unity/Railway — wtedy dopisz kroki testu manualnego do
   `docs/testing/<komponent>.md`).
3. Uruchom testy i lint. Jeśli czegoś nie da się uruchomić w sandboxie, napisz dokładnie, co i jak mam
   uruchomić u siebie (komendy, oczekiwany wynik).
4. Subagent `reviewer` ocenia diff względem kryteriów akceptacji, `docs/protocol.md` i `CLAUDE.md`.
   Uwagi high/medium wdrażasz; low zapisujesz w `<PLAN>` jako follow-up.
5. Commit: Conventional Commits z ID, np. `feat(server): session code generator (SRV-02)`. W tym samym
   commicie: status `done` w `<PLAN>` i aktualizacja `README.md` komponentu (komendy testów/buildu), jeśli coś
   się zmieniło. `CLAUDE.md` i `docs/plan/00-overview.md` zostaw — aktualizuje je `release` na `main`.
6. Jedna linijka podsumowania dla mnie → następne zadanie.

## Zmiana kontraktu

Jeśli zadanie wymaga zmiany `docs/protocol.md` lub `shared/`: najpierw dokument + numer wersji w osobnym
commicie `docs(protocol): …`, potem kod. Dopisz `[protocol change: vX.Y]` w planach komponentów, których to
dotyczy. Jeśli zmiana łamie zgodność wsteczną — zatrzymaj się i zapytaj.

## Kiedy się zatrzymać

- wyczerpany limit zadań (domyślnie 3) lub koniec zadań Twojego komponentu w aktywnym milestonie,
- decyzja nieodwracalna/niejasna (zapytaj; zaproponuj wariant domyślny),
- blokada przez inny komponent, której nie da się zastubować,
- testy nie przechodzą po 2 próbach naprawy (opisz problem; nie commituj zepsutego stanu).

Pytania blokujące zadawaj pod nagłówkiem **`PYTANIE DO UŻYTKOWNIKA`** (zwięźle, każde z proponowanym wariantem
domyślnym) i zakończ turę — w trybie `/goal` ten nagłówek oznacza zatrzymanie pracy do czasu odpowiedzi.

## Na koniec uruchomienia

- Podsumowanie po polsku: wykonane zadania (ID), co sprawdzić manualnie, otwarte pytania, następny krok.
- Propozycja PR `<GAŁĄŹ> → main`: tytuł, opis (lista ID), ryzyka. Jeśli jest remote i działa `gh` — utwórz
  draft PR; jeśli nie — podaj gotowy tytuł i opis do wklejenia.
