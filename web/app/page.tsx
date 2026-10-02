"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

type Result = { name: string; size: string; seeds: number; peers: number; files: number; magnet: string };
type SearchResponse = { results: Result[]; page: number; totalPages: number; totalResults: number; query: string };
type PlayableFile = { name: string; path?: string; length: number; downloaded: number; hash: string; index: number };
type BackendSnapshot = { infoHash: string; status: "loading" | "ready" | "error"; error: string | null; files: { index: number; name: string; path?: string; length: number; downloaded: number }[]; progress: number; downloaded: number; speed: number; peers: number };
type Folder = { name: string; folders: Map<string, Folder>; files: PlayableFile[] };

const DEMO_MAGNET = "magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=wss%3A%2F%2Ftracker.btorrent.xyz&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fsintel.torrent";
const videoExt = /\.(mp4|m4v|webm|ogv|mov|mkv|avi)$/i;

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return `${(bytes / 1024 ** unit).toFixed(unit ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
}

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

async function apiJson<T>(response: Response): Promise<T> {
  let data: { error?: string };
  try {
    data = await response.json();
  } catch {
    throw new Error(`The server returned an invalid response (HTTP ${response.status}).`);
  }
  if (!response.ok) throw new Error(data.error || `The server returned HTTP ${response.status}.`);
  return data as T;
}

function FileTree({ files, selected, onPlay }: { files: PlayableFile[]; selected: number | null; onPlay: (file: PlayableFile) => void }) {
  const root: Folder = { name: "", folders: new Map(), files: [] };
  for (const file of files) {
    const parts = (file.path || file.name).split(/[\\/]/).filter(Boolean);
    let folder = root;
    for (const name of parts.slice(0, -1)) {
      if (!folder.folders.has(name)) folder.folders.set(name, { name, folders: new Map(), files: [] });
      folder = folder.folders.get(name)!;
    }
    folder.files.push(file);
  }
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  function renderFolder(folder: Folder) {
    return <>
      {[...folder.folders.values()].sort((a, b) => byName(a.name, b.name)).map((child) =>
        <details className="torrent-folder" key={child.name}>
          <summary>📁 {child.name}</summary>
          <div className="torrent-folder-contents">{renderFolder(child)}</div>
        </details>)}
      {folder.files.sort((a, b) => byName(a.name, b.name)).map((file) =>
        <button type="button" className={`torrent-file${selected === file.index ? " selected" : ""}`} key={file.index} onClick={() => onPlay(file)}>
          <span>▶ {file.name}</span><small>{formatBytes(file.length)}</small>
        </button>)}
    </>;
  }
  return <div className="torrent-tree">{renderFolder(root)}</div>;
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
  const [compatibleAudio, setCompatibleAudio] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const [sourceStart, setSourceStart] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [bufferedAhead, setBufferedAhead] = useState(0);
  const [stats, setStats] = useState({ progress: 0, downloaded: 0, speed: 0, peers: 0 });
  const videoRef = useRef<HTMLVideoElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<HTMLElement>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const requestRef = useRef(0);
  const selectedRef = useRef<PlayableFile | null>(null);

  function stop() {
    requestRef.current++;
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
    if (videoRef.current) { videoRef.current.pause(); videoRef.current.removeAttribute("src"); videoRef.current.load(); }
    setActive(null);
    setFiles([]);
    setChosen(null);
    selectedRef.current = null;
    setCompatibleAudio(false);
    setDuration(null);
    setPlayhead(0);
    setScrubTime(null);
    setSourceStart(0);
    setIsPlaying(false);
    setBufferedAhead(0);
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
      const data = await apiJson<SearchResponse>(response);
      setSearch(data);
      setQuery(term);
    } catch (error) { setSearchError(error instanceof Error ? error.message : "Search failed"); }
    finally { setSearching(false); }
  }

  function submitSearch(event: FormEvent) { event.preventDefault(); void doSearch(); }

  function playFile(file: PlayableFile) {
    if (videoRef.current) { videoRef.current.pause(); videoRef.current.removeAttribute("src"); videoRef.current.load(); }
    selectedRef.current = file;
    setChosen({ ...file });
    setCompatibleAudio(false);
    setDuration(null);
    setPlayhead(0);
    setScrubTime(null);
    setSourceStart(0);
    setIsPlaying(false);
    setBufferedAhead(0);
    setStatus("buffering");
    setStreamError("");
  }

  useEffect(() => {
    if (!chosen) return;
    let cancelled = false;
    void fetch(`/api/torrents/${chosen.hash}/files/${chosen.index}/metadata`)
      .then((response) => apiJson<{ duration: number | null }>(response))
      .then((details) => { if (!cancelled) setDuration(details.duration || 0); })
      .catch(() => { if (!cancelled) setDuration(0); });
    return () => { cancelled = true; };
  }, [chosen]);

  useEffect(() => {
    if (!chosen || duration === null || !videoRef.current) return;
    playerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    try {
      videoRef.current.src = `/api/torrents/${chosen.hash}/files/${chosen.index}${compatibleAudio ? `/compatible?start=${sourceStart.toFixed(3)}` : ""}`;
      videoRef.current.muted = isMuted;
      videoRef.current.volume = volume;
      void videoRef.current.play().then(() => setStatus("playing")).catch(() => setStatus("ready — press play"));
    } catch (error) {
      setStreamError(error instanceof Error ? error.message : "This file cannot play in your browser.");
      setStatus("playback unavailable");
    }
  }, [chosen, compatibleAudio, sourceStart, duration]);

  function seekTo(seconds: number) {
    if (!chosen || !duration || !Number.isFinite(seconds)) return;
    const target = Math.max(0, Math.min(seconds, duration - 0.1));
    setScrubTime(null);
    setPlayhead(target);
    const video = videoRef.current;
    if (!video) return;
    const canConvert = /\.(mkv|avi|mov|mp4|m4v)$/i.test(chosen.name);
    if (compatibleAudio || (canConvert && (/\.(mkv|avi|mov)$/i.test(chosen.name) || !video.seekable.length))) {
      video.pause();
      video.removeAttribute("src");
      video.load();
      setSourceStart(target);
      setCompatibleAudio(true);
      setStatus("buffering at selected time");
    } else {
      video.currentTime = target;
      setStatus("buffering at selected time");
    }
  }

  function updatePlaybackBuffer(video: HTMLVideoElement) {
    let ahead = 0;
    for (let index = 0; index < video.buffered.length; index++) {
      if (video.buffered.start(index) <= video.currentTime && video.currentTime <= video.buffered.end(index)) {
        ahead = video.buffered.end(index) - video.currentTime;
        break;
      }
    }
    setBufferedAhead(Number.isFinite(ahead) ? Math.max(0, ahead) : 0);
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
      const data = await apiJson<BackendSnapshot>(response);
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
        const selectedFile = snapshot.files.find((file) => file.index === selectedRef.current?.index);
        setStats({
          progress: selectedFile ? (selectedFile.length ? selectedFile.downloaded / selectedFile.length * 100 : 100) : snapshot.progress * 100,
          downloaded: selectedFile?.downloaded ?? snapshot.downloaded,
          speed: snapshot.speed,
          peers: snapshot.peers,
        });
        if (snapshot.status !== "ready" || ready) return;
        ready = true;
        const videos: PlayableFile[] = snapshot.files
          .filter((file) => videoExt.test(file.name))
          .sort((a, b) => (a.path || a.name).localeCompare(b.path || b.name, undefined, { numeric: true, sensitivity: "base" }))
          .map((file) => ({ ...file, hash: snapshot.infoHash }));
        setFiles(videos);
        if (!videos.length) {
          setStatus("no video files");
          setStreamError("This torrent does not contain a recognized video file.");
        } else {
          setStatus("choose a video file");
        }
      };
      update(data);
      if (data.status === "error") return;
      intervalRef.current = setInterval(async () => {
        if (requestRef.current !== request) return;
        try {
          const statusResponse = await fetch(`/api/torrents/${hash}`);
          const snapshot = await apiJson<BackendSnapshot>(statusResponse);
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

        {active && chosen && <section className="player-panel" aria-label="Now streaming" ref={playerRef}>
          <div className="section-heading"><div><p className="eyebrow">NOW STREAMING</p><h2>{active.name}</h2></div><button className="close-button" onClick={stop}>Stop stream ✕</button></div>
          <div className="player-surface" ref={surfaceRef}>
            <div className="video-wrap"><video ref={videoRef} playsInline
              onLoadedMetadata={(event) => { if (!duration && Number.isFinite(event.currentTarget.duration)) setDuration(event.currentTarget.duration); }}
              onTimeUpdate={(event) => { setPlayhead((compatibleAudio ? sourceStart : 0) + event.currentTarget.currentTime); updatePlaybackBuffer(event.currentTarget); }}
              onProgress={(event) => updatePlaybackBuffer(event.currentTarget)}
              onPlay={() => { setIsPlaying(true); setStatus("playing"); }}
              onPause={() => setIsPlaying(false)}
              onEnded={() => { setIsPlaying(false); setStatus("finished"); }}
              onError={() => { setStreamError("This video format or codec is not supported by your browser."); setStatus("playback unavailable"); }}
            /><div className="video-status">{status}</div></div>
            <div className="player-controls">
              <button type="button" aria-label={isPlaying ? "Pause video" : "Play video"} onClick={() => { const video = videoRef.current; if (!video) return; if (video.paused) void video.play(); else video.pause(); }}>{isPlaying ? "Ⅱ" : "▶"}</button>
              <span className="player-time">{formatTime(scrubTime ?? playhead)}</span>
              <input className="player-seek" type="range" aria-label="Seek video" min={0} max={duration && duration > 0 ? duration : 0} step={0.1} value={Math.min(scrubTime ?? playhead, duration || 0)} disabled={!duration}
                onChange={(event) => setScrubTime(Number(event.currentTarget.value))}
                onPointerUp={(event) => seekTo(Number(event.currentTarget.value))}
                onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)) seekTo(Number(event.currentTarget.value)); }}
              />
              <span className="player-time">{duration === null ? "Loading…" : formatTime(duration)}</span>
              <button type="button" aria-label={isMuted ? "Unmute" : "Mute"} onClick={() => { const next = !isMuted; setIsMuted(next); if (videoRef.current) videoRef.current.muted = next; }}>{isMuted ? "🔇" : "🔊"}</button>
              <input className="player-volume" type="range" aria-label="Volume" min={0} max={1} step={0.05} value={volume} onChange={(event) => { const next = Number(event.currentTarget.value); setVolume(next); setIsMuted(next === 0); if (videoRef.current) { videoRef.current.volume = next; videoRef.current.muted = next === 0; } }} />
              <select aria-label="Playback speed" defaultValue="1" onChange={(event) => { if (videoRef.current) videoRef.current.playbackRate = Number(event.currentTarget.value); }}><option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select>
              <button type="button" aria-label="Fullscreen" onClick={() => void surfaceRef.current?.requestFullscreen()}>⛶</button>
            </div>
          </div>
          {!compatibleAudio && /\.(mkv|avi|mov|mp4|m4v)$/i.test(chosen.name) && <button type="button" className="secondary-button" onClick={() => { const now = videoRef.current?.currentTime || 0; setSourceStart(now); setPlayhead(now); setCompatibleAudio(true); setStatus("converting audio"); setStreamError(""); }}>Picture plays but no sound? Play with AAC audio</button>}
          {compatibleAudio && <p className="note">Audio is converted to stereo AAC while you watch. Use the timeline to seek to another point.</p>}
          {streamError && <p className="error" role="alert">{streamError}</p>}
          <div className="stream-meta"><span><b>{Math.round(stats.progress)}%</b> of this file cached</span><span><b>{formatBytes(stats.downloaded)}</b> of {formatBytes(chosen.length)} on server</span>{stats.downloaded >= chosen.length ? <span>File cached on server</span> : <span><b>{formatBytes(stats.speed)}/s</b> torrent download</span>}<span><b>{Math.round(bufferedAhead)}s</b> buffered for playback</span><span><b>{stats.peers}</b> peers</span></div>
          <a className="magnet-link" href={active.magnet}>Open magnet in desktop client ↗</a>
        </section>}

        {active && (!search || !search.results.some((result) => result.magnet === active.magnet)) && <section className="result-files standalone-files"><h3>{active.name}</h3><p>{files.length ? "Open a folder, then select a file to stream." : status}</p>{streamError && <p className="error" role="alert">{streamError}</p>}{files.length > 0 && <FileTree files={files} selected={chosen?.index ?? null} onPlay={playFile} />}</section>}

        <section className="results-panel">
          <div className="section-heading"><div><p className="eyebrow">EXPLORE</p><h2>{search ? `Results for “${search.query}”` : "Ready when you are"}</h2></div><span className="count">{search ? `${search.totalResults} results` : "TRY THE DEMO"}</span></div>
          {!search ? <div className="empty"><span className="empty-symbol">▶</span><h3>Your next watch starts here.</h3><p>Search above, paste a magnet, or try a public sample.</p><button className="secondary-button" onClick={() => void start(demo)}>Browse the Sintel demo →</button></div> : search.results.length ? <>
            <div className="result-list">{search.results.map((result) => <article className="result" key={result.magnet}><div className="result-row"><div className="result-icon">▶</div><button type="button" className="result-main result-open" onClick={() => active?.magnet === result.magnet ? stop() : void start(result)} aria-expanded={active?.magnet === result.magnet}><h3 title={result.name}>{result.name}</h3><p>{result.size} <span>·</span> {result.files ? `${result.files} file${result.files === 1 ? "" : "s"}` : "file count unknown"} <span>·</span> {result.seeds} index seeds</p></button><div className="result-actions"><button onClick={() => active?.magnet === result.magnet ? stop() : void start(result)}>{active?.magnet === result.magnet ? "Close files" : "Browse files"} <span>▾</span></button><a href={result.magnet}>Open magnet ↗</a></div></div>{active?.magnet === result.magnet && <div className="result-files"><p>{files.length ? `${files.length} video file${files.length === 1 ? "" : "s"}. Open a folder, then select a file to stream.` : status}</p>{streamError && <p className="error" role="alert">{streamError}</p>}{files.length > 0 && <FileTree files={files} selected={chosen?.index ?? null} onPlay={playFile} />}</div>}</article>)}</div>
            {search.totalPages > 1 && <div className="pagination"><button disabled={search.page <= 1 || searching} onClick={() => void doSearch(search.page - 1, search.query)}>← Previous</button><span>Page {search.page} of {search.totalPages}</span><button disabled={search.page >= search.totalPages || searching} onClick={() => void doSearch(search.page + 1, search.query)}>Next →</button></div>}
          </> : <div className="empty"><span className="empty-symbol">⌕</span><h3>No results found</h3><p>Try a different search term.</p></div>}
        </section>
        <p className="note">Playback needs available torrent peers and a video format your browser can play. Only stream content you have permission to access.</p>
      </main>
    </div>
  );
}
