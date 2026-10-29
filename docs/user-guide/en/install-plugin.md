# Install the RemoteView plugin manually

RemoteView is a plugin (a module) for 3D Slicer. It shows your 3D scene on phones, tablets and Meta Quest
headsets, which join with a 5-character code or a QR code. It is not in Slicer's Extensions Manager,
so you add it by hand.

## What you need

- **3D Slicer 5.12** (any 5.12.x): on [download.slicer.org](https://download.slicer.org) take the
  **Stable Release**, not the Preview Release (RemoteView is not tested with it). Older versions cannot
  install the Python packages RemoteView needs.
  - macOS: on a Mac with an Apple chip (M1 or newer) take **macOS Intel**: there is no stable Apple Silicon
    version. If macOS asks to install Rosetta, agree. Drag `Slicer.app` from the `.dmg` into **Applications**
    and start it from there. Slicer cannot install Python packages while it runs from the `.dmg`.
  - Windows: the installer suggests a folder inside your Windows user folder. If your user name has letters
    outside English (for example ł or é), change the folder to `C:\Slicer`: the path may contain only
    English (ASCII) characters.
- **A free GitHub account** ([github.com/signup](https://github.com/signup)) **with access to the repository**
  [dolegadolegowski/SlicerRemoteView](https://github.com/dolegadolegowski/SlicerRemoteView).
  The repository is private: send the owner your GitHub user name, then accept the invitation in the e-mail
  from GitHub. Until then the link shows a 404 page.
- **A server address** like `wss://<your-server>/ws` (see [Which server to use](#which-server-to-use)).
- Internet access the first time you click **Start session**: Slicer then downloads two Python packages.

## 1. Download the plugin

1. Sign in to GitHub and open the repository page.
2. Above the list of files, click **Code**, then **Download ZIP**. Unzip the file (Windows: right-click it →
   **Extract All**). You get a folder `SlicerRemoteView-main`.
3. Move this folder to a place where it can stay, for example your home folder (macOS: Finder → **Go** →
   **Home**; Windows: `C:\Users\<your name>`). Not Downloads or a temporary folder: Slicer loads the plugin
   from this place at every start.

The plugin is the folder `SlicerRemoteView-main/slicer-plugin/RemoteView`: the folder that contains
`RemoteView.py`. Keep this folder complete.

## 2. Add the module to Slicer

1. Start 3D Slicer.
2. Open **Edit** → **Application Settings** (Ctrl+2, on macOS ⌘+2) and choose **Modules**.
3. Drag the `RemoteView` folder from Finder or File Explorer into the **Additional module paths** list.
   Or click the small **>>** button to the right of that list, click **Add** and select the `RemoteView` folder.
   Use the `RemoteView` folder itself, not the downloaded folder around it.
4. Click **OK**. When Slicer asks to restart, click **Yes**.
   (Leaving **Application Settings** with **Cancel** or its close button undoes the change.)

Alternative without a restart: drag the `RemoteView` folder onto Slicer's main window. If Slicer asks,
choose **Add Python scripted modules to the application** and click **OK**. In the next window keep
**Add selected module to 'Additional module paths'** ticked, untick **Enable developer mode** if it is shown
(it only adds buttons for programmers) and click **Yes**.

## 3. Open RemoteView

Open the module selector on the toolbar and choose **Remote** → **RemoteView**.
Or press Ctrl+F (⌘+F on macOS), type `RemoteView` and press Enter.
The panel shows **Relay address**, **Start session** and the status "Not connected."

## Which server to use

RemoteView has no built-in server: the **Relay address** field is empty at first. Use your own server
(see [Run your own server](own-server.md)) or a server someone runs for you (ask them for its address).

The address looks like `wss://<your-server>/ws`, where `<your-server>` is the server's name, for example
`wss://relay.example.org/ws` (the grey text in the field is only an example). Type it in lower case:
it starts with `wss://` and ends with `/ws`. A `ws://` address works only for a server on the same computer.

## 4. Start a session

1. Type the server address into **Relay address**. The text below it says what will be sent.
2. Click **Start session**.
3. First time only: the window "RemoteView — install Python packages" asks to install websockets 17.2
   and segno 1.6.6. Click **OK** and wait until Slicer's installation window closes. Usually no restart is
   needed; if RemoteView says "Restart Slicer", restart it and click **Start session** again.
4. The panel shows a 5-character code and a QR code.

## 5. Connect a phone or tablet

- Scan the QR code with the camera, or
- open `https://<your-server>/` in Safari or Chrome, type the code and tap **Join**.

The page is in Polish on a phone set to Polish, otherwise in English; the **Polski** / **English** button
switches the language. Codes never contain 0, O, 1, I or L. **Copy link** copies the link that opens the
session, to send it in a message. **Presentation window** shows the code and the QR code in large print,
for a projector. On a Meta Quest headset, open `https://<your-server>/` in the headset's browser and type
the code.

## 6. Stop

Click **Stop session**. Viewers see that the presentation ended. Quitting Slicer also ends the session.

A session also ends when the server restarts, when Slicer loses its connection to the server (it does not
reconnect by itself yet), after 12 hours, and after 30 minutes with no viewer connected (the server's
defaults). Slicer then shows "Session ended." with the reason (for example "The session expired …"):
click **Start session** for a new code.

## What is sent

Nothing leaves the computer before you click **Start session**. Then RemoteView sends to the server the
surfaces of the models and segments shown in the 3D view (clipping is not applied; small islands, that is small
pieces not connected to the rest of a model or segment, are left out while **Remove small islands** is on, as
it is by default; no images or volumes), with their names, IDs, colours, opacity, visibility and positions,
and the Slicer, RemoteView and operating-system versions. Until you click **Stop session** it also sends every change, including models and
segments shown, added or renamed later and any scene you open or load. Hiding, deleting or renaming
something later does not take back what was already sent: the server keeps the last scene for viewers who
join later until the scene is sent again or the session ends. Anyone with the code can watch while the
session runs. The connection is encrypted, but the server itself can read the scene.

## Update or remove

- Update: replace the folder with a newer download at the same place and under the same name
  (or run `git pull` in it), then restart Slicer.
- Remove: in **Modules** (step 2) click the **>>** button, select the line, click **Remove**, **OK**, restart.
- After installing a newer Slicer, check that RemoteView is still in the module list. If not, repeat step 2.

## Troubleshooting

| Problem | What to do |
|---|---|
| RemoteView is not in the module list | The path must be the `RemoteView` folder with `RemoteView.py` in it, not the folder above it. Moved or renamed the folder? Add it again. |
| No **Add** button | Click the small **>>** button to the right of **Additional module paths**, or drag the folder into the list. |
| "Error #1 while writing setting" | Slicer could not save its settings. Quit Slicer, start it normally (Finder or the Dock on macOS; the Start menu on Windows) and add the path again. |
| "Package installation failed." or "The Python packages could not be installed." | See [Python packages](#python-packages) below. |
| "Cannot start the session." with "relay URL must look like `wss://<host>/ws`" or "plain ws:// is allowed only to localhost" | Type the address as `wss://<your-server>/ws`, in lower case, without spaces. |
| "The relay answered HTTP 404 instead of opening the connection." | The address must end with exactly `/ws`. |
| "Relay unreachable — retrying in N s." or "The relay did not answer." | Check the address. Open `https://<your-server>/healthz` in a browser: it should show `"status":"ok"`. |
| "The relay's certificate is not trusted" | Your network may inspect HTTPS traffic. Ask your IT department to exempt the server, or for their root CA certificate (PEM or DER file); select it under **Advanced** → **Additional trusted CA certificate**. |
| No QR code ("No QR code for this relay address …") | The server name is longer than 48 characters, or the address does not end with `/ws`. The code still works: type it at `https://<your-server>/`. |
| Phones show "Connection lost" right after **Join**, while Slicer shows a code | The server's `ALLOWED_ORIGINS` setting is missing or wrong: see [Run your own server](own-server.md#troubleshooting). |
| Phones show "Code not recognised" | The session has ended. Use the code Slicer shows now, or click **Start session**. |
| A small structure that Slicer shows is missing on the phone | It may be a small island: a small piece not connected to the rest of its model or segment. Uncheck **Remove small islands** in the RemoteView panel; the scene is sent again. |

### Python packages

1. Quit Slicer and start it normally: on macOS from **Applications** (Finder or the Dock),
   not from the `.dmg`; on Windows from the Start menu. Click **Start session** again.
2. Still failing? Open **View** → **Python Console** (Ctrl+3, on macOS ⌘+3), paste this line, press Enter
   and wait until the console shows `>>>` again. Then click **Start session** again.

   ```python
   slicer.util.pip_install(["websockets==17.2", "segno==1.6.6"])
   ```

3. The computer cannot reach pypi.org (for example a hospital network)? Ask your IT department to follow
   [Offline installation of the Python packages](../../../slicer-plugin/README.md#offline-installation-of-the-python-packages):
   it needs a second computer with Python. On a Mac with an Apple chip, Slicer 5.12 runs as an Intel app,
   so the platform to choose there is `macosx_10_13_x86_64`.
