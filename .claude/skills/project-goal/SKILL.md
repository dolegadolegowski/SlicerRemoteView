---
name: project-goal
description: "Cel projektu SlicerRemoteView: wymagania, architektura, protokół v1, ADR-y i plany per komponent. Uruchamiać ręcznie, raz na początku (na main): /project-goal"
argument-hint: "[opcjonalnie: 'replan' albo uwagi do planu]"
disable-model-invocation: true
---

Argument uruchomienia: `$ARGUMENTS`.

1. Przeczytaj narzędziem Read, w tej kolejności: `CLAUDE.md`, `prompts/00-goal.md`. Pliki w `prompts/` są jedynym
   źródłem prawdy dla tej komendy — nie streszczaj ich z pamięci.
2. Wykonaj prompt `prompts/00-goal.md`, używając argumentu powyżej.
3. Odpowiadaj po polsku; kod, commity i dokumenty w repo po angielsku (patrz `CLAUDE.md`).
