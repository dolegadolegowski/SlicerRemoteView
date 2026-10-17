# 02 — Workstream `server`: relay-server (Docker → Railway)

> Komponent: `server` · gałąź `ws/server` · plan `docs/plan/server.md` · subagent: `server-dev` (+ `reviewer`)
> · wymaga: `prompts/00-goal.md`; korzysta z `shared/` (jeśli `ws/protocol` nie jest jeszcze w `main`,
> użyj `docs/protocol.md` i zastubuj typy lokalnie, oznaczając `[stub: PRO-xx]`).
> Stosuj pętlę pracy z `prompts/_workflow.md` (argument uruchomienia: podany przy komendzie lub na początku wiadomości; brak = domyślny).

## Cel workstreamu

Serwer pośredniczący w `relay-server/`: przyjmuje połączenie z pluginu 3D Slicera, generuje **5-znakowy kod
sesji**, łączy urządzenia (web-viewer, Quest) z właściwą sesją, przekazuje snapshot sceny (GLB) i aktualizacje,
serwuje web-viewer jako pliki statyczne. Działa jako jeden kontener Docker na Railway.

## Architektura (domyślna — obowiązuje, o ile ADR z promptu celu nie zdecydował inaczej)

- Node.js 22 LTS / TypeScript, `ws` (WebSocket) + Fastify (HTTP: statyczne pliki web-viewera przez
  `@fastify/static`, `/api/*`, `/healthz`); `trustProxy` włączone, bo relay stoi za proxy Railway (inaczej
  rate limiting per IP widzi adres proxy).
- Stan **tylko w pamięci**: `SessionStore` (kod → sesja: połączenie Slicera, lista widzów, bieżąca scena jako
  bufor GLB + wersja + metadane węzłów, `createdAt`, `lastSeen`, `expiresAt`). Żadnego zapisu na dysk, żadnych
  treści w logach (tylko identyfikatory, rozmiary, czasy).
- Kod sesji: alfabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (bez `0 O 1 I L`), 5 znaków, CSPRNG, unikalny wśród
  aktywnych sesji; TTL odświeżany heartbeatem Slicera; po rozłączeniu Slicera sesja żyje jeszcze `GRACE_SECONDS`
  (reconnect z tym samym `sessionToken`), potem widzowie dostają `session.end`.
- Routing: Slicer → wszyscy widzowie (snapshot, update, camera, end); widz → Slicer tylko typy dozwolone w
  protokole (np. `ping`, w późniejszych milestone'ach `view.pose`); widzowie nie widzą się nawzajem poza
  `clients.changed`.
- **Late join**: nowy widz dostaje ostatni snapshot z pamięci (chunkami po WebSocket lub przez
  `GET /api/scene/:version` autoryzowane nagłówkiem z tokenem widza — kod sesji **nigdy** w ścieżce URL,
  bo ścieżki trafiają do logów edge'a Railway), potem strumień aktualizacji; wersjonowanie sceny zapobiega
  mieszaniu starych aktualizacji z nowym snapshotem.
- Backpressure: obserwuj `bufferedAmount`, wysyłaj chunkami, rozłączaj klientów, którzy nie nadążają
  (wiadomość `error` z `code: "slowConsumer"`).
- Limity i ochrona: max rozmiar wiadomości/GLB (env), max widzów na sesję, rate limiting prób `join` na IP
  i globalnie (`@fastify/rate-limit`), blokada kodu po N nieudanych próbach, timeout handshake,
  `@fastify/helmet`/CSP, brak CORS poza własnym hostem (web-viewer serwowany z tego samego originu).
- Konfiguracja przez env (`PORT` z Railway, `SESSION_TTL_SECONDS`, `GRACE_SECONDS`, `MAX_SCENE_BYTES`,
  `MAX_VIEWERS`, `LOG_LEVEL`, `PUBLIC_URL` do QR/deep linków); `.env.example` w repo.
- Obserwowalność: logi strukturalne (pino) bez treści, bez kodów i tokenów; `/healthz` (dla Railway),
  `/metrics` (liczba sesji, widzów, bajty — bez identyfikatorów sesji) chroniony tokenem z env lub wyłączony
  domyślnie.
- Graceful shutdown (SIGTERM z Railway przy redeployu): wyślij `session.end` z powodem `serverRestart`,
  klienci mają reconnectować; udokumentuj, że sesje nie przeżywają redeployu i że serwis działa w **jednej
  replice** (stan w pamięci) — świadoma decyzja ADR.
- Docker: `relay-server/Dockerfile` budowany z **kontekstu = katalog główny repo** (potrzebuje `shared/` i
  `web-viewer/`), multi-stage (build web-viewera i serwera → runtime `node:22-alpine`, non-root), główny
  `.dockerignore`; Railway wskazuje `dockerfilePath` w konfiguracji z workstreamu `deploy`.

## Kolejność zadań (sugerowana; plan `SRV-xx` jest źródłem prawdy)

1. Szkielet: `package.json` (workspace), TS, eslint/prettier, vitest, `Dockerfile` (multi-stage, non-root,
   kontekst = root), główny `.dockerignore`, `README.md`, `/healthz`.
2. Generator kodów + `SessionStore` z TTL (testy jednostkowe: unikalność, wygasanie, grace, limity).
3. WebSocket handshake i routing wg protokołu (testy integracyjne z dwoma klientami `ws` w procesie).
4. Snapshot/chunki/late join + endpoint pobrania sceny (testy z GLB z `tools/fixtures`).
5. Limity, rate limiting, backpressure, błędy (testy negatywne: zły kod, za duży blob, flood).
6. Serwowanie `web-viewer/dist` (jeśli jest) + `/j` → aplikacja (kod we fragmencie URL); CSP.
7. Logi, metryki, graceful shutdown; test E2E z `tools/fake-slicer` (jeśli dostępny) — inaczej z własnym
   minimalnym klientem testowym.

## Definition of Done tego uruchomienia

- zadania wg argumentu wykonane z testami (`npm test` zielone), lint czysty, `docker build` przechodzi
  (jeśli Docker jest dostępny w sandboxie; jeśli nie — opisz, że mam zbudować lokalnie);
- `relay-server/README.md`: jak uruchomić lokalnie, zmienne środowiskowe, jak przetestować z fake-slicer;
- plan zaktualizowany, propozycja PR `ws/server → main`.
