# 07 — Workstream `qa`: testy E2E, obciążeniowe i bezpieczeństwo

> Komponent: `qa` · gałąź `ws/qa` · plan `docs/plan/qa.md` · subagenci: `qa` (testy), `architect` (threat model),
> `reviewer` · wymaga: `prompts/00-goal.md`; sensowne po wejściu `ws/server` i `ws/web` do `main`
> (wcześniej: argument `plan`, strategia testów, threat model).
> Stosuj pętlę pracy z `prompts/_workflow.md` (argument uruchomienia: podany przy komendzie lub na początku wiadomości; brak = domyślny).

## Cel workstreamu

Niezależna weryfikacja całości: czy system działa end-to-end, wytrzymuje obciążenie i nie da się go łatwo
nadużyć — ze szczególną uwagą na to, że przez relay mogą przechodzić dane pochodzące z badań pacjentów.

## Zasada niezależności

`qa` **nie naprawia kodu komponentów** i **nie edytuje cudzych planów** (konflikty merge). Każdy znaleziony
błąd zapisuje w `docs/testing/reports/<data>.md` (jeden wpis = komponent, tytuł, kroki reprodukcji, oczekiwane
vs faktyczne, waga, wersja/commit). Właściciel komponentu przenosi wpis do swojego planu na starcie
następnego uruchomienia (`CLAUDE.md`, zasada 9), a `release` sprawdza, czy nic nie zostało bez właściciela.
`qa` edytuje tylko `tests/`, `docs/testing/`, `docs/security.md` i swój plan.

## Zakres

1. **Strategia** → `docs/testing/strategy.md`: piramida testów, co jest automatyczne a co manualne (Slicer,
   iPhone, Quest), środowiska (lokalne z fake-slicer, Railway staging), dane testowe (fixtures bez PHI).
2. **E2E automatyczne** (`tests/e2e/`, Playwright): relay + `tools/fake-slicer` + web-viewer: dołączenie kodem,
   deep link, model widoczny, aktualizacja widoczności/koloru, late join, reconnect po zerwaniu, wygaśnięcie
   sesji, drugi widz, zły kod ×N → blokada. Emulacja iPhone Safari i Android Chrome (viewport, dotyk).
3. **Obciążenie** (`tests/load/`, k6 z modułem `k6/ws` albo własny skrypt na `ws` — autocannon nie obsługuje
   WebSocketów): 1 sesja × 20 widzów, 10 sesji × 5 widzów, scena na limicie protokołu (`MAX_SCENE_BYTES`,
   domyślnie ~25 MB) i tuż ponad nim, częste aktualizacje; raport: opóźnienie kod→model, zużycie pamięci relay,
   zachowanie przy wolnym kliencie.
4. **Bezpieczeństwo** → `docs/security.md` + testy negatywne: brute force kodu (rate limit, blokada), za duże
   wiadomości, zły JSON, nieautoryzowane typy wiadomości od widza, podszywanie się pod Slicera, slowloris,
   nagłówki (CSP, HSTS), brak treści, kodów i tokenów w logach i ścieżkach URL, TTL i grace,
   `npm audit`/`pip-audit`. Wyniki zgłoś do threat modelu w `docs/architecture.md` (kanoniczny; `release`
   wprowadza zmianę), nie kopiuj go do `docs/security.md`.
5. **Prywatność / RODO** (checklista w `docs/security.md`): co opuszcza komputer ze Slicerem (tylko siatki i
   nazwy węzłów — ostrzeżenie w pluginie, że nazwy nie mogą zawierać danych pacjenta), brak utrwalania,
   region EU hostingu, czas retencji = TTL, co powiedzieć użytkownikom w dokumentacji.
6. **Testy manualne**: jeden plik na komponent — `docs/testing/slicer.md`, `docs/testing/web.md` (sekcje:
   iPhone Safari, Android Chrome, Quest Browser/WebXR), `docs/testing/quest.md` (aplikacja natywna). Workstreamy
   deweloperskie dopisują tam kroki dla swoich zadań; `qa` porządkuje je w scenariusze end-to-end z oczekiwanym
   wynikiem i miejscem na wynik/datę/wersję (bez tworzenia równoległego zestawu plików).

## Definition of Done tego uruchomienia

- zadania wg argumentu wykonane; testy E2E/obciążeniowe uruchamialne jedną komendą (opisaną w `tests/README.md`)
  i podpięte do CI jako osobny job (jeśli `ws/deploy` jest w `main`; inaczej zadanie dla `DEP-`);
- błędy zgłoszone w `docs/testing/reports/<data>.md` (z komponentem i wagą);
- plan zaktualizowany, propozycja PR `ws/qa → main`.
