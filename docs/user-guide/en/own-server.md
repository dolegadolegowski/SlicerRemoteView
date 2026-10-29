# Run your own server

The server (the *relay*) passes the scene from 3D Slicer to the phones, tablets and headsets of a session.
It also serves the web page they open, so the devices need no app. Sessions live only in its memory.
It must be reachable from the internet over **HTTPS**. Without HTTPS, phones show "Connection refused" and
Slicer rejects the address, unless the server runs on the same computer.

You need a free GitHub account ([github.com/signup](https://github.com/signup)) with access to the repository
[dolegadolegowski/SlicerRemoteView](https://github.com/dolegadolegowski/SlicerRemoteView).
The repository is private: send the owner your GitHub user name, then accept the invitation in the e-mail
from GitHub. Until then the link shows a 404 page.

## Option A (recommended): Railway, from GitHub

[Railway](https://railway.com) builds the server from the repository and gives it an HTTPS address.
Railway bills by usage: compare its [plans](https://docs.railway.com/pricing/plans) first.

### 1. Create the service

1. Open [railway.com](https://railway.com) and click **Login** to create an account. A new account starts
   with a free trial (30 days or $5).
2. Not the owner? Make a fork: your own copy of the repository on GitHub (Railway can build only a repository
   in your own account). Open the repository page, click **Fork** (top right), choose your account under
   **Owner** and click **Create fork**. This works only if the owner allows forks. A fork does not update
   itself (see **Sync fork** under [Good to know](#good-to-know)).
3. In the Railway dashboard click **New Project** and choose the **GitHub repo** option (link your GitHub
   account if Railway asks). Click your repository, then **Deploy Now**.
4. The first build will probably fail with "No start command …". Whatever happens, continue with
   [2. Fix the build](#2-fix-the-build). You need one service only: if Railway created several, keep the one
   with `relay-server` in its name and delete the others (project **Settings** → **Danger**).

Repository not in the list? On GitHub, click your profile picture → **Settings** → **Applications** →
**Installed GitHub Apps** → **Configure** next to Railway. Under **Repository access**, select the
repository and click **Save**.

### 2. Fix the build

Click the service on the project canvas, open its **Settings** tab and set:

| Setting | Value | Why |
|---|---|---|
| Builder (section **Build**) | **Dockerfile** | the server is built from a Dockerfile |
| **Dockerfile Path** | `/relay-server/Dockerfile` | the Dockerfile is not at the top of the repository |
| **Root Directory** | empty or `/` | the build needs the whole repository |
| **Custom Build Command** (section **Build**) | empty | the Dockerfile builds everything |
| **Custom Start Command** (section **Deploy**) | empty | the image starts the server itself |
| **Healthcheck Path** (section **Deploy**) | `/healthz` | recommended: a broken update does not replace a working server |
| **Serverless** (section **Deploy**, formerly App Sleeping) | off | a sleeping server loses its sessions |
| **Regions** (section **Scale**) | one region that your rules for patient data allow (for example in the EU), 1 replica (the default) | the scene passes through this region; sessions live in the memory of one server |
| **Watch Paths** | empty, or the list under [Good to know](#good-to-know) | a shorter list misses changes the server needs |

No builder setting? Add the variable `RAILWAY_DOCKERFILE_PATH` with the value `/relay-server/Dockerfile`
instead (step 3 shows how to add a variable).

Click **Deploy** in the banner at the top of the canvas. Then open the service's **Deployments** tab, click
the newest deployment and wait until its log shows `relay listening`.

### 3. Add a domain and two variables

1. In **Settings** → **Networking** → **Public Networking**, click **Generate Domain**. You get an HTTPS
   address like `<name>.up.railway.app`: this is `<your-domain>` (`<your-server>` in the plugin guide).
   With more than 48 characters, Slicer cannot show a QR code (the code still works). If Railway asks for a
   port (it normally detects it), use the `port` attribute of the log line `relay listening`.
2. Open the **Variables** tab, click **New Variable** and add these two. Do not add `PORT`: Railway sets it.

   | Variable | Value |
   |---|---|
   | `ALLOWED_ORIGINS` | `https://<your-domain>`, exactly (no `/ws`, nothing after the domain) |
   | `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `30` |

3. Click **Deploy** in the banner at the top of the canvas.

`ALLOWED_ORIGINS` must match the address phones open. Otherwise they show "Connection lost".

### 4. Test

1. Open `https://<your-domain>/healthz`. It should show `{"status":"ok", …}`.
2. Open `https://<your-domain>/` on a phone. It should show **Join a session** (**Dołącz do sesji** on a
   phone set to Polish).
3. In Slicer's RemoteView panel, type `wss://<your-domain>/ws` into **Relay address** and click
   **Start session** (see [Install the plugin](install-plugin.md)).

### Good to know

- **The server restarts after every change of the deployed branch on GitHub (changes the owner publishes,
  or Sync fork in a fork) and after every variable change.** Running sessions end, and the presenter must
  click **Start session** again. Change things when no session is running. (Update a fork on its GitHub
  page: **Sync fork** → **Update branch**.)
- Optional: to restart only when server files change, set **Watch Paths** to exactly these eleven lines, in
  this order. A line starting with `!` leaves out what an earlier line takes in: here the server's tests, its
  test scripts and its README file, which do not change the server. A folder needs two such lines, one for
  the folder itself (ending in `/`) and one for what is in it (ending in `/**`).

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
- Renamed the domain, or added your own domain in **Networking** (use a subdomain such as
  `relay.example.org`)? Put every domain into `ALLOWED_ORIGINS`, separated by commas
  (`https://<domain-1>,https://<domain-2>`), click **Deploy**, and use the new address in Slicer.

## Option B (for IT staff): your own computer with Docker

You need a computer that is always on and reachable from the internet, a subdomain such as
`relay.example.org` whose DNS record points to it, ports 80 and 443 open to it,
[Docker](https://docs.docker.com/get-started/get-docker/) and [Caddy](https://caddyserver.com/docs/install)
(Caddy gets the HTTPS certificate by itself). This follows the Docker and Caddy documentation;
the project has not tested it.

1. Put the repository on the computer (**Download ZIP** or `git clone`). In its folder, build the image
   (note the dot at the end): `docker build -f relay-server/Dockerfile -t slicerremoteview-relay .`
   Warnings from npm during the build are normal; an error stops the build with a line that starts with
   `ERROR`.
2. Start the server, reachable only from this computer (Caddy forwards to it):

   ```
   docker run -d --restart unless-stopped --name relay -p 127.0.0.1:8787:8787 -e TRUST_PROXY=true -e ALLOWED_ORIGINS=https://<your-domain> slicerremoteview-relay
   ```

   `TRUST_PROXY=true` is right here because Caddy is the only way in and replaces the client's
   `X-Forwarded-For`; without a proxy in front, as in the quick test, use `false`.
3. Replace the contents of Caddy's configuration file (`/etc/caddy/Caddyfile` when Caddy runs as a system
   service) with this, then run `sudo systemctl reload caddy`:

   ```
   <your-domain> {
       reverse_proxy 127.0.0.1:8787
   }
   ```

4. Open `https://<your-domain>/healthz`, then use `wss://<your-domain>/ws` in Slicer.

Keep port 8787 closed to the outside. Restarting the container or reloading Caddy ends running sessions.
To update the server: get the new version of the repository (`git pull`, or **Download ZIP** again), repeat
step 1, run `docker rm -f relay`, then repeat step 2. This also ends running sessions.

**Quick test on one computer** (you need only Docker, and it must be running: on macOS and Windows open
Docker Desktop first; no HTTPS, so only this computer can join): build the image as in step 1, then run
`docker run --rm -p 127.0.0.1:8787:8787 -e TRUST_PROXY=false -e ALLOWED_ORIGINS=http://127.0.0.1:8787,http://localhost:8787 slicerremoteview-relay`,
use `ws://127.0.0.1:8787/ws` in Slicer and open `http://127.0.0.1:8787/` in a browser. It runs until you
press Ctrl+C in that terminal window.

## Troubleshooting

| Problem | What to do |
|---|---|
| Railway build fails: "No start command detected" or "No start command could be found" | Do step 2: Dockerfile builder, **Dockerfile Path** `/relay-server/Dockerfile`, **Root Directory** empty or `/`. Then **Deploy**. |
| `https://<your-domain>/` shows "SlicerRemoteView relay" and "Placeholder for development" | The server was not built from the Dockerfile: do step 2. |
| Phones show "Connection lost" right after **Join**, while Slicer shows a code | `ALLOWED_ORIGINS` is missing or names another domain. Set it to exactly `https://<your-domain>` and click **Deploy**. |
| The deploy fails and its log names `ALLOWED_ORIGINS` | The value is not a plain `https://<your-domain>` (no `/ws`, no `*`, no `http://`). Fix it and click **Deploy**. |
| Railway shows "Application failed to respond" | Remove a `PORT` variable if you added one. The domain's port must be the `port` attribute of the log line `relay listening`. |
| Slicer cannot connect ("relay URL must look like `wss://<host>/ws`", "HTTP 404", "Relay unreachable") | Use exactly `wss://<your-domain>/ws`: lower case, ending with `/ws`. `https://<your-domain>/healthz` must show `"status":"ok"`. |
| Phones say "Code not recognised" for the code Slicer shows | The service must run exactly 1 replica (step 2). |
| Sessions end by themselves | An update on GitHub, a variable change or **Sync fork** restarted the server, or Slicer lost its connection to the server. **Serverless** must be off (the change applies from the next deploy). A session with no viewer ends after 30 minutes, any session after 12 hours. |
| `https://<your-domain>/ws` in a browser shows `{"error":"NOT_FOUND"}` | That is normal: this address is for Slicer and the viewer, not for opening in a browser. |
