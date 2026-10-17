---
name: ws-qa
description: "Workstream qa: testy E2E, obciążeniowe, bezpieczeństwo/RODO, plany testów manualnych; gałąź ws/qa, plan docs/plan/qa.md"
argument-hint: "[liczba zadań | QA-xx | status | plan]"
disable-model-invocation: true
---

Argument uruchomienia: `$ARGUMENTS` (pusty = domyślny: 3 zadania).

1. Przeczytaj narzędziem Read, w tej kolejności: `CLAUDE.md`, `prompts/_workflow.md`, `prompts/07-qa-security.md`. Pliki w `prompts/` są jedynym
   źródłem prawdy dla tej komendy — nie streszczaj ich z pamięci.
2. Wykonaj prompt `prompts/07-qa-security.md` zgodnie z pętlą pracy z `prompts/_workflow.md`, używając argumentu powyżej.
3. Odpowiadaj po polsku; kod, commity i dokumenty w repo po angielsku (patrz `CLAUDE.md`).
