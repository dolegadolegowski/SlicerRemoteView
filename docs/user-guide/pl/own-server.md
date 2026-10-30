# Własny serwer

Serwer (*relay*, czyli serwer pośredniczący) przekazuje scenę z 3D Slicera do telefonów, tabletów i gogli
uczestniczących w sesji. Udostępnia też stronę, którą te urządzenia otwierają, więc nie potrzebują żadnej
aplikacji. Sesje są trzymane tylko w jego pamięci. Serwer musi być dostępny z internetu przez **HTTPS**.
Bez HTTPS telefony pokażą „Połączenie odrzucone” („Connection refused”), a Slicer odrzuci adres, chyba że
serwer działa na tym samym komputerze.

Potrzebujesz bezpłatnego konta na GitHubie ([github.com/signup](https://github.com/signup)) z dostępem
do repozytorium [dolegadolegowski/SlicerRemoteView](https://github.com/dolegadolegowski/SlicerRemoteView).
Repozytorium jest prywatne: wyślij właścicielowi swoją nazwę użytkownika GitHuba, a potem przyjmij
zaproszenie z e-maila od GitHuba. Do tego czasu link pokazuje stronę błędu 404.

Nazwy przycisków i ustawień Railway oraz GitHuba podajemy po angielsku, tak jak widać je na tych stronach.

## Wariant A (zalecany): Railway, prosto z GitHuba

[Railway](https://railway.com) buduje serwer z repozytorium i daje mu adres HTTPS.
Railway nalicza opłaty według zużycia: najpierw porównaj jego [plany](https://docs.railway.com/pricing/plans).

### 1. Utwórz usługę

1. Otwórz [railway.com](https://railway.com) i kliknij **Login**, aby założyć konto. Nowe konto zaczyna
   od bezpłatnego okresu próbnego (30 dni albo 5 $).
2. Nie jesteś właścicielem repozytorium? Zrób fork, czyli własną kopię repozytorium na GitHubie (Railway
   zbuduje tylko repozytorium z Twojego konta). Otwórz stronę repozytorium, kliknij **Fork** (w prawym górnym
   rogu), wybierz swoje konto w polu **Owner** i kliknij **Create fork**. Działa to tylko wtedy, gdy właściciel
   pozwala na forki. Fork sam się nie aktualizuje (zobacz **Sync fork** w części [Dobrze wiedzieć](#dobrze-wiedzieć)).
3. W panelu Railway kliknij **New Project** i wybierz opcję **GitHub repo** (jeśli Railway poprosi, połącz
   konto GitHub). Kliknij swoje repozytorium, a potem **Deploy Now**.
4. Pierwsze budowanie prawdopodobnie skończy się błędem „No start command …”. Niezależnie od wyniku przejdź
   do części [2. Popraw budowanie](#2-popraw-budowanie). Potrzebujesz tylko jednej usługi (service): jeśli
   Railway utworzył kilka, zostaw tę z `relay-server` w nazwie, a pozostałe usuń (**Settings** projektu →
   **Danger**).

Nie widzisz repozytorium na liście? Na GitHubie kliknij swoje zdjęcie profilowe → **Settings** → **Applications** →
**Installed GitHub Apps** → **Configure** obok Railway. W sekcji **Repository access** wybierz repozytorium
i kliknij **Save**.

### 2. Popraw budowanie

Kliknij usługę w widoku projektu (canvas), otwórz jej kartę **Settings** i ustaw:

| Ustawienie | Wartość | Dlaczego |
|---|---|---|
| Builder (sekcja **Build**) | **Dockerfile** | serwer jest budowany z pliku Dockerfile |
| **Dockerfile Path** | `/relay-server/Dockerfile` | Dockerfile nie leży w głównym folderze repozytorium |
| **Root Directory** | puste albo `/` | do budowania potrzebne jest całe repozytorium |
| **Custom Build Command** (sekcja **Build**) | puste | Dockerfile sam wszystko buduje |
| **Custom Start Command** (sekcja **Deploy**) | puste | obraz sam uruchamia serwer |
| **Healthcheck Path** (sekcja **Deploy**) | `/healthz` | zalecane: wadliwa aktualizacja nie zastąpi działającego serwera |
| **Serverless** (sekcja **Deploy**, dawniej App Sleeping) | wyłączone | uśpiony serwer traci swoje sesje |
| **Regions** (sekcja **Scale**) | jeden region, na który pozwalają Twoje zasady ochrony danych pacjentów (np. w UE), 1 replika (domyślnie) | scena przechodzi przez ten region; sesje są w pamięci jednego serwera |
| **Watch Paths** | puste albo lista z części [Dobrze wiedzieć](#dobrze-wiedzieć) | krótsza lista pominie zmiany potrzebne serwerowi |

Nie ma ustawienia Builder? Dodaj zamiast tego zmienną `RAILWAY_DOCKERFILE_PATH` o wartości
`/relay-server/Dockerfile` (jak dodać zmienną, pokazuje krok 3).

Kliknij **Deploy** na pasku u góry widoku projektu. Potem otwórz kartę **Deployments** usługi, kliknij
najnowsze wdrożenie i poczekaj, aż w jego logu pojawi się `relay listening`.

### 3. Dodaj domenę i dwie zmienne

1. W **Settings** → **Networking** → **Public Networking** kliknij **Generate Domain**. Dostaniesz adres HTTPS
   w rodzaju `<name>.up.railway.app` — to jest `<your-domain>`, czyli Twoja domena (w instrukcji instalacji:
   `<your-server>`). Jeśli ma ponad 48 znaków, Slicer nie pokaże kodu QR (sam kod będzie działał). Jeśli
   Railway zapyta o port (zwykle wykrywa go sam), podaj wartość atrybutu `port` linii logu `relay listening`.
2. Otwórz kartę **Variables**, kliknij **New Variable** i dodaj te dwie zmienne. Nie dodawaj `PORT`: Railway
   ustawia tę zmienną sam.

   | Zmienna | Wartość |
   |---|---|
   | `ALLOWED_ORIGINS` | dokładnie `https://<your-domain>` (bez `/ws` i bez niczego po domenie) |
   | `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `30` |

3. Kliknij **Deploy** na pasku u góry widoku projektu.

`ALLOWED_ORIGINS` musi się zgadzać z adresem, który otwierają telefony. Inaczej pokażą „Utracono połączenie”
(„Connection lost”).

### 4. Sprawdź

1. Otwórz `https://<your-domain>/healthz`. Powinno się pokazać `{"status":"ok", …}`.
2. Otwórz `https://<your-domain>/` na telefonie. Powinna się pokazać strona **Dołącz do sesji** (**Join a session**).
3. W panelu RemoteView w Slicerze wpisz `wss://<your-domain>/ws` w pole **Relay address** i kliknij
   **Start session** (zobacz [Instalacja pluginu](install-plugin.md)).

### Dobrze wiedzieć

- **Serwer uruchamia się ponownie po każdej zmianie we wdrażanej gałęzi na GitHubie (zmiany opublikowane
  przez właściciela albo Sync fork w forku) i po każdej zmianie zmiennej.** Trwające sesje się kończą
  i w Slicerze trzeba znowu kliknąć **Start session**. Wprowadzaj zmiany wtedy, gdy nie trwa żadna sesja.
  (Fork aktualizujesz na jego stronie w GitHubie: **Sync fork** → **Update branch**.)
- Opcjonalnie: aby serwer uruchamiał się ponownie tylko po zmianach w jego plikach, wpisz w **Watch Paths**
  dokładnie te jedenaście linii, w tej kolejności. Linia zaczynająca się od `!` pomija to, co obejmuje
  wcześniejsza linia: tutaj testy serwera, jego skrypty testowe i plik README, które nie zmieniają działania
  serwera. Folder wymaga dwóch takich linii: jednej dla samego folderu (zakończonej `/`) i jednej dla jego
  zawartości (zakończonej `/**`).

  ```
  /relay-server/**
  !/relay-server/test/
  !/relay-server/test/**
  !/relay-server/scripts/
  !/relay-server/scripts/**
  !/relay-server/README.md
  /shared/**
  /web-viewer/**
  /package*.json
  /tools/fake-slicer/package.json
  /.dockerignore
  ```
- Jeśli zmienisz nazwę domeny albo dodasz własną domenę w **Networking** (użyj subdomeny, np.
  `relay.example.org`), wpisz wszystkie domeny w `ALLOWED_ORIGINS`, oddzielone przecinkami
  (`https://<domain-1>,https://<domain-2>`), kliknij **Deploy** i używaj nowego adresu w Slicerze.

## Wariant B (dla informatyków): własny komputer z Dockerem

Potrzebujesz: komputera, który jest stale włączony i dostępny z internetu; subdomeny, np. `relay.example.org`,
której rekord DNS wskazuje na ten komputer; otwartych do niego portów 80 i 443;
[Dockera](https://docs.docker.com/get-started/get-docker/) i [Caddy](https://caddyserver.com/docs/install)
(Caddy sam uzyskuje certyfikat HTTPS). Ten opis powstał na podstawie dokumentacji Dockera i Caddy;
projekt go nie przetestował.

1. Skopiuj repozytorium na ten komputer (**Download ZIP** albo `git clone`). W jego folderze zbuduj obraz
   (zwróć uwagę na kropkę na końcu): `docker build -f relay-server/Dockerfile -t slicerremoteview-relay .`
   Ostrzeżenia npm podczas budowania są normalne; błąd przerywa budowanie i pojawia się wtedy linia
   zaczynająca się od `ERROR`.
2. Uruchom serwer tak, aby był dostępny tylko z tego komputera (Caddy przekazuje do niego ruch):

   ```
   docker run -d --restart unless-stopped --name relay -p 127.0.0.1:8787:8787 -e TRUST_PROXY=true -e ALLOWED_ORIGINS=https://<your-domain> slicerremoteview-relay
   ```

   `TRUST_PROXY=true` jest tu właściwe, bo Caddy jest jedyną drogą do serwera i zastępuje nagłówek
   `X-Forwarded-For` klienta; bez proxy, jak w szybkim teście, użyj `false`.
3. Zastąp zawartość pliku konfiguracyjnego Caddy (`/etc/caddy/Caddyfile`, gdy Caddy działa jako usługa
   systemowa) tym tekstem, a potem uruchom `sudo systemctl reload caddy`:

   ```
   <your-domain> {
       reverse_proxy 127.0.0.1:8787
   }
   ```

4. Otwórz `https://<your-domain>/healthz`, a potem w Slicerze użyj adresu `wss://<your-domain>/ws`.

Port 8787 ma być zamknięty od zewnątrz. Ponowne uruchomienie kontenera albo przeładowanie Caddy kończy
trwające sesje. Aby zaktualizować serwer: pobierz nową wersję repozytorium (`git pull` albo ponownie
**Download ZIP**), powtórz krok 1, uruchom `docker rm -f relay`, a potem powtórz krok 2. To również kończy
trwające sesje.

**Szybki test na jednym komputerze** (potrzebny jest tylko Docker i musi być uruchomiony: na macOS i w Windows
najpierw otwórz Docker Desktop; bez HTTPS, więc dołączyć może tylko ten komputer): zbuduj obraz jak w kroku 1,
a potem uruchom
`docker run --rm -p 127.0.0.1:8787:8787 -e TRUST_PROXY=false -e ALLOWED_ORIGINS=http://127.0.0.1:8787,http://localhost:8787 slicerremoteview-relay`,
w Slicerze użyj `ws://127.0.0.1:8787/ws`, a w przeglądarce otwórz `http://127.0.0.1:8787/`. Serwer działa,
dopóki nie naciśniesz Ctrl+C w tym oknie terminala.

## Rozwiązywanie problemów

| Problem | Co zrobić |
|---|---|
| Budowanie na Railway kończy się błędem „No start command detected” albo „No start command could be found” | Wykonaj krok 2: builder Dockerfile, **Dockerfile Path** `/relay-server/Dockerfile`, **Root Directory** puste albo `/`. Potem **Deploy**. |
| `https://<your-domain>/` pokazuje „SlicerRemoteView relay” i „Placeholder for development” | Serwer nie został zbudowany z pliku Dockerfile: wykonaj krok 2. |
| Telefony pokazują „Utracono połączenie” („Connection lost”) zaraz po **Dołącz** (**Join**), choć Slicer pokazuje kod | Brakuje `ALLOWED_ORIGINS` albo jest tam inna domena. Ustaw dokładnie `https://<your-domain>` i kliknij **Deploy**. |
| Wdrożenie kończy się błędem, a log wymienia `ALLOWED_ORIGINS` | Wartość nie jest zwykłym `https://<your-domain>` (bez `/ws`, bez `*`, bez `http://`). Popraw ją i kliknij **Deploy**. |
| Railway pokazuje „Application failed to respond” | Usuń zmienną `PORT`, jeśli została dodana. Port domeny musi być równy wartości `port` z linii logu `relay listening`. |
| Slicer nie może się połączyć („relay URL must look like `wss://<host>/ws`”, „HTTP 404”, „Relay unreachable”) | Użyj dokładnie `wss://<your-domain>/ws`: małymi literami, z `/ws` na końcu. `https://<your-domain>/healthz` musi pokazywać `"status":"ok"`. |
| Telefony pokazują „Nie rozpoznano kodu” („Code not recognised”) dla kodu, który pokazuje Slicer | Usługa musi działać w dokładnie 1 replice (krok 2). |
| Sesje kończą się same | Serwer został uruchomiony ponownie przez aktualizację na GitHubie, zmianę zmiennej albo **Sync fork**, albo Slicer stracił połączenie z serwerem. **Serverless** musi być wyłączone (zmiana działa od następnego wdrożenia). Sesja bez widzów kończy się po 30 minutach, każda sesja po 12 godzinach. |
| `https://<your-domain>/ws` w przeglądarce pokazuje `{"error":"NOT_FOUND"}` | To normalne: ten adres jest dla Slicera i strony podglądu, a nie do otwierania w przeglądarce. |
