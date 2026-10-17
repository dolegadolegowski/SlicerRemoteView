# 06 — Workstream `deploy`: CI/CD, Docker i Railway

> Komponent: `deploy` · gałąź `ws/deploy` · plan `docs/plan/deploy.md` · subagent: `server-dev` (CI/Docker)
> + `architect` (Railway) · wymaga: `prompts/00-goal.md`, `docs/research/relay.md`; najlepiej po wejściu
> `ws/server` do `main` (inaczej przygotuj workflow'y „na pusto”, z jobami pomijanymi, gdy katalog nie istnieje).
> Stosuj pętlę pracy z `prompts/_workflow.md` (argument uruchomienia: podany przy komendzie lub na początku wiadomości; brak = domyślny).

## Cel workstreamu

Każdy push ma być zweryfikowany automatycznie, a `main` ma się sam wdrażać na Railway. Pakiety do dystrybucji
(plugin Slicera jako zip, APK Quest dołączany ręcznie) powstają z tagów.

## Zakres

1. **GitHub Actions – CI** (`.github/workflows/ci.yml`): osobne joby dla `shared/`, `relay-server/`,
   `web-viewer/` (lint, test, build) i `slicer-plugin/` (`pytest` rdzenia; `ruff`), uruchamiane przy zmianach
   w danym katalogu (`paths`) oraz dla PR; cache zależności; status checks pod branch protection na `main`.
2. **Docker**: build obrazu relay (z web‑viewerem w środku) w CI, smoke test (`/healthz`), opcjonalnie publikacja
   do GHCR z tagiem SHA.
3. **Railway**: `railway.json`/`railway.toml` (build z Dockerfile, `healthcheckPath: /healthz`, restart policy,
   region EU), dokumentacja połączenia repo z Railway (auto‑deploy z `main`, PR environments jeśli dostępne),
   lista zmiennych środowiskowych do ustawienia w Railway (`.env.example` jako źródło prawdy), domena i
   `PUBLIC_URL`. Jeśli ADR tak mówi — alternatywnie `railway up` z CLI w workflow z sekretem `RAILWAY_TOKEN`.
   **Nie wykonuj deployu sam**; przygotuj wszystko, a kroki klikane w Railway opisz w `docs/deploy.md`.
4. **Release** (`.github/workflows/release.yml`): na tag `v*` buduje zip pluginu Slicera (zgodnie z `slicer-plugin/README.md`),
   generuje changelog z commitów (conventional commits), tworzy GitHub Release; APK Quest — pole do ręcznego dołączenia.
5. **Higiena**: Dependabot (npm, pip, GitHub Actions), `CODEOWNERS` (opcjonalnie), szablony PR/issue z checklistą
   (test, plan zaktualizowany, protokół niezmieniony lub ADR).
6. **Bezpieczeństwo łańcucha**: `npm audit`/`pip-audit` w CI jako job nieblokujący; pinowanie akcji do SHA.

## Zasady specyficzne

- Nie wymagaj sekretów do przejścia CI dla PR z forków.
- Workflow'y muszą działać także, gdy dany katalog jeszcze nie istnieje (warunek `if: hashFiles(...) != ''`).
- Testuj workflow'y lokalnie, jeśli jest `act`; inaczej zrób walidację składni (`actionlint`, jeśli dostępny)
  i opisz, co sprawdzić po pierwszym pushu.

## Definition of Done tego uruchomienia

- workflow'y dodane i zwalidowane; `docs/deploy.md` z krokami Railway (klik po kliku) i listą env;
- plan zaktualizowany, propozycja PR `ws/deploy → main`.
