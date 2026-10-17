# 02 — Workstream `server`: relay-server (Docker → Railway)

> Komponent: `server` · gałąź `ws/server` · plan `docs/plan/server.md` · subagent: `server-dev` (+ `reviewer`)
> · wymaga: `prompts/00-goal.md`; korzysta z `shared/` (jeśli `ws/protocol` nie jest jeszcze w `main`,
> użyj `docs/protocol.md` i zastubuj typy lokalnie, oznaczając `[stub: PRO-xx]`).
> Stosuj pętlę pracy z `prompts/_workflow.md` (argument uruchomienia: podany przy komendzie lub na początku wiadomości; brak = domyślny).

## Cel workstreamu

Serwer pośredniczący w `relay-server/`: przyjmuje połączenie z pluginu 3D Slicera, generuje **5‑znakowy kod
sesji**, łączy urządzenia (web‑viewer, Quest) z właściwą sesją, przekazuje snapshot sceny (GLB) i aktualizacje,
serwuje web‑viewer jako pliki statyczne. Działa jako jeden kontener Docker na Railway.

## Architektura (domyślna, zgodna z ADR; zmień tylko przez ADR)

- Node.js 20+ / TypeScript, `ws` (WebSocket) + Fastify (HTTP: statyczne pliki web‑viewera, `/api/*`, `/healthz`).
- Stan **tylko w pamięci**: `SessionStore` (kod → sesja: połączenie Slicera, lista widzów, bieżąca scena jako
  bufor GLB + wersja + metadane węzłów, `createdAt`, `lastSeen`, `expiresAt`). Żadnego zapisu na dysk, żadnych
  treści w logach (tylko identyfikatory, rozmiary, czasy).
- Kod sesji: alfabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (bez `0 O 1 I L`), 5 znaków, CSPRNG, unikalny wśród
  aktywnych sesji; TTL odświeżany heartbeatem Slicera; po rozłączeniu Slicera sesja żyje jeszcze `GRACE_SECONDS`
  (reconnect z tym samym `sessionToken`), potem widzowie dostają `session.end`.
- Routing: Slicer → wszyscy widzowie (snapshot, update, camera, end); widz → Slicer tylko typy dozwolone w
  protokole (np. `ping`, w późniejszych milestone'ach `view.pose`); widzowie nie widzą się nawzajem poza
  `clients.changed`.
- **Late join**: nowy widz dostaje ostatni snapshot z pamięci (chunkami lub przez `GET /api/session/:code/scene/:version`),
  potem strumień aktualizacji; wersjonowanie sceny zapobiega mieszaniu starych aktualizacji z nowym snapshotem.
- Backpressure: obserwuj `bufferedAmount`, wysyłaj chunkami, rozłączaj klientów, którzy nie nadążają
  (z komunikatem `error.slowConsumer`).
- Limity i ochrona: max rozmiar wiadomości/GLB (env), max widzów na sesję, rate limiting prób `join` na IP
  i globalnie, blokada kodu po N nieudanych próbach, timeout handshake, `helmet`/CSP, brak CORS poza własnym
  hostem (web‑viewer serwowany z tego samego originu).
- Konfiguracja przez env (`PORT` z Railway, `SESSION_TTL_SECONDS`, `GRACE_SECONDS`, `MAX_SCENE_BYTES`,
  `MAX_VIEWERS`, `LOG_LEVEL`, `PUBLIC_URL` do QR/deep linków); `.env.example` w repo.
- Obserwowalność: logi strukturalne (pino) bez treści; `/healthz` (dla Railway), `/metrics` (liczba sesji,
  widzów, bajty — bez identyfikatorów sesji).
- Graceful shutdown (SIGTERM z Railway przy redeployu): wyślij `session.end` z powodem `serverRestart`,
  klienci mają reconnectować; udokumentuj, że sesje nie przeżywają redeployu (świadoma decyzja ADR).

## Kolejność zadań (sugerowana; plan `SRV-xx` jest źródłem prawdy)

1. Szkielet: `package.json`, TS, eslint/prettier, vitest, `Dockerfile` (multi-stage, non-root, `node:20-alpine`),
   `.dockerignore`, `README.md`, `/healthz`.
2. Generator kodów + `SessionStore` z TTL (testy jednostkowe: unikalność, wygasanie, grace, limity).
3. WebSocket handshake i routing wg protokołu (testy integracyjne z dwoma klientami `ws` w procesie).
4. Snapshot/chunki/late join + endpoint pobrania sceny (testy z GLB z `tools/fixtures`).
5. Limity, rate limiting, backpressure, błędy (testy negatywne: zły kod, za duży blob, flood).
6. Serwowanie `web-viewer/dist` (jeśli jest) + `/j/:code` → aplikacja; CSP.
7. Logi, metryki, graceful shutdown; test E2E z `tools/fake-slicer` (jeśli dostępny) — inaczej z własnym
   minimalnym klientem testowym.

## Definition of Done tego uruchomienia

- zadania wg argumentu wykonane z testami (`npm test` zielone), lint czysty, `docker build` przechodzi
  (jeśli Docker jest dostępny w sandboxie; jeśli nie — opisz, że mam zbudować lokalnie);
- `relay-server/README.md`: jak uruchomić lokalnie, zmienne środowiskowe, jak przetestować z fake‑slicer;
- plan zaktualizowany, propozycja PR `ws/server → main`.
