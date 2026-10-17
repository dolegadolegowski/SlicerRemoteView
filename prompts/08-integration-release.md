# 08 — Workstream `release`: integracja gałęzi, dokumentacja użytkownika, wydanie

> Komponent: `release` · pracuje na `main` (plus krótkotrwałe gałęzie `release/vX.Y`) · plan
> `docs/plan/00-overview.md` (sekcja milestone'ów) · subagenci: `reviewer`, `qa`, `architect` · wymaga: PR-ów
> z workstreamów gotowych do scalenia.
>
> **Ten prompt NIE używa pętli z `prompts/_workflow.md`** (ona jest dla komponentów na gałęziach `ws/*`).
> Przebieg jest opisany w „Krokach” poniżej. Argument uruchomienia (przy komendzie lub w pierwszej linii
> wiadomości): milestone, np. `M1` — wykonaj kroki 1–6 dla tego milestone'u; `status` (domyślny) — tylko
> krok 1. Zatrzymuj się z nagłówkiem `PYTANIE DO UŻYTKOWNIKA` przy konfliktach w `docs/protocol.md`, decyzjach
> o tagu/wersji i wszędzie tam, gdzie zmiana jest nieodwracalna (merge, tag, publikacja).

## Cel workstreamu

Doprowadzić milestone do stanu „działa razem”: scalić gałęzie workstreamów w dobrej kolejności, przejść pełne
testy, uzupełnić dokumentację użytkownika i wydać wersję.

## Kroki

1. **Stan**: dla każdego workstreamu pokaż, co jest w PR/gałęzi vs `main`, które zadania milestone'u są `done`,
   co blokuje. Zaproponuj kolejność scalania (domyślnie: `protocol → server → web → slicer → quest → deploy → qa`).
2. **Scalanie**: dla każdej gałęzi — rebase na `main`, rozwiąż konflikty (przy konflikcie w `docs/protocol.md`
   zatrzymaj się i zapytaj), uruchom testy danego komponentu, przegląd `reviewer` całego PR, merge (squash lub
   merge commit wg ustaleń; domyślnie merge commit, żeby zachować commity per zadanie). Po każdym scaleniu
   zaktualizuj statusy w planach innych komponentów, jeśli coś odblokowało.
3. **Pełna weryfikacja**: CI zielone, E2E z `tests/e2e`, build Dockera, `docs/plan/00-overview.md` — milestone
   oznaczony jako zakończony z datą; lista rzeczy odłożonych (follow-upy) przeniesiona do następnego milestone'u.
4. **Dokumentacja użytkownika** → `docs/user-guide/`: instalacja extension w Slicerze (macOS/Windows), start
   sesji i odczyt kodu/QR, łączenie telefonu/tabletu, łączenie Quest (Browser/WebXR lub aplikacja), rozwiązywanie
   problemów (zły kod, sieć szpitalna, duża scena), informacja o prywatności. Po polsku **i** po angielsku
   (`docs/user-guide/pl/`, `docs/user-guide/en/`) — ta dokumentacja jest dla użytkowników, nie deweloperów.
   Dodatkowo `docs/user-guide/demo-script.md`: 10-minutowy scenariusz pokazu na zajęciach.
   W tym kroku także: przenieś do planów komponentów zgłoszenia z `docs/testing/reports/`, które nie mają
   jeszcze właściciela, i zaktualizuj threat model w `docs/architecture.md` o wyniki `qa`.
5. **Wydanie**: wersje (protokół, relay, web, plugin, quest) wg semver w jednym miejscu (`VERSIONS.md` lub
   `package.json`/metadane), `CHANGELOG.md` z conventional commits (jedyne źródło treści GitHub Release),
   przesunięcie `Active milestone:` w `docs/plan/00-overview.md`, uzupełnienie sekcji „Komendy projektu”
   w `CLAUDE.md`, tag `vX.Y.Z` (zapytaj przed utworzeniem), GitHub Release (workflow z `ws/deploy`): zip pluginu;
   APK Quest dołączam ręcznie — przypomnij mi.
6. **Retro** (krótko, w `docs/plan/00-overview.md`): co spowolniło, co zmienić w planach/promptach; jeśli trzeba
   — zaproponuj poprawki do `prompts/*.md` i `CLAUDE.md` jako osobny commit `chore(prompts): …`.

## Definition of Done tego uruchomienia

- milestone scalony do `main`, CI zielone, E2E zielone;
- dokumentacja użytkownika (PL/EN) i changelog zaktualizowane, tag utworzony (lub gotowa komenda, jeśli wolę
  tagować sam — zapytaj);
- podsumowanie po polsku: co zawiera wydanie, co odłożono, co uruchomić dalej.
