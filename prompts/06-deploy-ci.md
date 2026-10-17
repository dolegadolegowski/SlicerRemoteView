# 06 — Workstream `deploy`: CI/CD, Docker i Railway

> Komponent: `deploy` · gałąź `ws/deploy` · plan `docs/plan/deploy.md` · subagent: `server-dev` (CI, Docker,
> konfiguracja Railway) + `architect` tylko do weryfikacji w dokumentacji Railway · wymaga: `prompts/00-goal.md`,
> `docs/research/relay.md`; najlepiej po wejściu
> `ws/server` do `main` (inaczej przygotuj workflow'y „na pusto”, z jobami pomijanymi, gdy katalog nie istnieje).
> Stosuj pętlę pracy z `prompts/_workflow.md` (argument uruchomienia: podany przy komendzie lub na początku wiadomości; brak = domyślny).

## Cel workstreamu

Każdy push ma być zweryfikowany automatycznie, a `main` ma się sam wdrażać na Railway. Pakiety do dystrybucji
(plugin Slicera jako zip, APK Quest dołączany ręcznie) powstają z tagów.

## Zakres

1. **GitHub Actions – CI** (`.github/workflows/ci.yml`): jeden workflow z jobem `detect` (zmienione ścieżki →
   outputs) i osobnymi jobami dla `shared/` (testy + `generate` i `git diff --exit-code` na wygenerowanych typach),
   `relay-server/`, `web-viewer/` (lint, test, build) i `slicer-plugin/` (`pytest` rdzenia; `ruff`); joby
   niedotyczące zmian kończą się szybko jako „skipped/no-op”, ale zawsze raportują status (wymagane checki pod
   branch protection na `main` nie mogą wisieć jako „expected”). Cache zależności.
2. **Docker**: build obrazu relay (z web-viewerem w środku) w CI, smoke test (`/healthz`), opcjonalnie publikacja
   do GHCR z tagiem SHA.
3. **Railway**: `railway.json`/`railway.toml` (build z `relay-server/Dockerfile` przy kontekście = root,
   `healthcheckPath: /healthz`, restart policy; region EU i liczba replik = 1 to ustawienia serwisu w panelu —
   opisz je), dokumentacja połączenia repo z Railway (auto-deploy z `main`, PR environments, jeśli dostępne),
   lista zmiennych środowiskowych do ustawienia w Railway (`.env.example` jako źródło prawdy), domena i
   `PUBLIC_URL`. Jeśli ADR tak mówi — alternatywnie `railway up` z CLI w workflow z sekretem `RAILWAY_TOKEN`.
   **Nie wykonuj deployu sam**; przygotuj wszystko, a kroki klikane w Railway opisz w `docs/deploy.md`.
4. **Release** (`.github/workflows/release.yml`): na tag `v*` buduje zip pluginu Slicera (zgodnie z `slicer-plugin/README.md`)
   i tworzy GitHub Release z treścią wziętą z `CHANGELOG.md` (jedno źródło changelogu, utrzymywane przez `release`);
   APK Quest — pole do ręcznego dołączenia.
5. **Higiena**: Dependabot (npm, pip, GitHub Actions), `CODEOWNERS` (opcjonalnie), szablony PR/issue z checklistą
   (test, plan zaktualizowany, protokół niezmieniony lub ADR).
6. **Bezpieczeństwo łańcucha**: `npm audit`/`pip-audit` w CI jako job nieblokujący; pinowanie akcji do SHA.

## Zasady specyficzne

- Nie wymagaj sekretów do przejścia CI dla PR z forków.
- Workflow'y muszą działać także, gdy dany katalog jeszcze nie istnieje: sprawdzaj to w jobie `detect`
  (po `checkout`, np. `test -d relay-server`) i przekazuj przez outputs — `hashFiles` nie działa na poziomie
  `jobs.<id>.if`.
- Testuj workflow'y lokalnie, jeśli jest `act`; inaczej zrób walidację składni (`actionlint`, jeśli dostępny)
  i opisz, co sprawdzić po pierwszym pushu.

## Definition of Done tego uruchomienia

- workflow'y dodane i zwalidowane; `docs/deploy.md` z krokami Railway (klik po kliku) i listą env;
- plan zaktualizowany, propozycja PR `ws/deploy → main`.
