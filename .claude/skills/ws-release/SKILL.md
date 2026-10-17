---
name: ws-release
description: "Integracja gałęzi workstreamów do main, pełne testy, dokumentacja użytkownika i wydanie milestone'u (na main)"
argument-hint: "[M0 | M1 | M2 | M3 | M4 | status]"
disable-model-invocation: true
---

Argument uruchomienia: `$ARGUMENTS` (pusty = `status`: tylko krok 1, bez scalania).

1. Przeczytaj narzędziem Read, w tej kolejności: `CLAUDE.md`, `prompts/08-integration-release.md`. Pliki w `prompts/` są jedynym
   źródłem prawdy dla tej komendy — nie streszczaj ich z pamięci.
2. Wykonaj prompt `prompts/08-integration-release.md` (ma własny przebieg; nie używaj `prompts/_workflow.md`), używając argumentu powyżej.
3. Odpowiadaj po polsku; kod, commity i dokumenty w repo po angielsku (patrz `CLAUDE.md`).
