# 01 — Workstream `protocol`: kontrakt i pakiet `shared/` (+ symulator Slicera)

> Komponent: `protocol` · gałąź `ws/protocol` · plan `docs/plan/protocol.md` · subagenci: `architect` (projekt),
> `server-dev` (kod w `shared/` i `tools/`) · wymaga: wykonanego `prompts/00-goal.md`.
> Stosuj pętlę pracy z `prompts/_workflow.md` (argument uruchomienia: podany przy komendzie lub na początku wiadomości; brak = domyślny).

## Cel workstreamu

Zamienić `docs/protocol.md` v1 w **wykonywalny kontrakt**, z którego korzystają wszystkie komponenty
(relay-server, web-viewer, slicer-plugin, quest-app), oraz dostarczyć **symulator Slicera**, dzięki któremu
serwer, web‑viewer i QA mogą pracować bez prawdziwego 3D Slicera.

## Zakres (zadania `PRO-xx` w planie; uzupełnij plan, jeśli czegoś brakuje)

1. **Schematy**: `shared/schema/*.json` — JSON Schema (draft 2020‑12) dla każdej wiadomości z `docs/protocol.md`
   (koperta, `session.create/created`, `join/joined`, `scene.snapshot`, `blob.begin/end`, `scene.update`,
   `camera.update`, `clients.changed`, `session.end`, `error`, `ping/pong` — nazwy wg protokołu).
   Wspólna koperta: `{ v, type, id?, ts, payload }`.
2. **Ramki binarne**: dokładna specyfikacja chunkowania GLB (nagłówek ramki, rozmiar chunku, kolejność, hash
   całości, limity) + wektory testowe (`shared/fixtures/blob-*.bin` + opis).
3. **Fixtures**: `shared/fixtures/messages/*.json` — przykład każdej wiadomości (poprawnej i niepoprawnej),
   używany jako test zgodności w każdym języku (TS, Python, C#).
4. **Typy wygenerowane**: TypeScript (`shared/ts/`, np. `json-schema-to-typescript`), Python
   (`shared/py/` — `TypedDict`/dataclasses + walidacja `jsonschema`), C# (`shared/cs/` — rekordy do użycia
   w Unity; bez zależności niedostępnych w Unity). Generowanie jednym skryptem (`shared/scripts/generate.*`),
   wynik commitowany (komponenty nie muszą nic generować).
5. **Testy zgodności**: w każdym języku test wczytujący fixtures i walidujący je schematami
   (TS: vitest; Python: pytest; C#: jeśli dostępne `dotnet` — xunit, inaczej opisz test EditMode).
6. **Symulator**: `tools/fake-slicer/` (TypeScript CLI): łączy się z relay jako Slicer, tworzy sesję, wypisuje
   kod, wysyła GLB z `tools/fixtures/` (dodaj mały, poprawnie licencjonowany model anatomiczny lub wygeneruj
   proceduralnie kilka siatek z nazwami, kolorami, przezroczystością), a potem odtwarza skrypt aktualizacji
   (`--script updates.json`: zmiany widoczności/koloru/transformacji co N ms), obsługuje `--loop`, `--late-join-test`.
7. **Dokument**: `docs/protocol.md` doprowadzony do stanu „1.0”: sekwencje Mermaid, tabela uprawnień
   (kto może wysłać jaki typ), kody błędów, reguły wersjonowania (minor = kompatybilne, major = nie),
   limity (max rozmiar GLB, max klientów, TTL kodu, heartbeat).

## Zasady specyficzne

- Każda zmiana semantyki protokołu = zmiana `docs/protocol.md` **przed** schematami i kodem.
- Nazwy pól: `camelCase`; identyfikatory węzłów sceny stabilne między snapshotami (`nodeId`), niezależne od
  nazw wyświetlanych.
- Układ współrzędnych i jednostki zapisz jawnie w protokole (Slicer: RAS, mm; glTF: Y‑up, metry) — konwersja
  odbywa się po stronie Slicera przy eksporcie; viewer dostaje gotowy glTF.
- Pakiet `shared/` nie może mieć zależności runtime poza walidatorem schematów.

## Definition of Done tego uruchomienia

- zadania wg argumentu wykonane, każde z testem i osobnym commitem; plan zaktualizowany;
- `shared/` i `tools/fake-slicer` mają `README.md` z instrukcją użycia (`npx fake-slicer --relay ws://localhost:8080`);
- propozycja PR `ws/protocol → main`.
