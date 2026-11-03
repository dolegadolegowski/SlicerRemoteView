# 04 — Workstream `slicer`: plugin (extension) do 3D Slicera

> Komponent: `slicer` · gałąź `ws/slicer` · plan `docs/plan/slicer.md` · subagent: `slicer-dev` (+ `reviewer`)
> · wymaga: `prompts/00-goal.md` i notatki `docs/research/slicer.md`; protokół z `docs/protocol.md`
> (fixtures z `shared/` jeśli są w `main`).
> Stosuj pętlę pracy z `prompts/_workflow.md` (argument uruchomienia: podany przy komendzie lub na początku wiadomości; brak = domyślny).

## Cel workstreamu

Moduł `RemoteView` w extension `SlicerRemoteView` (`slicer-plugin/`): po kliknięciu „Start session” łączy się
z relay (WSS), pokazuje **duży 5-znakowy kod i QR**, eksportuje widoczne modele/segmentacje jako GLB, wysyła je
do relay i na bieżąco przesyła zmiany (widoczność, kolor, przezroczystość, transformacje). Pokazuje liczbę
podłączonych widzów i pozwala zakończyć sesję.

## Ograniczenie środowiska

W sandboxie **nie ma 3D Slicera**. Dlatego:

- Rdzeń bez zależności od Slicera: `slicer-plugin/RemoteView/remoteview_core/` (czysty Python + `vtk` + numpy):
  writer GLB z `vtkPolyData` (domyślnie własny, wg ADR), decymacja, konwersja układu współrzędnych
  (RAS mm → glTF Y-up m), klient protokołu (koperty, chunkowanie, hash), maszyna stanów sesji —
  **testowane `pytest` z wheelem `vtk`** (zainstaluj w sandboxie: `pip install vtk numpy pytest websocket-client
  pygltflib trimesh` lub to, co ADR wskazuje; `pygltflib`/`trimesh` tylko do weryfikacji wyniku w testach).
- Zależności runtime (np. `websocket-client`, `qrcode`/`segno`, typy z `shared/py`) są **vendorowane** do
  extension skryptem budowania (`slicer-plugin/scripts/vendor.*`) — zainstalowany moduł nie może importować
  z `../shared`, a `pip_install` w Slicerze wymaga dostępu do PyPI, którego w sieci szpitalnej może nie być.
- Cienki adapter Slicera: `RemoteView.py` (UI Qt, dostęp do MRML, obserwatory, `qt.QTimer` do przekazywania
  zdarzeń z wątku sieciowego do głównego wątku Qt). Wszystko, co dotyka `slicer.*`/`qt.*`, trzymaj tutaj.
- Testy wymagające Slicera: `RemoteViewTest` (ScriptedLoadableModuleTest) + kroki manualne w
  `docs/testing/slicer.md` (jak uruchomić u mnie na macOS, co powinienem zobaczyć). Nie udawaj, że je uruchomiłeś.

## Zakres funkcjonalny

- UI (`.ui` z Qt Designer lub kod): pole URL relay (stała domyślna w kodzie, zapamiętywana w `QSettings`),
  przycisk Start/Stop, etykieta kodu czcionką ≥ 48 pt, obraz QR (`https://<host>/j#<kod>` — kod we fragmencie,
  wg protokołu), lista podłączonych widzów, ustawienia: co
  udostępniać (wszystkie widoczne modele / wybrane), poziom decymacji (%), auto-aktualizacja (on/off, debounce ms),
  status połączenia i ostatni błąd.
- Eksport sceny: wg ADR (domyślnie własny writer GLB z węzłów MRML). Segmentacje → zamknięte powierzchnie
  (`vtkMRMLSegmentationNode` → closed surface representation) → siatki; zachowaj nazwy, kolory, przezroczystość;
  każdy węzeł ma stabilny `nodeId` (ID węzła MRML). Orientację i skalę weryfikuj w `pytest` na syntetycznym
  `vtkPolyData` o znanych współrzędnych RAS (np. znacznik w (+100, 0, 0) mm musi wylądować w glTF w (+0.1, 0, 0)
  po konwersji osi), odczytując wynik `pygltflib`/`trimesh`; test na prawdziwych danych (`MRHead` → Segment
  Editor → eksport) opisz jako manualny w `docs/testing/slicer.md`.
- Decymacja: `vtkQuadricDecimation` z celem trójkątów wg ustawienia; raportuj rozmiar przed/po; ostrzeżenie,
  gdy scena przekracza limit protokołu.
- Obserwowanie zmian: eventy MRML (dodanie/usunięcie węzła, `ModifiedEvent` display node, transformacje) z
  debounce; małe zmiany → `scene.update`, zmiana geometrii → nowy snapshot (wersja +1).
- Sieć: klient WebSocket w wątku roboczym (kolejka wysyłania, heartbeat, reconnect z backoffem, wznowienie sesji
  tokenem), nigdy nie blokuj głównego wątku Qt; chunkowanie GLB; limity rozmiaru.
- Pakowanie: `CMakeLists.txt` w katalogu głównym repo (jedyne miejsce metadanych extension, zgodne z wymaganiami
  Slicer Extensions Index; ADR 0010) i `slicer-plugin/CMakeLists.txt` dodający moduł,
  ikona, `README.md` z instalacją „developer mode” (`Edit → Application Settings → Modules → Additional module paths`)
  i instrukcją budowy pakietu.

## Kolejność zadań (sugerowana; plan `SLC-xx` jest źródłem prawdy)

1. Szkielet extension + modułu, `pytest` dla `remoteview_core`, `README.md`.
2. Klient protokołu (koperty, chunkowanie, hash) + testy na fixtures z `shared/`.
3. Eksport GLB z czystego VTK (polydata → GLB) + konwersja układu współrzędnych + testy orientacji/skali.
4. Adapter Slicera: UI, Start/Stop, kod + QR, pierwsze wysłanie snapshotu (test manualny u mnie).
5. Segmentacje, kolory, przezroczystość; decymacja i limity.
6. Obserwatory MRML + debounce → `scene.update`; nowe snapshoty.
7. Reconnect/wznowienie, lista widzów, błędy w UI; self-test modułu; pakowanie.

## Definition of Done tego uruchomienia

- zadania wg argumentu z testami (`pytest` zielone dla rdzenia), kod adaptera przejrzany przez `reviewer`;
- `docs/testing/slicer.md` ma aktualne kroki manualne dla zrobionych zadań;
- plan zaktualizowany, propozycja PR `ws/slicer → main`.
