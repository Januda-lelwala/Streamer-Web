# Streamer torrent backend

This is a separate Next.js Node service for the Cloudflare Worker frontend. It uses WebTorrent's Node client to connect to ordinary BitTorrent peers and serves video through authenticated HTTP range requests. It must run as one persistent process with writable disk; it cannot run inside the existing Worker or a short-lived serverless function.

## Local run

```bash
cd backend
npm ci
export STREAM_BACKEND_TOKEN="$(openssl rand -hex 32)"
npm run dev
```

The development server listens on port 3001. For production, run `npm run build && PORT=3001 npm run start`, or build the `Dockerfile`. Set `STREAM_BACKEND_TOKEN` to a random value of at least 32 characters. Set `TORRENT_DATA_DIR` to a writable directory with enough space for the streams. Use one backend instance: torrent sessions are held in memory and are not shared across instances.

The backend must be reachable from the Cloudflare Worker at a public HTTPS URL. Set `TORRENT_BACKEND_URL` and the same `TORRENT_BACKEND_TOKEN` as Worker secrets using `wrangler secret put` in `web/`, then redeploy the Worker. Keep port 3001 private. The backend requires the bearer token on every API request. Do not expose this token to the browser or add it to GitHub.

Production runs on the VPS at `140.245.195.5` as the `streamer-backend` systemd service. It listens only on `127.0.0.1:3001`. The `streamer-tunnel` service publishes it through Cloudflare Tunnel at `https://streamer-backend.digitalcert.dpdns.org`, so the VPS needs no inbound HTTP ports. Service settings and the backend token are in `/etc/streamer-backend.env` (root only); downloaded data is in `/var/lib/streamer/torrents`. This small VPS limits sessions to one active torrent and 8 GB per torrent.

GitHub Actions builds and deploys the backend to the VPS on pushes to `main`, then deploys the Worker frontend. It uses the repository secret `STREAMER_VPS_DEPLOY_KEY` for SSH. The deployment verifies the VPS host key and rolls back the backend symlink if its local HTTP health check fails.

The Worker sends only a 40-character info hash to the backend. The backend uses its own tracker list, accepts up to three active torrents by default (`MAX_ACTIVE_TORRENTS`), rejects torrents above 20 GB by default (`MAX_TORRENT_BYTES`) after metadata loads, and removes idle sessions after 30 minutes. Files are downloaded as needed for playback. Video formats still depend on browser codec support; MP4/H.264 is the most reliable choice.

## API

- `POST /api/torrents` with JSON `{ "infoHash": "..." }` starts or reuses a session.
- `GET /api/torrents/:hash` reports metadata, files, and transfer progress.
- `GET /api/torrents/:hash/files/:index` streams a file; `Range` requests return `206` with `Content-Range`.

All endpoints require `Authorization: Bearer <STREAM_BACKEND_TOKEN>`.
