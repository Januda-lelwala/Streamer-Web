# Streamer Web

Next.js App Router web version of Streamer, configured for Cloudflare Workers with [vinext](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/).

## Run locally

```bash
cd web
npm install
npm run dev
```

To test the production Worker locally:

```bash
npm run build
npm run start
```

## Deploy to Cloudflare Workers

Authenticate Wrangler with `npx wrangler login`, then run:

```bash
cd web
npm run deploy
```

The Worker name is set in `wrangler.jsonc`. Change it before deployment if needed. For a Cloudflare Git deployment, set the root directory to `web` and use `npm run deploy` as the deploy command.

The GitHub Actions workflow at `../.github/workflows/deploy-worker.yml` deploys every push to `main`. It requires the repository secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. The token needs permission to deploy the Worker and update its secrets. Backend deployment is enabled separately with the settings in the [backend migration guide](../backend/README.md#move-production-to-an-ubuntudebian-x86-64-vps).

## How it works

The `/api/search` route queries the same torrent index as the desktop app and falls back to Torrents.csv when that index is unavailable or rate limited. It returns paginated results. A public Sintel sample is available from the home page.

The Worker proxies metadata and video range requests to the [Node torrent backend](../backend/README.md). The backend connects to ordinary BitTorrent peers and streams video over HTTP. Set `TORRENT_BACKEND_URL` to its HTTPS origin and `TORRENT_BACKEND_TOKEN` to the same long random token configured on the backend. Store both as Worker secrets. The GitHub Actions deploy keeps existing Worker secrets, so future pushes continue to use the backend.

The backend needs reachable BitTorrent peers, and the video must use a codec supported by the visitor's browser. The page offers a magnet link for a desktop torrent client when playback is unavailable.

The player can display subtitles from matching `.srt`, `.vtt`, `.ass`, or `.ssa` files in the torrent, supported embedded text subtitle tracks, or a local `.srt`/`.vtt` file. Choose a track in the Subtitles menu or use **Load SRT/VTT**. Torrent subtitles are converted to WebVTT by the backend with ffmpeg; image-based subtitle tracks are not supported. Local subtitle files stay in the browser and are cleared when the stream is stopped.

The player has 10-second skip buttons, a buffered timeline, fullscreen mode, and a Settings menu for subtitles and playback speed. Click the video to pause or play. When the player has keyboard focus, Space or K toggles playback, Left/Right skips 10 seconds, M mutes, and F toggles fullscreen.

In fullscreen on pointer devices, the translucent controls appear when the pointer reaches the bottom of the screen. They stay visible while the Settings menu is open or a control receives keyboard focus. On touch devices, the controls remain visible.

The browser saves the last selected torrent and video file in local storage with no expiration date. When the visitor returns, **Reopen** reconnects the torrent and opens that file from the beginning. This selection belongs to that browser profile; it does not sync across devices and is removed if the visitor clears the site's data. The backend can still release idle torrent connections to stay within its server limits, then reconnect them when the visitor reopens the file.

Only search for and stream content you have permission to access.
