---
name: ws-server
description: "Workstream server: relay-server (Node/TS, ws + Fastify, Docker → Railway); gałąź ws/server, plan docs/plan/server.md"
argument-hint: "[liczba zadań | SRV-xx | status | plan]"
disable-model-invocation: true
---

Argument uruchomienia: `$ARGUMENTS` (pusty = domyślny: 3 zadania).

1. Przeczytaj narzędziem Read, w tej kolejności: `CLAUDE.md`, `prompts/_workflow.md`, `prompts/02-relay-server.md`. Pliki w `prompts/` są jedynym
   źródłem prawdy dla tej komendy — nie streszczaj ich z pamięci.
2. Wykonaj prompt `prompts/02-relay-server.md` zgodnie z pętlą pracy z `prompts/_workflow.md`, używając argumentu powyżej.
3. Odpowiadaj po polsku; kod, commity i dokumenty w repo po angielsku (patrz `CLAUDE.md`).
