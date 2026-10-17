---
name: ws-deploy
description: "Workstream deploy: GitHub Actions, Docker, Railway, release; gałąź ws/deploy, plan docs/plan/deploy.md"
argument-hint: "[liczba zadań | DEP-xx | status | plan]"
disable-model-invocation: true
---

Argument uruchomienia: `$ARGUMENTS` (pusty = domyślny: 3 zadania).

1. Przeczytaj narzędziem Read, w tej kolejności: `CLAUDE.md`, `prompts/_workflow.md`, `prompts/06-deploy-ci.md`. Pliki w `prompts/` są jedynym
   źródłem prawdy dla tej komendy — nie streszczaj ich z pamięci.
2. Wykonaj prompt `prompts/06-deploy-ci.md` zgodnie z pętlą pracy z `prompts/_workflow.md`, używając argumentu powyżej.
3. Odpowiadaj po polsku; kod, commity i dokumenty w repo po angielsku (patrz `CLAUDE.md`).
