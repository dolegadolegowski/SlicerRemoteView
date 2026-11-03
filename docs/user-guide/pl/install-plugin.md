# Ręczna instalacja pluginu RemoteView

RemoteView to plugin (moduł) do 3D Slicera. Pokazuje scenę 3D na telefonach, tabletach i goglach Meta Quest,
które dołączają do sesji 5-znakowym kodem albo kodem QR. Nie ma go w menedżerze rozszerzeń Slicera
(**Extensions Manager**), więc trzeba go dodać ręcznie.

Nazwy menu, przycisków i komunikatów Slicera i RemoteView podajemy po angielsku, tak jak widać je w programie.

## Czego potrzebujesz

- **3D Slicer 5.12** (dowolna wersja 5.12.x): na stronie [download.slicer.org](https://download.slicer.org)
  wybierz **Stable Release**, a nie Preview Release (z nią RemoteView nie był testowany). Starsze wersje
  nie potrafią zainstalować pakietów Pythona potrzebnych RemoteView.
  - macOS: na Macu z procesorem Apple (M1 lub nowszym) wybierz **macOS Intel**, bo stabilnej wersji dla
    Apple Silicon nie ma. Jeśli macOS zaproponuje instalację Rosetty, zgódź się. Przeciągnij `Slicer.app`
    z pliku `.dmg` do folderu **Applications** (w polskim macOS: **Aplikacje**) i uruchamiaj Slicera stamtąd.
    Slicer uruchomiony prosto z `.dmg` nie zainstaluje pakietów Pythona.
  - Windows: instalator proponuje folder wewnątrz Twojego folderu użytkownika. Jeśli nazwa użytkownika ma
    litery spoza alfabetu angielskiego (np. ł albo é), zmień folder na `C:\Slicer`: ścieżka może mieć tylko
    angielskie litery (znaki ASCII).
- **Bezpłatne konto na GitHubie** ([github.com/signup](https://github.com/signup)) **z dostępem do repozytorium**
  [dolegadolegowski/SlicerRemoteView](https://github.com/dolegadolegowski/SlicerRemoteView).
  Repozytorium jest prywatne: wyślij właścicielowi swoją nazwę użytkownika GitHuba, a potem przyjmij
  zaproszenie z e-maila od GitHuba. Do tego czasu link pokazuje stronę błędu 404.
- **Adres serwera** w postaci `wss://<your-server>/ws` (zobacz [Który serwer wybrać](#który-serwer-wybrać)).
- Dostęp do internetu przy pierwszym kliknięciu **Start session**: Slicer pobiera wtedy dwa pakiety Pythona.

## 1. Pobierz plugin

1. Zaloguj się do GitHuba i otwórz stronę repozytorium.
2. Po prawej stronie, w części **Releases**, kliknij najnowszą wersję i pobierz plik
   `SlicerRemoteView-<wersja>.zip` (np. `SlicerRemoteView-0.1.0.zip`). Rozpakuj go (Windows: kliknij go prawym
   przyciskiem myszy → **Wyodrębnij wszystko**; może powstać jeszcze jeden folder dookoła). Powstanie folder
   `SlicerRemoteView-<wersja>`.
3. Przenieś ten folder w miejsce, w którym może zostać na stałe, np. do swojego folderu domowego
   (macOS: Finder → **Idź** → **Katalog domowy**; Windows: `C:\Users\<Twoja nazwa>`). Nie zostawiaj go
   w folderze z pobranymi plikami (**Pobrane** w Windows, **Pobrane rzeczy** w macOS) ani w folderze
   tymczasowym: Slicer wczytuje plugin z tego miejsca przy każdym uruchomieniu.

Sam plugin to folder `SlicerRemoteView-<wersja>/RemoteView`, czyli folder z plikiem `RemoteView.py`.
Nie usuwaj z niego żadnych plików.

Nie ma jeszcze żadnego wydania albo chcesz najnowsze zmiany? Nad listą plików kliknij **Code**, a potem
**Download ZIP**: powstanie folder `SlicerRemoteView-main`, a plugin to jego folder `slicer-plugin/RemoteView`.

## 2. Dodaj moduł do Slicera

1. Uruchom 3D Slicera.
2. Otwórz **Edit** → **Application Settings** (Ctrl+2, na macOS ⌘+2) i wybierz **Modules**.
3. Przeciągnij folder `RemoteView` z Findera albo Eksploratora plików na listę **Additional module paths**.
   Możesz też kliknąć mały przycisk **>>** po prawej stronie tej listy, kliknąć **Add** i wybrać folder
   `RemoteView`. Wybierz sam folder `RemoteView`, a nie pobrany folder, w którym się znajduje.
4. Kliknij **OK**. Gdy Slicer zapyta o ponowne uruchomienie, kliknij **Yes**.
   (Wyjście z **Application Settings** przez **Cancel** albo przycisk zamykania okna cofa zmianę.)

Sposób bez ponownego uruchamiania: przeciągnij folder `RemoteView` na główne okno Slicera. Jeśli Slicer zapyta,
wybierz **Add Python scripted modules to the application** i kliknij **OK**. W następnym oknie zostaw
zaznaczone pole **Add selected module to 'Additional module paths'**, odznacz **Enable developer mode**,
jeśli je widać (dodaje tylko przyciski dla programistów), i kliknij **Yes**.

## 3. Otwórz RemoteView

Otwórz listę modułów na pasku narzędzi i wybierz **Remote** → **RemoteView**.
Albo naciśnij Ctrl+F (na macOS ⌘+F), wpisz `RemoteView` i naciśnij Enter.
Panel pokazuje stan „Not connected.”, pole **Relay address** i przycisk **Start session**.

## Który serwer wybrać

RemoteView nie ma wbudowanego serwera: pole **Relay address** jest na początku puste. Użyj własnego serwera
(zobacz [Własny serwer](own-server.md)) albo serwera, który ktoś prowadzi dla Ciebie (zapytaj o jego adres).

Adres wygląda tak: `wss://<your-server>/ws`, gdzie `<your-server>` to nazwa serwera, np. `wss://relay.example.org/ws`
(szary tekst w polu to tylko przykład). Wpisuj go małymi literami: zaczyna się od `wss://` i kończy na `/ws`.
Adres `ws://` działa tylko z serwerem na tym samym komputerze.

## 4. Rozpocznij sesję

1. Wpisz adres serwera w pole **Relay address**. Tekst pod polem mówi, co zostanie wysłane.
2. Kliknij **Start session**.
3. Tylko za pierwszym razem: okno „RemoteView — install Python packages” pyta o zgodę na instalację
   websockets 17.2 i segno 1.6.6. Kliknij **OK** i poczekaj, aż okno instalacji w Slicerze się zamknie.
   Zwykle nie trzeba ponownie uruchamiać Slicera; jeśli RemoteView poprosi o to („Restart Slicer”),
   uruchom go ponownie i kliknij jeszcze raz **Start session**.
4. Panel pokaże 5-znakowy kod i kod QR.

## 5. Podłącz telefon lub tablet

- Zeskanuj kod QR aparatem telefonu albo
- otwórz `https://<your-server>/` w Safari lub Chrome, wpisz kod i stuknij **Dołącz** (po angielsku **Join**).

Strona na telefonie jest po polsku, jeśli telefon ma ustawiony język polski, a w przeciwnym razie po angielsku;
przycisk **English** / **Polski** zmienia język. Kody nigdy nie zawierają 0, O, 1, I ani L. **Copy link** kopiuje
link do sesji, który można wysłać w wiadomości. **Presentation window** pokazuje kod i kod QR dużymi znakami,
np. na projektorze. W goglach Meta Quest otwórz `https://<your-server>/` w przeglądarce gogli i wpisz kod.

## 6. Zakończ

Kliknij **Stop session**. Widzowie zobaczą komunikat „Prezentacja zakończona” („Presentation ended”).
Zamknięcie Slicera też kończy sesję.

Sesja kończy się również, gdy serwer zostanie uruchomiony ponownie, gdy Slicer straci połączenie z serwerem
(na razie nie łączy się ponownie sam), po 12 godzinach oraz po 30 minutach bez żadnego podłączonego widza
(domyślne ustawienia serwera). Slicer pokaże wtedy „Session ended.” z powodem (np. „The session expired …”)
— kliknij **Start session**, aby dostać nowy kod.

## Co jest wysyłane

Nic nie opuszcza komputera, zanim klikniesz **Start session**. Potem RemoteView wysyła na serwer
powierzchnie modeli i segmentów pokazanych w widoku 3D (przycięcie, czyli clipping, nie jest uwzględniane;
małe wyspy, czyli drobne kawałki niepołączone z resztą modelu lub segmentu, są pomijane, gdy włączona jest
opcja **Remove small islands**, a domyślnie jest włączona; bez obrazów i wolumenów, np. skanów TK czy MR)
razem z ich nazwami, identyfikatorami, kolorami, przezroczystością, widocznością i położeniem, a także wersje
Slicera, RemoteView i systemu operacyjnego.
Aż klikniesz **Stop session**, wysyła też każdą zmianę, w tym modele i segmenty pokazane, dodane albo
przemianowane później oraz każdą scenę, którą otworzysz lub wczytasz. Późniejsze ukrycie, usunięcie albo
zmiana nazwy nie cofa tego, co już zostało wysłane: serwer trzyma ostatnią scenę dla widzów, którzy dołączą
później, dopóki scena nie zostanie wysłana ponownie albo sesja się nie skończy. Każdy, kto zna kod, może
oglądać scenę, dopóki trwa sesja. Połączenie jest szyfrowane, ale sam serwer może odczytać scenę.

## Aktualizacja i usuwanie

- Aktualizacja: pobierz nowsze wydanie, rozpakuj je obok starego folderu i w **Modules** (krok 2) zastąp starą
  ścieżkę nowym folderem `RemoteView` (nazwa folderu zawiera numer wersji, więc ścieżka się zmienia), a potem
  uruchom Slicera ponownie. Stary folder możesz usunąć. (Kopię z `git clone` aktualizuje `git pull` i ścieżka
  zostaje.)
- Usunięcie: w **Modules** (krok 2) kliknij przycisk **>>**, zaznacz wiersz, kliknij **Remove**, **OK**
  i uruchom Slicera ponownie.
- Po instalacji nowszej wersji Slicera sprawdź, czy RemoteView nadal jest na liście modułów. Jeśli nie,
  powtórz krok 2.

## Rozwiązywanie problemów

| Problem | Co zrobić |
|---|---|
| Nie ma RemoteView na liście modułów | Ścieżka musi prowadzić do folderu `RemoteView` z plikiem `RemoteView.py`, a nie do folderu nad nim. Folder został przeniesiony albo ma nową nazwę? Dodaj go ponownie. |
| Nie ma przycisku **Add** | Kliknij mały przycisk **>>** po prawej stronie **Additional module paths** albo przeciągnij folder na listę. |
| „Error #1 while writing setting” | Slicer nie mógł zapisać ustawień. Zamknij Slicera, uruchom go w zwykły sposób (na macOS z Findera albo Docka, w Windows z menu Start) i dodaj ścieżkę ponownie. |
| „Package installation failed.” albo „The Python packages could not be installed.” | Zobacz niżej [Pakiety Pythona](#pakiety-pythona). |
| „Cannot start the session.” z tekstem „relay URL must look like `wss://<host>/ws`” albo „plain ws:// is allowed only to localhost” | Wpisz adres jako `wss://<your-server>/ws`, małymi literami, bez spacji. |
| „The relay answered HTTP 404 instead of opening the connection.” | Adres musi się kończyć dokładnie na `/ws`. |
| „Relay unreachable — retrying in N s.” albo „The relay did not answer.” | Sprawdź adres. Otwórz w przeglądarce `https://<your-server>/healthz`: powinno być widać `"status":"ok"`. |
| „The relay's certificate is not trusted” | Twoja sieć może kontrolować ruch HTTPS. Poproś dział IT o wyjątek dla serwera albo o ich certyfikat główny CA (plik PEM lub DER) i wskaż go w **Advanced** → **Additional trusted CA certificate**. |
| Brak kodu QR („No QR code for this relay address …”) | Nazwa serwera ma ponad 48 znaków albo adres nie kończy się na `/ws`. Kod nadal działa: wpisz go na `https://<your-server>/`. |
| Telefony pokazują „Utracono połączenie” („Connection lost”) zaraz po **Dołącz** (**Join**), choć Slicer pokazuje kod | Na serwerze brakuje ustawienia `ALLOWED_ORIGINS` albo jest ono błędne: zobacz [Własny serwer](own-server.md#rozwiązywanie-problemów). |
| Telefony pokazują „Nie rozpoznano kodu” („Code not recognised”) | Sesja już się skończyła. Użyj kodu, który Slicer pokazuje teraz, albo kliknij **Start session**. |
| Na telefonie brakuje małej struktury, którą Slicer pokazuje | To może być mała wyspa: drobny kawałek niepołączony z resztą swojego modelu lub segmentu. Odznacz **Remove small islands** w panelu RemoteView; scena zostanie wysłana ponownie. |

### Pakiety Pythona

1. Zamknij Slicera i uruchom go w zwykły sposób: na macOS z folderu **Applications** (**Aplikacje**), np. z Findera
   albo Docka, a nie z pliku `.dmg`; w Windows z menu Start. Kliknij ponownie **Start session**.
2. Nadal nie działa? Otwórz **View** → **Python Console** (Ctrl+3, na macOS ⌘+3), wklej tę linię, naciśnij Enter
   i poczekaj, aż w konsoli znów pojawi się `>>>`. Potem kliknij ponownie **Start session**.

   ```python
   slicer.util.pip_install(["websockets==17.2", "segno==1.6.6"])
   ```

3. Komputer nie ma dostępu do pypi.org (np. w sieci szpitalnej)? Poproś dział IT o wykonanie instrukcji
   (po angielsku) [Offline installation of the Python packages](../../../slicer-plugin/README.md#offline-installation-of-the-python-packages).
   Potrzebny jest drugi komputer z Pythonem. Na Macu z procesorem Apple Slicer 5.12 działa jako aplikacja
   dla procesorów Intel, więc trzeba tam wybrać platformę `macosx_10_13_x86_64`.
