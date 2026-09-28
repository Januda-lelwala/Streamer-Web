"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

type Result = { name: string; size: string; seeds: number; peers: number; files: number; magnet: string };
type SearchResponse = { results: Result[]; page: number; totalPages: number; totalResults: number; query: string };
type TorrentFile = { name: string; length: number; select(): void; deselect(): void; streamTo(element: HTMLVideoElement): HTMLVideoElement };
type Torrent = { files: TorrentFile[]; progress: number; downloaded: number; downloadSpeed: number; numPeers: number; on(event: string, handler: (error?: Error) => void): void };
type TorrentClient = { add(magnet: string, callback: (torrent: Torrent) => void): void; on(event: string, handler: (error: Error) => void): void; createServer(options: { controller: ServiceWorkerRegistration }): void; destroy(): void };
type WebTorrentConstructor = new () => TorrentClient;

const DEMO_MAGNET = "magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=wss%3A%2F%2Ftracker.btorrent.xyz&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fsintel.torrent";
const videoExt = /\.(mp4|m4v|webm|ogv|mov|mkv)$/i;

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
}

let loader: Promise<WebTorrentConstructor> | null = null;
function loadWebTorrent() {
  const asset = "/webtorrent.min.js";
  if (!loader) loader = import(/* @vite-ignore */ asset)
    .then((module) => module.default as WebTorrentConstructor)
    .catch((error) => { loader = null; throw error; });
  return loader;
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [active, setActive] = useState<Result | null>(null);
  const [status, setStatus] = useState("idle");
  const [streamError, setStreamError] = useState("");
  const [files, setFiles] = useState<TorrentFile[]>([]);
  const [chosen, setChosen] = useState<TorrentFile | null>(null);
  const [stats, setStats] = useState({ progress: 0, downloaded: 0, speed: 0, peers: 0 });
  const videoRef = useRef<HTMLVideoElement>(null);
  const clientRef = useRef<TorrentClient | null>(null);
  const torrentRef = useRef<Torrent | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestRef = useRef(0);

  function stop() {
    requestRef.current++;
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    intervalRef.current = null;
    timeoutRef.current = null;
    if (videoRef.current) { videoRef.current.pause(); videoRef.current.removeAttribute("src"); videoRef.current.load(); }
    clientRef.current?.destroy();
    clientRef.current = null;
    torrentRef.current = null;
    setActive(null);
    setFiles([]);
    setChosen(null);
    setStats({ progress: 0, downloaded: 0, speed: 0, peers: 0 });
    setStatus("idle");
    setStreamError("");
  }

  useEffect(() => () => {
    requestRef.current++;
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    clientRef.current?.destroy();
  }, []);

  async function doSearch(page = 1, searchQuery = query) {
    const term = searchQuery.trim();
    if (term.length < 2) { setSearchError("Enter at least 2 characters."); return; }
    setSearching(true);
    setSearchError("");
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(term)}&page=${page}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Search failed");
      setSearch(data);
      setQuery(term);
    } catch (error) { setSearchError(error instanceof Error ? error.message : "Search failed"); }
    finally { setSearching(false); }
  }

  function submitSearch(event: FormEvent) { event.preventDefault(); void doSearch(); }

  function playFile(file: TorrentFile) {
    if (!torrentRef.current || !videoRef.current) return;
    for (const candidate of torrentRef.current.files) candidate === file ? candidate.select() : candidate.deselect();
    setChosen(file);
    setStatus("buffering");
    setStreamError("");
    try {
      file.streamTo(videoRef.current);
      void videoRef.current.play().then(() => setStatus("playing")).catch(() => setStatus("ready — press play"));
    } catch (error) {
      setStreamError(error instanceof Error ? error.message : "This file cannot play in your browser.");
      setStatus("playback unavailable");
    }
  }

  async function start(result: Result) {
    stop();
    const request = requestRef.current;
    setActive(result);
    setStatus("connecting to web peers");
    try {
      const Constructor = await loadWebTorrent();
      if (requestRef.current !== request) return;
      const client = new Constructor();
      clientRef.current = client;
      if (!("serviceWorker" in navigator)) throw new Error("This browser does not support the service worker needed for playback.");
      const registration = await navigator.serviceWorker.register("/sw.min.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Service worker did not take control of this page. Refresh and try again.")), 5000);
          navigator.serviceWorker.addEventListener("controllerchange", () => { clearTimeout(timeout); resolve(); }, { once: true });
        });
      }
      if (requestRef.current !== request) { client.destroy(); return; }
      client.createServer({ controller: registration });
      client.on("error", (error) => {
        if (requestRef.current === request) { setStreamError(error.message); setStatus("connection failed"); }
      });
      timeoutRef.current = setTimeout(() => {
        if (requestRef.current === request && !torrentRef.current) {
          requestRef.current++;
          setStreamError("No WebRTC peer supplied torrent metadata. This result may only have desktop BitTorrent peers; open its magnet in a desktop client below.");
          setStatus("no web peers found");
          client.destroy();
          clientRef.current = null;
        }
      }, 45000);
      client.add(result.magnet, (torrent) => {
        if (requestRef.current !== request) return;
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        torrentRef.current = torrent;
        for (const file of torrent.files) file.deselect();
        const videos = torrent.files.filter((file) => videoExt.test(file.name)).sort((a, b) => b.length - a.length);
        setFiles(videos);
        if (!videos.length) {
          setStatus("no video files");
          setStreamError("This torrent does not contain a recognized video file.");
          return;
        }
        setStatus(videos.length > 1 ? "choose a video" : "buffering");
        intervalRef.current = setInterval(() => setStats({
          progress: torrent.progress * 100,
          downloaded: torrent.downloaded,
          speed: torrent.downloadSpeed,
          peers: torrent.numPeers,
        }), 1000);
        if (videos.length === 1) playFileFromTorrent(torrent, videos[0]);
      });
    } catch (error) {
      if (requestRef.current === request) {
        clientRef.current?.destroy();
        clientRef.current = null;
        setStreamError(error instanceof Error ? error.message : "Could not start stream");
        setStatus("connection failed");
      }
    }
  }

  function playFileFromTorrent(torrent: Torrent, file: TorrentFile) {
    torrentRef.current = torrent;
    playFile(file);
  }

  const demo: Result = { name: "Sintel — WebTorrent demo", size: "Public demo", seeds: 0, peers: 0, files: 1, magnet: DEMO_MAGNET };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">▶</span><span><strong>Streamer</strong><small>WEB EDITION</small></span></div>
        <span className="top-pill"><span className="live-dot" /> Browser streaming</span>
      </header>

      <main>
        <section className="hero">
          <p className="eyebrow">SEARCH · DISCOVER · WATCH</p>
          <h1>Find a video.<br /><em>Press play.</em></h1>
          <p className="hero-copy">Search torrents and try browser playback when WebRTC peers are available. Your Worker handles search; the stream comes from peers.</p>
          <form className="search-form" onSubmit={submitSearch}>
            <span className="search-glyph">⌕</span>
            <input aria-label="Search torrents" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search for a movie, show, or video…" maxLength={100} />
            <button type="submit" disabled={searching}>{searching ? "Searching…" : "Search"}<span>→</span></button>
          </form>
          {searchError && <p className="error" role="alert">{searchError}</p>}
          <div className="hero-foot"><span>Have a magnet link?</span><button className="text-button" onClick={() => { const magnet = window.prompt("Paste a magnet link"); if (magnet && /^magnet:\?xt=urn:btih:[a-f\d]{40}/i.test(magnet)) void start({ ...demo, name: new URL(magnet).searchParams.get("dn") || "Custom magnet", magnet }); else if (magnet) setSearchError("That is not a valid magnet link."); }}>Paste a magnet link ↗</button></div>
        </section>

        {active && <section className="player-panel" aria-label="Now streaming">
          <div className="section-heading"><div><p className="eyebrow">NOW STREAMING</p><h2>{active.name}</h2></div><button className="close-button" onClick={stop}>Stop stream ✕</button></div>
          <div className="video-wrap"><video ref={videoRef} controls playsInline onError={() => { setStreamError("This video format or codec is not supported by your browser."); setStatus("playback unavailable"); }} /><div className="video-status">{status}</div></div>
          {streamError && <p className="error" role="alert">{streamError}</p>}
          {files.length > 1 && <div className="file-picker"><label htmlFor="video-file">Choose a video file</label><select id="video-file" value={chosen?.name || ""} onChange={(event) => { const file = files.find((item) => item.name === event.target.value); if (file) playFile(file); }}><option value="">Select a file</option>{files.map((file) => <option key={file.name} value={file.name}>{file.name} · {formatBytes(file.length)}</option>)}</select></div>}
          <div className="stream-meta"><span><b>{Math.round(stats.progress)}%</b> downloaded</span><span><b>{formatBytes(stats.downloaded)}</b> received</span><span><b>{formatBytes(stats.speed)}/s</b> speed</span><span><b>{stats.peers}</b> web peers</span></div>
          <div className="progress-track"><div style={{ width: `${Math.max(0, Math.min(stats.progress, 100))}%` }} /></div>
          <a className="magnet-link" href={active.magnet}>Open magnet in desktop client ↗</a>
        </section>}

        <section className="results-panel">
          <div className="section-heading"><div><p className="eyebrow">EXPLORE</p><h2>{search ? `Results for “${search.query}”` : "Ready when you are"}</h2></div><span className="count">{search ? `${search.totalResults} results` : "TRY THE DEMO"}</span></div>
          {!search ? <div className="empty"><span className="empty-symbol">▶</span><h3>Your next watch starts here.</h3><p>Search above, paste a magnet, or try a WebRTC-ready sample.</p><button className="secondary-button" onClick={() => void start(demo)}>Play the Sintel demo →</button></div> : search.results.length ? <>
            <div className="result-list">{search.results.map((result) => <article className="result" key={result.magnet}><div className="result-icon">▶</div><div className="result-main"><h3 title={result.name}>{result.name}</h3><p>{result.size} <span>·</span> {result.files ? `${result.files} file${result.files === 1 ? "" : "s"}` : "file count unknown"} <span>·</span> {result.seeds} index seeds</p></div><div className="result-actions"><button onClick={() => void start(result)}>Try browser playback <span>→</span></button><a href={result.magnet}>Open magnet ↗</a></div></article>)}</div>
            {search.totalPages > 1 && <div className="pagination"><button disabled={search.page <= 1 || searching} onClick={() => void doSearch(search.page - 1, search.query)}>← Previous</button><span>Page {search.page} of {search.totalPages}</span><button disabled={search.page >= search.totalPages || searching} onClick={() => void doSearch(search.page + 1, search.query)}>Next →</button></div>}
          </> : <div className="empty"><span className="empty-symbol">⌕</span><h3>No results found</h3><p>Try a different search term.</p></div>}
        </section>
        <p className="note">Browser playback needs WebRTC peers and a video format your browser can play. Index seed counts include desktop peers. Only stream content you have permission to access.</p>
      </main>
    </div>
  );
}
