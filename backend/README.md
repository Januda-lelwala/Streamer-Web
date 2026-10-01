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

## Move production to an Ubuntu/Debian x86-64 VPS

The [deployment workflow](../.github/workflows/deploy-worker.yml) can provision a fresh Ubuntu/Debian x86-64 VPS. It installs Node 22 and `cloudflared`, creates a dedicated `streamer` user, and enables two systemd services. The backend listens on `127.0.0.1:3001`; the tunnel publishes it without opening an inbound HTTP port. The deploy user needs SSH access and passwordless `sudo`. Allow inbound SSH from GitHub Actions runners while deploying.

In GitHub **Settings → Secrets and variables → Actions**, add these repository **secrets**:

| Secret | Value |
| --- | --- |
| `STREAMER_VPS_HOST` | New VPS public IPv4 address or DNS name. |
| `STREAMER_VPS_USER` | SSH login, such as `ubuntu`. |
| `STREAMER_VPS_DEPLOY_KEY` | Private SSH key whose public half is in the login user's `~/.ssh/authorized_keys`. |
| `STREAMER_VPS_HOST_FINGERPRINT` | The server's ED25519 host key fingerprint, such as `SHA256:...`. Read it from the VPS provider console with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` rather than accepting a key from the network. |
| `STREAMER_BACKEND_TOKEN` | New long shared secret; generate with `openssl rand -hex 32`. This replaces the Worker and backend tokens together after a successful deployment. |
| `STREAMER_TUNNEL_TOKEN` | Token for a **remotely managed** Cloudflare Tunnel. In Cloudflare, open **Networking → Tunnels → your tunnel → Add a replica** and copy only the token from the install command. Deployment uses its tunnel ID to fetch the current token from Cloudflare, so this value can remain after tunnel token rotation. [Cloudflare's token instructions](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/). |

Add these repository **variables**:

| Variable | Value |
| --- | --- |
| `STREAMER_BACKEND_URL` | HTTPS public hostname routed through the tunnel, for example `https://streamer-backend.digitalcert.dpdns.org`. |
| `STREAMER_BACKEND_ENABLED` | Set to `true` **after** all settings above are saved. Until then, backend deployment is skipped and Worker deployments continue. |

Configure the tunnel's public hostname to forward to `http://localhost:3001` on the new VPS. You can reuse the existing hostname and tunnel if they are remotely managed, or create a new tunnel and set `STREAMER_BACKEND_URL` to its hostname. Keep `3001` closed to public traffic. The script stores tokens in restricted files on the VPS: `/etc/streamer-backend.env` and `/etc/streamer-tunnel.token`. Torrent data lives in `/var/lib/streamer/torrents`, with a two-session and 8 GB per torrent limit.

The `CLOUDFLARE_API_TOKEN` secret needs Cloudflare Tunnel Write (or Cloudflare One Connector: cloudflared Write) permission to fetch the current tunnel token. When moving an in-memory torrent backend, disconnect the retired server's tunnel connector; multiple replicas would split torrent sessions between servers.

After setting the variable, run **Actions → Deploy Cloudflare Worker → Run workflow**. The backend job builds and deploys to the new VPS, verifies its local HTTP response, and starts the tunnel. The Worker job remains independent so the site can still deploy if the VPS is unavailable. The `connect-backend` job waits for the public tunnel hostname and then updates `TORRENT_BACKEND_URL` and `TORRENT_BACKEND_TOKEN` on the Worker. The backend release symlink rolls back if its local health check fails.

Check the run's three jobs, then open the site and browse a known public torrent. If the tunnel health check fails, inspect `sudo systemctl status streamer-backend streamer-tunnel` and `sudo journalctl -u streamer-tunnel -n 80 --no-pager` on the VPS. The tunnel token must belong to the tunnel serving the configured hostname.

The Worker sends only a 40-character info hash to the backend. The backend uses its own tracker list, accepts up to three active torrents by default (`MAX_ACTIVE_TORRENTS`), rejects torrents above 20 GB by default (`MAX_TORRENT_BYTES`) after metadata loads, and removes idle sessions after 30 minutes. Files are downloaded as needed for playback. Video formats still depend on browser codec support; MP4/H.264 is the most reliable choice.

## API

- `POST /api/torrents` with JSON `{ "infoHash": "..." }` starts or reuses a session.
- `GET /api/torrents/:hash` reports metadata, files, and transfer progress.
- `GET /api/torrents/:hash/files/:index` streams a file; `Range` requests return `206` with `Content-Range`.

All endpoints require `Authorization: Bearer <STREAM_BACKEND_TOKEN>`.
