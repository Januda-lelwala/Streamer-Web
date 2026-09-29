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

The GitHub Actions workflow at `../.github/workflows/deploy-worker.yml` deploys every push to `main`. It requires the repository secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. The token needs permission to deploy the Worker.

## How it works

The `/api/search` route queries the same torrent index as the desktop app and falls back to Torrents.csv when that index is unavailable or rate limited. It returns paginated results. A public Sintel sample is available from the home page.

The Worker proxies metadata and video range requests to the [Node torrent backend](../backend/README.md). The backend connects to ordinary BitTorrent peers and streams video over HTTP. Set `TORRENT_BACKEND_URL` to its HTTPS origin and `TORRENT_BACKEND_TOKEN` to the same long random token configured on the backend. Store both as Worker secrets. The GitHub Actions deploy keeps existing Worker secrets, so future pushes continue to use the backend.

The backend needs reachable BitTorrent peers, and the video must use a codec supported by the visitor's browser. The page offers a magnet link for a desktop torrent client when playback is unavailable.

Only search for and stream content you have permission to access.
