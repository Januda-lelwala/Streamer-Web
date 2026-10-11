"use client";

import { useEffect, useRef, useState, type FocusEvent, type FormEvent, type KeyboardEvent, type PointerEvent } from "react";

type Result = { name: string; size: string; seeds: number; peers: number; files: number; magnet: string };
type SearchResponse = { results: Result[]; page: number; totalPages: number; totalResults: number; query: string };
type PlayableFile = { name: string; path?: string; length: number; downloaded: number; hash: string; index: number };
type BackendSnapshot = { infoHash: string; status: "loading" | "ready" | "error"; error: string | null; files: { index: number; name: string; path?: string; length: number; downloaded: number }[]; progress: number; downloaded: number; speed: number; peers: number };
type Folder = { name: string; folders: Map<string, Folder>; files: PlayableFile[] };
type SavedSelection = { version: 1; hash: string; title: string; fileIndex: number; fileName: string };
type SubtitleTrack = { index: number; language: string | null; title: string | null };
type SubtitleCue = { start: number; end: number; text: string };

const DEMO_MAGNET = "magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=wss%3A%2F%2Ftracker.btorrent.xyz&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fsintel.torrent";
const videoExt = /\.(mp4|m4v|webm|ogv|mov|mkv|avi)$/i;
const subtitleExt = /\.(srt|vtt|ass|ssa)$/i;
const SELECTION_KEY = "streamer:last-selection:v1";
const LEGACY_SESSION_KEY = "streamer:last-session:v1";

function loadSavedSelection(): SavedSelection | null {
  try {
    const value = JSON.parse(localStorage.getItem(SELECTION_KEY) || localStorage.getItem(LEGACY_SESSION_KEY) || "null");
    if (value?.version !== 1 || !/^[a-f\d]{40}$/i.test(value.hash) ||
      typeof value.title !== "string" || value.title.length > 500 ||
      typeof value.fileName !== "string" || value.fileName.length > 500 ||
      !Number.isSafeInteger(value.fileIndex) || value.fileIndex < 0) return null;
    const selection: SavedSelection = {
      version: 1, hash: value.hash.toLowerCase(), title: value.title,
      fileIndex: value.fileIndex, fileName: value.fileName,
    };
    storeSavedSelection(selection);
    return selection;
  } catch { return null; }
}

function storeSavedSelection(selection: SavedSelection) {
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify(selection));
    localStorage.removeItem(LEGACY_SESSION_KEY);
  } catch { /* Storage can be unavailable. */ }
}

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

function parseSubtitleTime(value: string) {
  const parts = value.replace(",", ".").split(":").map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) return NaN;
  return parts.reduce((seconds, part) => seconds * 60 + part, 0);
}

