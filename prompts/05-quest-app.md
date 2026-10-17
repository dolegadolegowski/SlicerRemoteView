# 05 — Workstream `quest`: natywna aplikacja Meta Quest

> Komponent: `quest` · gałąź `ws/quest` · plan `docs/plan/quest.md` · subagent: `quest-dev` (+ `reviewer`)
> · wymaga: `prompts/00-goal.md`, `docs/research/quest.md` i ADR o silniku; protokół z `docs/protocol.md`
> (rekordy C# i fixtures z `shared/`, jeśli są w `main`). Jeśli ADR przewiduje etap WebXR, ten workstream
> zaczyna się w M3 — wcześniej uruchamiaj go tylko z argumentem `plan` lub dla zadań szkieletowych.
> Stosuj pętlę pracy z `prompts/_workflow.md` (argument uruchomienia: podany przy komendzie lub na początku wiadomości; brak = domyślny).

## Cel workstreamu

Aplikacja na Meta Quest (2/3/3S) w `quest-app/`: użytkownik wpisuje 5‑znakowy kod (lub wybiera ostatnią
sesję), aplikacja łączy się z relay, pobiera scenę (GLB) i wyświetla ją w przestrzeni przed użytkownikiem;
model można chwytać, obracać, skalować i przesuwać rękami lub kontrolerami; elementy można włączać/wyłączać
z panelu; scena aktualizuje się na żywo. Tryb passthrough (MR) jako opcja.

## Ograniczenie środowiska

W sandboxie **nie ma Unity ani Androida**. Dlatego:

- Logika protokołu w osobnym assembly bez zależności od `UnityEngine` (`Assets/RemoteView/Protocol/` + `.asmdef`):
  koperty, składanie chunków, hash, maszyna stanów sesji, model sceny — testy **EditMode** (Unity Test Framework)
  oraz, jeśli w sandboxie jest `dotnet`, równoległy projekt testowy `quest-app/Tests.NET/` używający tych
  samych plików źródłowych (link w `.csproj`), żeby testy dało się uruchomić tutaj. Jeśli `dotnet` nie ma —
  napisz testy EditMode i dokładne kroki uruchomienia w Unity.
- Warstwa Unity (`Assets/RemoteView/Runtime/`): `RelayClient` (WebSocket — biblioteka wg ADR, np.
  NativeWebSocket), `SceneSync` (snapshot/aktualizacje → GameObjects), `GlbLoader` (glTFast, runtime),
  `CodeEntryUI` (world‑space UI, klawiatura numeryczno‑literowa pod kontrolery/ręce), `ModelInteraction`
  (grab/rotate/scale — XR Interaction Toolkit lub Meta Interaction SDK wg ADR), `PassthroughToggle`,
  `Settings` (URL relay, zapamiętany ostatni kod), `DiagnosticsOverlay` (stan, wersja sceny, fps).
- Projekt Unity musi dać się otworzyć bez ręcznych poprawek: `Packages/manifest.json` z wersjami **zweryfikowanymi**
  w `docs/research/quest.md` (OpenXR, Meta XR SDK, glTFast, XR Interaction Toolkit, TextMeshPro), `ProjectSettings`
  z OpenXR + Meta Quest feature group, Android (IL2CPP, ARM64, min API wg Meta), scena startowa, prefaby.
  Każde założenie o pakiecie, którego nie da się sprawdzić, oznacz `[TODO verify]`.
- Build i testy na goglach wykonuję ja: w `docs/testing/quest.md` opisz krok po kroku (Unity Hub → otwarcie
  projektu → Switch Platform → Build → `adb install` / Meta Quest Developer Hub → co powinienem zobaczyć).

## Wymagania UX w VR/MR

- Kod wpisywany bez zdejmowania gogli: duże przyciski, podgląd kodu, błąd czytelny; opcja „ostatnia sesja”.
- Model pojawia się ~1 m przed użytkownikiem, dopasowany do ~0,5 m; gest/przycisk „reset”; skalowanie
  z zachowaniem proporcji; informacja o rozmiarze sceny i ostrzeżenie, gdy przekracza limit.
- Panel elementów przypięty do dłoni/kontrolera lub świata (przełączalny); widoczność/przezroczystość.
- Passthrough on/off; komfort (brak gwałtownego ruchu kamery; model porusza się, nie użytkownik).
- Stan połączenia zawsze widoczny; auto‑reconnect.

## Kolejność zadań (sugerowana; plan `QST-xx` jest źródłem prawdy)

1. Szkielet projektu Unity (manifest, settings, scena, asmdef), `README.md`, test EditMode „smoke”.
2. Protokół w C# + testy na fixtures z `shared/`.
3. `RelayClient` + `CodeEntryUI` (test manualny: połączenie z fake‑slicer, kod OK/zły).
4. `GlbLoader` + `SceneSync` (snapshot → obiekty; aktualizacje bez przeładowania).
5. `ModelInteraction` (grab/rotate/scale), reset, panel elementów.
6. Passthrough, ustawienia, diagnostyka, reconnect/late join.
7. Optymalizacja (limity trójkątów, materiały), build release, instrukcja instalacji.

## Definition of Done tego uruchomienia

- zadania wg argumentu wykonane; testy protokołu zielone (tu lub opisane do uruchomienia w Unity);
- `docs/testing/quest.md` aktualne; `quest-app/README.md` opisuje wersje i kroki buildu;
- plan zaktualizowany, propozycja PR `ws/quest → main`.
