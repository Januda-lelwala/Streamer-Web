# Streamer (Tauri)

The Next.js web app for Cloudflare Workers lives in [`web/`](web/README.md). The desktop app remains in the repository root.

A desktop application for searching torrents and streaming them in real time
to VLC while they download. This is a **Tauri** rewrite of the original
[Electron app](https://github.com/Januda-lelwala/TorrentStreamer) — the same
UI, with the Node backend (`webtorrent` + `torrent-search-api`) replaced by a
native Rust backend.

## How it works

| Concern        | Electron version            | Tauri version (this repo)        |
| -------------- | --------------------------- | -------------------------------- |
| Shell          | Electron + Chromium         | Tauri (system WebView)           |
| Backend        | Node.js (`main.js`)         | Rust (`src-tauri/`)              |
| Torrent engine | `webtorrent`                | [`librqbit`](https://crates.io/crates/librqbit) |
| Search         | `torrent-search-api`        | Pirate Bay JSON API + `reqwest`  |
| IPC            | `ipcMain` / preload bridge  | Tauri commands + events          |
| Playback       | Launches VLC                | Launches VLC                     |

The frontend (`src/`) is unchanged HTML/CSS/JS. A small shim
(`src/api.js`) re-creates the old `window.api` (`send` / `invoke` / `receive`)
surface on top of Tauri's `invoke` and event APIs, so `renderer.js` did not
need to be rewritten.

## Download

Pre-built installers for every platform are available on the
**[Releases page](https://github.com/Januda-lelwala/Streamer/releases/latest)**.

| Platform | Download | Notes |
| -------- | -------- | ----- |
| **Windows** | `Streamer_x.y.z_x64-setup.exe` or `..._x64_en-US.msi` | App is unsigned — SmartScreen shows "unknown publisher"; click **More info → Run anyway**. |
| **macOS (Apple Silicon)** | `Streamer_x.y.z_aarch64.dmg` | For M1/M2/M3 Macs. |
| **macOS (Intel)** | `Streamer_x.y.z_x64.dmg` | For Intel Macs. |
| **Linux** | `Streamer_x.y.z_amd64.AppImage` | Universal — `chmod +x` then run. |
| **Linux (Debian/Ubuntu)** | `Streamer_x.y.z_amd64.deb` | `sudo apt install ./Streamer_*.deb` |
| **Linux (Fedora/RHEL)** | `Streamer-x.y.z-1.x86_64.rpm` | `sudo dnf install ./Streamer-*.rpm` |

> On macOS the app is unsigned, so the first launch needs **right-click → Open**
> (or *System Settings → Privacy & Security → Open Anyway*).

[VLC](https://www.videolan.org/vlc/) must be installed for playback on every
platform.

### IPC mapping

| Old `window.api` channel    | Tauri command / event            |
| --------------------------- | -------------------------------- |
| `send('search-torrents')`   | command `search_torrents`        |
| `invoke('start-stream')`    | command `start_stream`           |
| `invoke('stop-stream')`     | command `stop_stream`            |
| `invoke('pause-stream')`    | command `pause_stream`           |
| `invoke('resume-stream')`   | command `resume_stream`          |
| `invoke('launch-media-player')` | command `launch_media_player`|
| `receive('download-progress')`  | event `download-progress`    |
| `receive('media-player-ready')` | event `media-player-ready`   |
| `receive('stream-error')` etc.  | events of the same name      |

## Prerequisites

- [Rust](https://www.rust-lang.org/tools/install) (stable)
- [Node.js](https://nodejs.org/) (for the Tauri CLI)
- [VLC](https://www.videolan.org/vlc/) installed (used for playback)
- Platform WebView: bundled on macOS/Windows; on Linux install
  `webkit2gtk` and `libsoup` dev packages.

## Develop

```bash
npm install        # installs @tauri-apps/cli
npm run dev        # launches the app with hot reload
```

## Build

```bash
npm run build      # produces a .app / .dmg (macOS) under src-tauri/target/release/bundle
```

You can also build just the Rust backend:

```bash
cd src-tauri && cargo build
```

## Project layout

```
src/                 Frontend (HTML/CSS/JS) — served as-is by Tauri
  index.html
  styles.css
  api.js             window.api -> Tauri shim
  renderer.js        UI logic (unchanged from the Electron app)
src-tauri/
  Cargo.toml
  tauri.conf.json
  capabilities/      Tauri v2 permission capabilities
  icons/
  src/
    main.rs          entry point
    lib.rs           Tauri setup + command handlers
    search.rs        torrent search (apibay)
    torrent.rs       librqbit-based torrent manager
```

## Notes & caveats

- When a torrent contains a single video file (a typical movie) it streams
  immediately. When it contains several (e.g. a TV-series pack), a picker lets
  you choose which file/episode to stream, and only that file is downloaded.
- Recognized video extensions: `.mp4`, `.mkv`, `.webm`, `.avi`, `.mov`.
- Playback launches the system VLC binary
  (`/Applications/VLC.app/Contents/MacOS/VLC` on macOS, `vlc` on PATH
  elsewhere). Install VLC if it is not found.
- Downloads go to a temporary directory (`<tmp>/torrent-streamer`) and are
  deleted when a stream is stopped.
- The Settings panel is presentational (carried over from the original);
  search/streaming work without it.

## Legality

Only download and stream content you are legally permitted to. This project is
for educational purposes.

## License

MIT
