#!/usr/bin/env bash
set -euo pipefail

revision="${1:?A Git revision is required}"
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || { echo "Invalid revision" >&2; exit 1; }
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo "This deployment requires Linux x86-64" >&2; exit 1; }
command -v apt-get >/dev/null || { echo "This deployment requires Ubuntu or Debian" >&2; exit 1; }
sudo -n true || { echo "The deploy user needs passwordless sudo" >&2; exit 1; }

stage="/tmp/streamer-deploy-$revision"
for file in backend.tar.gz backend.env tunnel.token; do
  test -s "$stage/$file" || { echo "Missing deployment file: $file" >&2; exit 1; }
done

sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl xz-utils

node_version=v22.23.3
node_home="/opt/node-$node_version"
if [[ ! -x "$node_home/bin/node" ]]; then
  node_archive="node-$node_version-linux-x64.tar.xz"
  node_url="https://nodejs.org/download/release/$node_version"
  curl -fsSL "$node_url/$node_archive" -o "$stage/$node_archive"
  curl -fsSL "$node_url/SHASUMS256.txt" -o "$stage/SHASUMS256.txt"
  (cd "$stage" && grep "  $node_archive\$" SHASUMS256.txt | sha256sum -c -)
  sudo install -d -m 755 "$node_home"
  sudo tar -xJf "$stage/$node_archive" -C "$node_home" --strip-components=1
fi

if ! command -v cloudflared >/dev/null; then
  sudo install -d -m 755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq cloudflared
fi
cloudflared_bin="$(command -v cloudflared)"

if ! id streamer >/dev/null 2>&1; then
  sudo useradd --system --home-dir /var/lib/streamer --shell /usr/sbin/nologin streamer
fi
sudo install -d -o streamer -g streamer -m 750 /var/lib/streamer /var/lib/streamer/torrents
sudo install -d -m 755 /opt/streamer-backend/releases
sudo install -o root -g root -m 600 "$stage/backend.env" /etc/streamer-backend.env
sudo install -o streamer -g streamer -m 600 "$stage/tunnel.token" /etc/streamer-tunnel.token

release="/opt/streamer-backend/releases/$revision"
previous="$(readlink -f /opt/streamer-backend/current || true)"
sudo install -d -m 755 "$release"
sudo tar -xzf "$stage/backend.tar.gz" -C "$release"

sudo tee /etc/systemd/system/streamer-backend.service >/dev/null <<UNIT
[Unit]
Description=Streamer torrent backend
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=streamer
Group=streamer
WorkingDirectory=/opt/streamer-backend/current
EnvironmentFile=/etc/streamer-backend.env
Environment=NODE_ENV=production
Environment=PORT=3001
Environment=HOSTNAME=127.0.0.1
Environment=TORRENT_DATA_DIR=/var/lib/streamer/torrents
ExecStart=$node_home/bin/node /opt/streamer-backend/current/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

sudo tee /etc/systemd/system/streamer-tunnel.service >/dev/null <<UNIT
[Unit]
Description=Cloudflare Tunnel for Streamer backend
Wants=network-online.target streamer-backend.service
After=network-online.target streamer-backend.service

[Service]
Type=simple
User=streamer
Group=streamer
ExecStart=$cloudflared_bin tunnel run --token-file /etc/streamer-tunnel.token
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo ln -sfn "$release" /opt/streamer-backend/current.next
sudo mv -Tf /opt/streamer-backend/current.next /opt/streamer-backend/current
sudo systemctl enable streamer-backend.service >/dev/null
sudo systemctl restart streamer-backend.service
if ! curl --fail --silent --show-error --retry 12 --retry-delay 2 --retry-connrefused http://127.0.0.1:3001/ -o /dev/null; then
  if [[ -n "$previous" && -d "$previous" ]]; then
    sudo ln -sfn "$previous" /opt/streamer-backend/current.next
    sudo mv -Tf /opt/streamer-backend/current.next /opt/streamer-backend/current
    sudo systemctl restart streamer-backend.service
  else
    sudo systemctl stop streamer-backend.service
  fi
  echo "Backend health check failed" >&2
  exit 1
fi
sudo systemctl enable streamer-tunnel.service >/dev/null
sudo systemctl restart streamer-tunnel.service
sudo systemctl is-active --quiet streamer-tunnel.service
rm -rf -- "$stage"
