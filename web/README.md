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

## How it works

The `/api/search` route queries the same torrent index as the desktop app and falls back to Torrents.csv when that index is unavailable or rate limited. It returns paginated results. WebTorrent runs in the visitor's browser, and its service worker serves video data to the HTML video player. A public Sintel sample is available from the home page.

Browser peers use WebRTC, so ordinary BitTorrent seed counts do not guarantee playback. A torrent needs a WebRTC-capable seed or a WebTorrent web seed. The video must also use a codec supported by the visitor's browser. The page offers a magnet link for a desktop torrent client when browser playback is unavailable. The Cloudflare Worker does not download, store, or relay torrent video.

Only search for and stream content you have permission to access.
