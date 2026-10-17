# 08 — Workstream `release`: integracja gałęzi, dokumentacja użytkownika, wydanie

> Komponent: `release` · pracuje na `main` (plus krótkotrwałe gałęzie `release/vX.Y`) · plan
> `docs/plan/00-overview.md` (sekcja milestone'ów) · subagenci: `reviewer`, `qa`, `architect` · wymaga: PR‑ów
> z workstreamów gotowych do scalenia. Stosuj pętlę pracy z `prompts/_workflow.md` w wersji dla integracji
> (zadania = kroki poniżej; argument uruchomienia = milestone, np. `M1`, albo `status`; podany przy komendzie lub na początku wiadomości).

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
   Dodatkowo `docs/user-guide/demo-script.md`: 10‑minutowy scenariusz pokazu na zajęciach.
5. **Wydanie**: wersje (protokół, relay, web, plugin, quest) wg semver w jednym miejscu (`VERSIONS.md` lub
   `package.json`/metadane), `CHANGELOG.md` z conventional commits, tag `vX.Y.Z`, GitHub Release
   (workflow z `ws/deploy`): zip pluginu; APK Quest dołączam ręcznie — przypomnij mi.
6. **Retro** (krótko, w `docs/plan/00-overview.md`): co spowolniło, co zmienić w planach/promptach; jeśli trzeba
   — zaproponuj poprawki do `prompts/*.md` i `CLAUDE.md` jako osobny commit `chore(prompts): …`.

## Definition of Done tego uruchomienia

- milestone scalony do `main`, CI zielone, E2E zielone;
- dokumentacja użytkownika (PL/EN) i changelog zaktualizowane, tag utworzony (lub gotowa komenda, jeśli wolę
  tagować sam — zapytaj);
- podsumowanie po polsku: co zawiera wydanie, co odłożono, co uruchomić dalej.
