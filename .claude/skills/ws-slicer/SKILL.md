---
name: ws-slicer
description: "Workstream slicer: extension SlicerRemoteView / moduł RemoteView dla 3D Slicera (Python, VTK); gałąź ws/slicer, plan docs/plan/slicer.md"
argument-hint: "[liczba zadań | SLC-xx | status | plan]"
disable-model-invocation: true
---

Argument uruchomienia: `$ARGUMENTS` (pusty = domyślny: 3 zadania).

1. Przeczytaj narzędziem Read, w tej kolejności: `CLAUDE.md`, `prompts/_workflow.md`, `prompts/04-slicer-plugin.md`. Pliki w `prompts/` są jedynym
   źródłem prawdy dla tej komendy — nie streszczaj ich z pamięci.
2. Wykonaj prompt `prompts/04-slicer-plugin.md` zgodnie z pętlą pracy z `prompts/_workflow.md`, używając argumentu powyżej.
3. Odpowiadaj po polsku; kod, commity i dokumenty w repo po angielsku (patrz `CLAUDE.md`).