function parseSubtitles(source: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const block of source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const timing = lines[timingIndex].match(/(\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}\s*-->\s*(\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}/);
    if (!timing) continue;
    const [startText, endText] = timing[0].split(/\s*-->\s*/);
    const start = parseSubtitleTime(startText);
    const end = parseSubtitleTime(endText);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const text = lines.slice(timingIndex + 1).join("\n").replace(/<[^>]*>/g, "").trim();
    if (text) cues.push({ start, end, text });
  }
  return cues;
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
  const [subtitleFiles, setSubtitleFiles] = useState<PlayableFile[]>([]);
  const [chosen, setChosen] = useState<PlayableFile | null>(null);
  const [embeddedSubtitles, setEmbeddedSubtitles] = useState<SubtitleTrack[]>([]);
  const [selectedSubtitle, setSelectedSubtitle] = useState("");
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([]);
  const [localSubtitleCues, setLocalSubtitleCues] = useState<SubtitleCue[]>([]);
  const [subtitleError, setSubtitleError] = useState("");
  const [localSubtitleName, setLocalSubtitleName] = useState("");
  const [compatibleAudio, setCompatibleAudio] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const [sourceStart, setSourceStart] = useState(0);
  const [compatibleRetry, setCompatibleRetry] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showFullscreenControls, setShowFullscreenControls] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [bufferedAhead, setBufferedAhead] = useState(0);
  const [stats, setStats] = useState({ progress: 0, downloaded: 0, speed: 0, peers: 0 });
  const [savedSelection, setSavedSelection] = useState<SavedSelection | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<HTMLElement>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const seekRecoveryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestRef = useRef(0);
  const selectedRef = useRef<PlayableFile | null>(null);
  const playbackRetryRef = useRef({ attempts: 0, position: 0 });
  const mediaStartRef = useRef(0);
  const resumeListenerRef = useRef<(() => void) | null>(null);

  useEffect(() => { setSavedSelection(loadSavedSelection()); }, []);

  useEffect(() => {
    const updateFullscreen = () => {
      setIsFullscreen(document.fullscreenElement === surfaceRef.current);
      setShowFullscreenControls(false);
    };
    document.addEventListener("fullscreenchange", updateFullscreen);
    return () => document.removeEventListener("fullscreenchange", updateFullscreen);
  }, []);

  useEffect(() => {
    if (!active || !chosen) return;
    const selection: SavedSelection = {
      version: 1, hash: chosen.hash, title: active.name,
      fileIndex: chosen.index, fileName: chosen.name,
    };
    storeSavedSelection(selection);
    setSavedSelection(selection);
  }, [active, chosen]);

  function clearResumeListener(video: HTMLVideoElement | null) {
    if (video && resumeListenerRef.current) video.removeEventListener("loadedmetadata", resumeListenerRef.current);
    resumeListenerRef.current = null;
  }

  function clearSeekRecovery() {
    if (seekRecoveryRef.current) clearTimeout(seekRecoveryRef.current);
    seekRecoveryRef.current = null;
  }

  function clearSeekRecoveryIfReady(video: HTMLVideoElement) {
    if (seekRecoveryRef.current && !video.seeking &&
      Math.abs(video.currentTime - playbackRetryRef.current.position) < 1) clearSeekRecovery();
  }

  function stop() {
    requestRef.current++;
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
    clearResumeListener(videoRef.current);
    clearSeekRecovery();
    if (videoRef.current) { videoRef.current.pause(); videoRef.current.removeAttribute("src"); videoRef.current.load(); }
    setActive(null);
    setFiles([]);
    setSubtitleFiles([]);
    setChosen(null);
    setEmbeddedSubtitles([]);
    setSelectedSubtitle("");
    setSubtitleCues([]);
    setLocalSubtitleCues([]);
    setSubtitleError("");
    setLocalSubtitleName("");
    selectedRef.current = null;
    playbackRetryRef.current = { attempts: 0, position: 0 };
    mediaStartRef.current = 0;
    setCompatibleAudio(false);
    setDuration(null);
    setPlayhead(0);
    setScrubTime(null);
    setSourceStart(0);
    setCompatibleRetry(0);
    setIsPlaying(false);
    setIsBuffering(false);
    setShowFullscreenControls(false);
    setSettingsOpen(false);
    setBufferedAhead(0);
    setStats({ progress: 0, downloaded: 0, speed: 0, peers: 0 });
    setStatus("idle");
    setStreamError("");
  }

  useEffect(() => () => {
    requestRef.current++;
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (seekRecoveryRef.current) clearTimeout(seekRecoveryRef.current);
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
    clearResumeListener(videoRef.current);
    clearSeekRecovery();
    if (videoRef.current) { videoRef.current.pause(); videoRef.current.removeAttribute("src"); videoRef.current.load(); }
    selectedRef.current = file;
    playbackRetryRef.current = { attempts: 0, position: 0 };
    mediaStartRef.current = 0;
    setChosen({ ...file });
    setEmbeddedSubtitles([]);
    setSelectedSubtitle("");
    setSubtitleCues([]);
    setLocalSubtitleCues([]);
    setSubtitleError("");
    setLocalSubtitleName("");
    setCompatibleAudio(false);
    setDuration(null);
    setPlayhead(0);
    setScrubTime(null);
    setSourceStart(0);
    setCompatibleRetry(0);
    setIsPlaying(false);
    setIsBuffering(true);
    setBufferedAhead(0);
    setStatus("buffering");
    setStreamError("");
  }

  useEffect(() => {
    if (!chosen) return;
    let cancelled = false;
    void fetch(`/api/torrents/${chosen.hash}/files/${chosen.index}/metadata`)
      .then((response) => apiJson<{ duration: number | null; audioCodec: string | null; subtitles?: SubtitleTrack[] }>(response))
      .then((details) => {
        if (cancelled) return;
        if (/\.(mkv|avi)$/i.test(chosen.name) && details.audioCodec) setCompatibleAudio(true);
        setDuration(details.duration || 0);
        setEmbeddedSubtitles(details.subtitles || []);
      })
      .catch(() => { if (!cancelled) setDuration(0); });
    return () => { cancelled = true; };
  }, [chosen]);

  useEffect(() => {
    if (!chosen || !selectedSubtitle || selectedSubtitle === "local") return;
    const controller = new AbortController();
    setSubtitleCues([]);
    setSubtitleError("");
    const [kind, value] = selectedSubtitle.split(":");
    const index = kind === "file" ? Number(value) : chosen.index;
    const suffix = kind === "embedded" ? `?stream=${encodeURIComponent(value)}` : "";
    void fetch(`/api/torrents/${chosen.hash}/files/${index}/subtitles${suffix}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load this subtitle track.");
        return response.text();
      })
      .then((body) => {
        const cues = parseSubtitles(body);
        if (!cues.length) throw new Error("This subtitle track has no readable captions.");
        setSubtitleCues(cues);
      })
      .catch((error) => { if (!controller.signal.aborted) setSubtitleError(error instanceof Error ? error.message : "Could not load subtitles."); });
    return () => controller.abort();
  }, [chosen, selectedSubtitle]);

  async function loadLocalSubtitle(file: File | undefined) {
    if (!file) return;
    setSubtitleError("");
    if (!/\.(srt|vtt)$/i.test(file.name) || file.size > 2 * 1024 * 1024) {
      setSubtitleError("Choose an SRT or VTT file under 2 MB.");
      return;
    }
    try {
      const cues = parseSubtitles(await file.text());
      if (!cues.length) throw new Error("This file has no readable captions.");
      setLocalSubtitleName(file.name);
      setLocalSubtitleCues(cues);
      setSubtitleCues(cues);
      setSelectedSubtitle("local");
    } catch (error) { setSubtitleError(error instanceof Error ? error.message : "Could not read subtitles."); }
  }

  useEffect(() => {
    if (!chosen || duration === null || !videoRef.current) return;
    playerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    try {
      mediaStartRef.current = compatibleAudio ? sourceStart : 0;
      videoRef.current.src = `/api/torrents/${chosen.hash}/files/${chosen.index}${compatibleAudio ? `/compatible?start=${sourceStart.toFixed(3)}&retry=${compatibleRetry}` : ""}`;
      videoRef.current.muted = isMuted;
      videoRef.current.volume = volume;
      videoRef.current.playbackRate = playbackSpeed;
      setIsBuffering(true);
      void videoRef.current.play().then(() => setStatus("playing")).catch(() => { setIsBuffering(false); setStatus("ready — press play"); });
    } catch (error) {
      setIsBuffering(false);
      setStreamError(error instanceof Error ? error.message : "This file cannot play in your browser.");
      setStatus("playback unavailable");
    }
  }, [chosen, compatibleAudio, sourceStart, duration, compatibleRetry]);

  function seekTo(seconds: number) {
    if (!chosen || !duration || !Number.isFinite(seconds)) return;
    clearSeekRecovery();
    const target = Math.max(0, Math.min(seconds, duration - 0.1));
    playbackRetryRef.current = { attempts: 0, position: target };
    setScrubTime(null);
    setPlayhead(target);
    setIsBuffering(true);
    const video = videoRef.current;
    if (!video) return;
    if (compatibleAudio || /\.(mkv|avi|mov)$/i.test(chosen.name)) {
      setSourceStart(target);
      setCompatibleAudio(true);
      // Restart even when seeking back to the current stream's start.
      setCompatibleRetry((retry) => retry + 1);
      setStatus("buffering at selected time");
    } else {
      const wasPlaying = !video.paused;
      try {
        video.currentTime = target;
      } catch {
        // Duration can arrive from ffprobe before the browser loads metadata.
        clearResumeListener(video);
        const resume = () => {
          resumeListenerRef.current = null;
          try {
            video.currentTime = target;
            if (wasPlaying) void video.play().catch(() => setStatus("ready — press play"));
          }
          catch { setIsBuffering(false); setStreamError("Could not seek this video. Try selecting it again."); }
        };
        resumeListenerRef.current = resume;
        if (video.readyState === 0) video.addEventListener("loadedmetadata", resume, { once: true });
        else {
          video.src = `/api/torrents/${chosen.hash}/files/${chosen.index}?seek=${Date.now()}`;
          video.addEventListener("loadedmetadata", resume, { once: true });
          video.load();
        }
      }
      setStatus("buffering at selected time");
      if (/\.(mp4|m4v)$/i.test(chosen.name)) {
        seekRecoveryRef.current = setTimeout(() => {
          seekRecoveryRef.current = null;
          if (selectedRef.current?.index !== chosen.index || videoRef.current !== video) return;
          const ready = video.readyState >= (video.paused ? HTMLMediaElement.HAVE_CURRENT_DATA : HTMLMediaElement.HAVE_FUTURE_DATA);
          if (!video.seeking && ready && Math.abs(video.currentTime - target) < 1) return;
          setStatus("restarting playback at selected time");
          setSourceStart(target);
          setCompatibleAudio(true);
          setCompatibleRetry((retry) => retry + 1);
        }, 10000);
      }
    }
  }

  function togglePlayback() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) { setIsBuffering(true); void video.play().catch(() => { setIsBuffering(false); setStatus("ready — press play"); }); }
    else video.pause();
  }

  function skipBy(seconds: number) { seekTo(playhead + seconds); }

  function toggleFullscreen() {
    if (document.fullscreenElement === surfaceRef.current) void document.exitFullscreen();
    else void surfaceRef.current?.requestFullscreen();
  }

  function handlePlayerPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!isFullscreen || event.pointerType === "touch") return;
    const bottom = event.currentTarget.getBoundingClientRect().bottom;
    setShowFullscreenControls(bottom - event.clientY <= 130);
  }

  function handleControlsBlur(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setShowFullscreenControls(false);
  }

  function handlePlayerKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    const key = event.key.toLowerCase();
    if (key === " " || key === "k") { event.preventDefault(); togglePlayback(); }
    else if (key === "arrowleft") { event.preventDefault(); skipBy(-10); }
    else if (key === "arrowright") { event.preventDefault(); skipBy(10); }
    else if (key === "m") { event.preventDefault(); setIsMuted((muted) => { if (videoRef.current) videoRef.current.muted = !muted; return !muted; }); }
    else if (key === "f") { event.preventDefault(); toggleFullscreen(); }
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

  function handlePlaybackError(video: HTMLVideoElement) {
    const error = video.error;
    if (!chosen || !error || error.code === MediaError.MEDIA_ERR_ABORTED) return;
    const retry = playbackRetryRef.current;
    const position = Math.max(mediaStartRef.current + video.currentTime, retry.position);
    console.warn("Video playback interrupted", { code: error.code, message: error.message, position });
    clearResumeListener(video);
    clearSeekRecovery();
    if (position > retry.position + 30) {
      retry.attempts = 0;
      retry.position = position;
    }
    // A file that has already played is usable. A later media error can be a
    // broken range response, so reopen the stream at the same position.
    if (position > 1 && (!duration || position < duration - 1) && retry.attempts < 2) {
      retry.attempts++;
      retry.position = position;
      setStatus("reconnecting stream");
      setStreamError("");
      if (compatibleAudio) {
        setSourceStart(position);
        setCompatibleRetry((value) => value + 1);
        return;
      }
      const resume = () => {
        resumeListenerRef.current = null;
        try {
          video.currentTime = position;
          void video.play().catch(() => setStatus("ready — press play"));
        } catch {
          setStatus("ready — press play");
        }
      };
      resumeListenerRef.current = resume;
      video.addEventListener("loadedmetadata", resume, { once: true });
      video.src = `/api/torrents/${chosen.hash}/files/${chosen.index}?retry=${retry.attempts}`;
      video.load();
      return;
    }
    const messages: Record<number, string> = {
      [MediaError.MEDIA_ERR_NETWORK]: "The video connection was interrupted. Try selecting the file again.",
      [MediaError.MEDIA_ERR_DECODE]: "The browser could not decode part of this video.",
      [MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED]: "The video stream ended unexpectedly or its format is unsupported.",
    };
    setStreamError(messages[error.code] || "Video playback stopped unexpectedly.");
    setStatus("playback stopped");
    setIsPlaying(false);
    setIsBuffering(false);
  }

  async function start(result: Result, reopen?: SavedSelection) {
    stop();
    const request = requestRef.current;
    setActive(result);
    setStatus("connecting to torrent peers");
    await startBackend(result, request, reopen);
  }

  async function startBackend(result: Result, request: number, reopen?: SavedSelection): Promise<void> {
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
        setSubtitleFiles(snapshot.files.filter((file) => subtitleExt.test(file.name))
          .map((file) => ({ ...file, hash: snapshot.infoHash })));
        const savedFile = reopen?.hash === snapshot.infoHash ? videos.find((file) => file.index === reopen.fileIndex) : null;
        if (savedFile) {
          playFile(savedFile);
        } else if (!videos.length) {
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
  const chosenPath = chosen?.path || chosen?.name || "";
  const videoDirectory = chosenPath.slice(0, Math.max(chosenPath.lastIndexOf("/"), chosenPath.lastIndexOf("\\")) + 1);
  const videoStem = chosen?.name.replace(videoExt, "").toLowerCase() || "";
  const matchingSubtitles = subtitleFiles.filter((file) => {
    const path = file.path || file.name;
    const directory = path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
    const stem = file.name.replace(subtitleExt, "").toLowerCase();
    return directory === videoDirectory && (stem === videoStem || stem.startsWith(`${videoStem}.`) || stem.startsWith(`${videoStem}-`) || files.length === 1);
  });
  const activeCaptions = selectedSubtitle && subtitleCues.filter((cue) => cue.start <= playhead && playhead < cue.end).map((cue) => cue.text).join("\n");
  const timelinePosition = Math.min(scrubTime ?? playhead, duration || 0);
  const progressPercent = duration ? Math.min(100, timelinePosition / duration * 100) : 0;
  const bufferedPercent = duration ? Math.max(progressPercent, Math.min(100, (playhead + bufferedAhead) / duration * 100)) : 0;
  const needsAttention = /unavailable|stopped|failed/.test(status);

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
          {!active && savedSelection && <button type="button" className="secondary-button" onClick={() => void start({ name: savedSelection.title, magnet: `magnet:?xt=urn:btih:${savedSelection.hash}&dn=${encodeURIComponent(savedSelection.title)}`, size: "", seeds: 0, peers: 0, files: 0 }, savedSelection)}>Reopen {savedSelection.fileName} →</button>}
        </section>

        {active && chosen && <section className="player-panel" aria-label="Now streaming" ref={playerRef}>
          <div className="section-heading player-heading"><div><p className="eyebrow">NOW PLAYING</p><h2>{chosen.name}</h2><p className="player-source">From {active.name}</p></div><button className="close-button" onClick={stop}>Stop stream ✕</button></div>
          <div className={`player-surface${showFullscreenControls || settingsOpen ? " fullscreen-controls-visible" : ""}`} ref={surfaceRef} tabIndex={0} onKeyDown={handlePlayerKeyDown} onPointerMove={handlePlayerPointerMove} onPointerLeave={() => setShowFullscreenControls(false)} aria-label="Video player. Space to play or pause, arrow keys to skip 10 seconds, M to mute, F for fullscreen">
            <div className="video-wrap"><video ref={videoRef} playsInline onClick={() => { surfaceRef.current?.focus(); togglePlayback(); }} onDoubleClick={toggleFullscreen}
              onLoadedMetadata={(event) => { if (!duration && Number.isFinite(event.currentTarget.duration)) setDuration(event.currentTarget.duration); }}
              onTimeUpdate={(event) => { setPlayhead(mediaStartRef.current + event.currentTarget.currentTime); updatePlaybackBuffer(event.currentTarget); }}
              onProgress={(event) => updatePlaybackBuffer(event.currentTarget)}
              onPlay={() => { setIsPlaying(true); setStatus("playing"); }}
              onPlaying={(event) => { clearSeekRecoveryIfReady(event.currentTarget); setIsBuffering(false); }}
              onWaiting={() => setIsBuffering(true)}
              onSeeking={() => setIsBuffering(true)}
              onSeeked={(event) => { setIsBuffering(false); setStatus((current) => current === "buffering at selected time" ? (event.currentTarget.paused ? "paused" : "playing") : current); }}
              onCanPlay={(event) => { clearSeekRecoveryIfReady(event.currentTarget); setIsBuffering(false); }}
              onPause={() => { setIsPlaying(false); setIsBuffering(false); setStatus((current) => current === "playing" ? "paused" : current); }}
              onEnded={() => { setIsPlaying(false); setIsBuffering(false); setStatus("finished"); }}
              onError={(event) => handlePlaybackError(event.currentTarget)}
            /><div className={`video-status${needsAttention ? " has-error" : ""}`}><span className="status-dot" />{isBuffering ? "Buffering…" : status}</div>
              {!isPlaying && !isBuffering && !needsAttention && <button type="button" className="video-center-play" onClick={togglePlayback} aria-label="Play video">▶</button>}
              {isBuffering && <div className="video-loading" role="status" aria-label="Video buffering"><span className="loading-ring" /></div>}
              {activeCaptions && <div className="video-captions" aria-live="off">{activeCaptions}</div>}</div>
            <div className="player-controls" onFocusCapture={() => { if (isFullscreen) setShowFullscreenControls(true); }} onBlurCapture={handleControlsBlur}>
              <div className="timeline-row">
                <span className="player-time">{formatTime(timelinePosition)}</span>
                <input className="player-seek" type="range" aria-label="Seek video" min={0} max={duration && duration > 0 ? duration : 0} step={0.1} value={timelinePosition} disabled={!duration}
                style={{ background: `linear-gradient(to right, #f5f5f5 0% ${progressPercent}%, #929292 ${progressPercent}% ${bufferedPercent}%, #454545 ${bufferedPercent}% 100%)` }}
                onChange={(event) => setScrubTime(Number(event.currentTarget.value))}
                onPointerUp={(event) => seekTo(Number(event.currentTarget.value))}
                onKeyUp={(event) => { if (["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)) seekTo(Number(event.currentTarget.value)); }}
                />
                <span className="player-time">{duration === null ? "--:--" : formatTime(duration)}</span>
              </div>
              <div className="transport-row">
                <div className="transport-main">
                  <button type="button" className="transport-button" aria-label="Back 10 seconds" title="Back 10 seconds (←)" disabled={!duration} onClick={() => skipBy(-10)}>↺ <small>10</small></button>
                  <button type="button" className="transport-button play-button" aria-label={isPlaying ? "Pause video" : "Play video"} title="Play or pause (Space)" onClick={togglePlayback}>{isPlaying ? "Ⅱ" : "▶"}</button>
                  <button type="button" className="transport-button" aria-label="Forward 10 seconds" title="Forward 10 seconds (→)" disabled={!duration} onClick={() => skipBy(10)}>↻ <small>10</small></button>
                  <span className="transport-divider" />
                  <button type="button" className="transport-button mute-button" aria-label={isMuted ? "Unmute" : "Mute"} title="Mute (M)" onClick={() => { const next = !isMuted; setIsMuted(next); if (videoRef.current) videoRef.current.muted = next; }}>{isMuted ? "🔇" : "🔊"}</button>
                  <input className="player-volume" type="range" aria-label="Volume" min={0} max={1} step={0.05} value={isMuted ? 0 : volume} onChange={(event) => { const next = Number(event.currentTarget.value); setVolume(next); setIsMuted(next === 0); if (videoRef.current) { videoRef.current.volume = next; videoRef.current.muted = next === 0; } }} />
                </div>
                <div className="transport-options">
                  <details className="player-settings" onToggle={(event) => setSettingsOpen(event.currentTarget.open)}><summary aria-label="Playback settings">⚙ <span>Settings</span></summary><div className="settings-menu">
                    <label>Subtitles<select aria-label="Subtitles" value={selectedSubtitle} onChange={(event) => { const value = event.currentTarget.value; setSelectedSubtitle(value); setSubtitleCues(value === "local" ? localSubtitleCues : []); setSubtitleError(""); }}>
                      <option value="">Off</option>
                      {matchingSubtitles.map((file) => <option key={file.index} value={`file:${file.index}`}>{file.name}</option>)}
                      {embeddedSubtitles.map((track) => <option key={track.index} value={`embedded:${track.index}`}>{track.title || track.language || `Track ${track.index}`} (embedded)</option>)}
                      {localSubtitleName && <option value="local">{localSubtitleName} (local)</option>}
                    </select></label>
                    <label className="subtitle-upload">＋ Load SRT or VTT<input type="file" accept=".srt,.vtt,text/vtt" onChange={(event) => { void loadLocalSubtitle(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} /></label>
                    <label>Playback speed<select aria-label="Playback speed" value={playbackSpeed} onChange={(event) => { const next = Number(event.currentTarget.value); setPlaybackSpeed(next); if (videoRef.current) videoRef.current.playbackRate = next; }}><option value="0.75">0.75×</option><option value="1">Normal (1×)</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label>
                  </div></details>
                  <button type="button" className="transport-button fullscreen-button" aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"} title="Fullscreen (F)" onClick={toggleFullscreen}>{isFullscreen ? "⊟" : "⛶"}</button>
                </div>
              </div>
            </div>
          </div>
          <p className="player-hint">Click the video to pause or play. Focus the player for Space, ←/→, M and F shortcuts.</p>
          {subtitleError && <p className="error" role="alert">{subtitleError}</p>}
          {!compatibleAudio && /\.(mkv|avi|mov|mp4|m4v)$/i.test(chosen.name) && <button type="button" className="secondary-button" onClick={() => { const now = videoRef.current?.currentTime || 0; playbackRetryRef.current = { attempts: 0, position: now }; setSourceStart(now); setPlayhead(now); setCompatibleAudio(true); setStatus("converting audio"); setStreamError(""); }}>Picture plays but no sound? Play with AAC audio</button>}
          {compatibleAudio && <><p className="note">Audio is converted to stereo AAC while you watch. Use the timeline to seek to another point.</p><button type="button" className="secondary-button" onClick={() => { playbackRetryRef.current = { attempts: 0, position: 0 }; setCompatibleAudio(false); setSourceStart(0); setPlayhead(0); setStatus("buffering original stream"); setStreamError(""); }}>Try original stream from start</button></>}
          {streamError && <p className="error" role="alert">{streamError}</p>}
          <div className="stream-health" aria-label="Stream details">
            <div className="cache-info"><div><strong>Download cache</strong><span>{formatBytes(stats.downloaded)} of {formatBytes(chosen.length)} cached</span></div><b>{Math.round(stats.progress)}%</b><div className="cache-bar"><span style={{ width: `${Math.max(0, Math.min(100, stats.progress))}%` }} /></div></div>
            <div className="health-stat"><strong>{Math.round(bufferedAhead)}s</strong><span>video ahead</span></div>
            <div className="health-stat"><strong>{stats.peers}</strong><span>peers</span></div>
            <div className="health-stat"><strong>{stats.downloaded >= chosen.length ? "Cached" : `${formatBytes(stats.speed)}/s`}</strong><span>{stats.downloaded >= chosen.length ? "on server" : "download speed"}</span></div>
          </div>
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
