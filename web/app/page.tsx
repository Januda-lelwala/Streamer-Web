"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

type Result = { name: string; size: string; seeds: number; peers: number; files: number; magnet: string };
type SearchResponse = { results: Result[]; page: number; totalPages: number; totalResults: number; query: string };
type PlayableFile = { name: string; length: number; hash: string; index: number };
type BackendSnapshot = { infoHash: string; status: "loading" | "ready" | "error"; error: string | null; files: { index: number; name: string; length: number }[]; progress: number; downloaded: number; speed: number; peers: number };

const DEMO_MAGNET = "magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=wss%3A%2F%2Ftracker.btorrent.xyz&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fsintel.torrent";
const videoExt = /\.(mp4|m4v|webm|ogv|mov|mkv)$/i;

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [active, setActive] = useState<Result | null>(null);
  const [status, setStatus] = useState("idle");
  const [streamError, setStreamError] = useState("");
  const [files, setFiles] = useState<PlayableFile[]>([]);
  const [chosen, setChosen] = useState<PlayableFile | null>(null);
  const [stats, setStats] = useState({ progress: 0, downloaded: 0, speed: 0, peers: 0 });
  const videoRef = useRef<HTMLVideoElement>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const requestRef = useRef(0);

  function stop() {
    requestRef.current++;
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
    if (videoRef.current) { videoRef.current.pause(); videoRef.current.removeAttribute("src"); videoRef.current.load(); }
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

  function playFile(file: PlayableFile) {
    if (!videoRef.current) return;
    setChosen(file);
    setStatus("buffering");
    setStreamError("");
    try {
      videoRef.current.src = `/api/torrents/${file.hash}/files/${file.index}`;
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
    setStatus("connecting to torrent peers");
    await startBackend(result, request);
  }

  async function startBackend(result: Result, request: number): Promise<void> {
    const hash = new URL(result.magnet).searchParams.get("xt")?.match(/^urn:btih:([a-f\d]{40})$/i)?.[1];
    if (!hash) {
      setStreamError("This magnet link has an invalid torrent identifier.");
      setStatus("connection failed");
      return;
    }
    try {
      const response = await fetch("/api/torrents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ infoHash: hash }) });
      if (requestRef.current !== request) return;
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not connect to torrent backend.");
      setStatus("fetching torrent metadata");
      let ready = false;
      const update = (snapshot: BackendSnapshot) => {
        if (requestRef.current !== request) return;
        if (snapshot.status === "error") {
          if (intervalRef.current) clearInterval(intervalRef.current);
          intervalRef.current = null;
          setStreamError(snapshot.error || "Torrent backend could not connect to peers.");
          setStatus("connection failed");
          return;
        }
        setStats({ progress: snapshot.progress * 100, downloaded: snapshot.downloaded, speed: snapshot.speed, peers: snapshot.peers });
        if (snapshot.status !== "ready" || ready) return;
        ready = true;
        const videos: PlayableFile[] = snapshot.files.filter((file) => videoExt.test(file.name)).sort((a, b) => b.length - a.length).map((file) => ({ ...file, hash: snapshot.infoHash }));
        setFiles(videos);
        if (!videos.length) {
          setStatus("no video files");
          setStreamError("This torrent does not contain a recognized video file.");
        } else {
          setStatus(videos.length > 1 ? "choose a video" : "buffering");
          if (videos.length === 1) playFile(videos[0]);
        }
      };
      update(data as BackendSnapshot);
      if ((data as BackendSnapshot).status === "error") return;
      intervalRef.current = setInterval(async () => {
        if (requestRef.current !== request) return;
        try {
          const statusResponse = await fetch(`/api/torrents/${hash}`);
          const snapshot = await statusResponse.json();
          if (!statusResponse.ok) throw new Error(snapshot.error || "Torrent backend lost the stream.");
          update(snapshot);
        } catch (error) {
          if (requestRef.current !== request) return;
          if (intervalRef.current) clearInterval(intervalRef.current);
          intervalRef.current = null;
          setStreamError(error instanceof Error ? error.message : "Torrent backend is unavailable.");
          setStatus("connection failed");
        }
      }, 2000);
    } catch (error) {
      if (requestRef.current === request) {
        setStreamError(error instanceof Error ? error.message : "Could not start stream.");
        setStatus("connection failed");
      }
    }
  }

  const demo: Result = { name: "Sintel — public demo", size: "Public demo", seeds: 0, peers: 0, files: 1, magnet: DEMO_MAGNET };

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
          <p className="hero-copy">Search torrents and stream video through the connected server. Playback depends on available peers and a video format your browser supports.</p>
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
          {files.length > 1 && <div className="file-picker"><label htmlFor="video-file">Choose a video file</label><select id="video-file" value={chosen ? String(files.indexOf(chosen)) : ""} onChange={(event) => { const file = files[Number(event.target.value)]; if (file) playFile(file); }}><option value="">Select a file</option>{files.map((file, index) => <option key={`${file.name}-${index}`} value={index}>{file.name} · {formatBytes(file.length)}</option>)}</select></div>}
          <div className="stream-meta"><span><b>{Math.round(stats.progress)}%</b> downloaded</span><span><b>{formatBytes(stats.downloaded)}</b> received</span><span><b>{formatBytes(stats.speed)}/s</b> speed</span><span><b>{stats.peers}</b> peers</span></div>
          <div className="progress-track"><div style={{ width: `${Math.max(0, Math.min(stats.progress, 100))}%` }} /></div>
          <a className="magnet-link" href={active.magnet}>Open magnet in desktop client ↗</a>
        </section>}

        <section className="results-panel">
          <div className="section-heading"><div><p className="eyebrow">EXPLORE</p><h2>{search ? `Results for “${search.query}”` : "Ready when you are"}</h2></div><span className="count">{search ? `${search.totalResults} results` : "TRY THE DEMO"}</span></div>
          {!search ? <div className="empty"><span className="empty-symbol">▶</span><h3>Your next watch starts here.</h3><p>Search above, paste a magnet, or try a public sample.</p><button className="secondary-button" onClick={() => void start(demo)}>Play the Sintel demo →</button></div> : search.results.length ? <>
            <div className="result-list">{search.results.map((result) => <article className="result" key={result.magnet}><div className="result-icon">▶</div><div className="result-main"><h3 title={result.name}>{result.name}</h3><p>{result.size} <span>·</span> {result.files ? `${result.files} file${result.files === 1 ? "" : "s"}` : "file count unknown"} <span>·</span> {result.seeds} index seeds</p></div><div className="result-actions"><button onClick={() => void start(result)}>Stream video <span>→</span></button><a href={result.magnet}>Open magnet ↗</a></div></article>)}</div>
            {search.totalPages > 1 && <div className="pagination"><button disabled={search.page <= 1 || searching} onClick={() => void doSearch(search.page - 1, search.query)}>← Previous</button><span>Page {search.page} of {search.totalPages}</span><button disabled={search.page >= search.totalPages || searching} onClick={() => void doSearch(search.page + 1, search.query)}>Next →</button></div>}
          </> : <div className="empty"><span className="empty-symbol">⌕</span><h3>No results found</h3><p>Try a different search term.</p></div>}
        </section>
        <p className="note">Playback needs available torrent peers and a video format your browser can play. Only stream content you have permission to access.</p>
      </main>
    </div>
  );
}
