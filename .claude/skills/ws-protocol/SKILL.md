---
name: ws-protocol
description: "Workstream protocol: shared/ (JSON Schema, typy TS/Python/C#, fixtures) i symulator tools/fake-slicer; gałąź ws/protocol, plan docs/plan/protocol.md"
argument-hint: "[liczba zadań | PRO-xx | status | plan]"
disable-model-invocation: true
---

Argument uruchomienia: `$ARGUMENTS` (pusty = domyślny: 3 zadania).

1. Przeczytaj narzędziem Read, w tej kolejności: `CLAUDE.md`, `prompts/_workflow.md`, `prompts/01-protocol.md`. Pliki w `prompts/` są jedynym
   źródłem prawdy dla tej komendy — nie streszczaj ich z pamięci.
2. Wykonaj prompt `prompts/01-protocol.md` zgodnie z pętlą pracy z `prompts/_workflow.md`, używając argumentu powyżej.
3. Odpowiadaj po polsku; kod, commity i dokumenty w repo po angielsku (patrz `CLAUDE.md`).
