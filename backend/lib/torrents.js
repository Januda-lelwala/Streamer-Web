import WebTorrent from "webtorrent";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "wss://tracker.openwebtorrent.com",
];
const METADATA_TIMEOUT_MS = 60000;
const IDLE_MS = 30 * 60 * 1000;
const ERROR_MS = 2 * 60 * 1000;
const MAX_TORRENTS = 3;
const MAX_BYTES = 20 * 1024 ** 3;

function createState() {
  const client = new WebTorrent({ natUpnp: false, natPmp: false, lsd: false, maxConns: 40 });
  client.on("error", (error) => console.error("Torrent client error:", error));
  const state = { client, entries: new Map() };
  const cleanup = setInterval(() => {
    for (const [hash, entry] of state.entries) {
      if (entry.activeStreams === 0 && Date.now() - entry.lastAccess > (entry.status === "error" ? ERROR_MS : IDLE_MS)) {
        removeTorrent(state, hash);
      }
    }
  }, 60000);
  cleanup.unref();
  return state;
}

function getState() {
  return globalThis.__streamerTorrentState ??= createState();
}

function removeTorrent(state, hash) {
  const entry = state.entries.get(hash);
  if (!entry) return;
  clearTimeout(entry.timeout);
  state.entries.delete(hash);
  if (entry.torrent) {
    void state.client.remove(entry.torrent, { destroyStore: true }).catch((error) => console.error("Torrent cleanup failed:", error));
  }
}

export function addTorrent(hash) {
  const state = getState();
  hash = hash.toLowerCase();
  const existing = state.entries.get(hash);
  if (existing) {
    existing.lastAccess = Date.now();
    return serialize(existing);
  }
  if ([...state.entries.values()].filter((entry) => entry.status !== "error").length >= MAX_TORRENTS) {
    throw Object.assign(new Error("The stream server is busy. Try again later."), { status: 503 });
  }
  const entry = { hash, status: "loading", error: null, torrent: null, activeStreams: 0, lastAccess: Date.now(), timeout: null };
  state.entries.set(hash, entry);
  try {
    const torrent = state.client.add(hash, {
      announce: TRACKERS,
      path: process.env.TORRENT_DATA_DIR || join(tmpdir(), "streamer-torrents"),
      addUID: true,
      deselect: true,
      destroyStoreOnDestroy: true,
    }, (readyTorrent) => {
      if (state.entries.get(hash) !== entry || entry.status !== "loading") return;
      clearTimeout(entry.timeout);
      const totalBytes = readyTorrent.files.reduce((sum, file) => sum + file.length, 0);
      if (totalBytes > MAX_BYTES) {
        entry.status = "error";
        entry.error = "Torrent exceeds the server's 20 GB limit.";
        void state.client.remove(readyTorrent, { destroyStore: true }).catch(console.error);
        entry.torrent = null;
        return;
      }
      entry.status = "ready";
    });
    entry.torrent = torrent;
    torrent.on("error", (error) => {
      if (state.entries.get(hash) !== entry) return;
      clearTimeout(entry.timeout);
      entry.status = "error";
      entry.error = error.message || "Torrent connection failed.";
      entry.torrent = null;
      void state.client.remove(torrent, { destroyStore: true }).catch(console.error);
    });
    entry.timeout = setTimeout(() => {
      if (state.entries.get(hash) !== entry || entry.status !== "loading") return;
      entry.status = "error";
      entry.error = "No torrent peers supplied metadata within 60 seconds.";
      void state.client.remove(torrent, { destroyStore: true }).catch(console.error);
      entry.torrent = null;
    }, METADATA_TIMEOUT_MS);
    entry.timeout.unref();
  } catch (error) {
    state.entries.delete(hash);
    throw error;
  }
  return serialize(entry);
}

export function getTorrent(hash) {
  const state = globalThis.__streamerTorrentState;
  if (!state) return null;
  const entry = state.entries.get(hash.toLowerCase());
  if (!entry) return null;
  return entry;
}

export function serialize(entry) {
  const torrent = entry.status === "ready" ? entry.torrent : null;
  return {
    infoHash: entry.hash,
    status: entry.status,
    error: entry.error,
    files: torrent?.files.map((file, index) => ({ index, name: file.name, length: file.length, type: file.type })) ?? [],
    progress: torrent?.progress ?? 0,
    downloaded: torrent?.downloaded ?? 0,
    speed: torrent?.downloadSpeed ?? 0,
    peers: torrent?.numPeers ?? 0,
  };
}

export function beginStream(entry) {
  entry.activeStreams++;
  entry.lastAccess = Date.now();
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    entry.activeStreams--;
    entry.lastAccess = Date.now();
  };
}
