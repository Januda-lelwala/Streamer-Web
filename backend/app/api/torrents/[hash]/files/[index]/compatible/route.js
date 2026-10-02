import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { authorized, unauthorized } from "../../../../../../../lib/auth.js";
import { mediaInput } from "../../../../../../../lib/media-input.js";
import { beginStream, getTorrent, selectPlaybackFile } from "../../../../../../../lib/torrents.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  if (!authorized(request)) return unauthorized();
  const { hash, index } = await params;
  if (!/^[a-f\d]{40}$/i.test(hash) || !/^(0|[1-9]\d*)$/.test(index)) {
    return Response.json({ error: "Invalid file." }, { status: 400 });
  }
  const entry = getTorrent(hash);
  if (!entry || entry.status !== "ready" || !entry.torrent) {
    return Response.json({ error: "Torrent is not ready." }, { status: 404 });
  }
  const file = entry.torrent.files[Number(index)];
  if (!file || !/\.(mkv|avi|mov|mp4|m4v)$/i.test(file.name)) {
    return Response.json({ error: "Compatible playback is unavailable for this file." }, { status: 400 });
  }
  const start = Number(new URL(request.url).searchParams.get("start") || 0);
  if (!Number.isFinite(start) || start < 0 || start > 43200) {
    return Response.json({ error: "Invalid playback position." }, { status: 400 });
  }
  if ((globalThis.__streamerAudioTranscodes || 0) >= 2) {
    return Response.json({ error: "Compatible audio is busy. Try again shortly." }, { status: 503 });
  }
  selectPlaybackFile(entry, Number(index));
  globalThis.__streamerAudioTranscodes = (globalThis.__streamerAudioTranscodes || 0) + 1;
  const finish = beginStream(entry);
  const source = mediaInput(hash, index);
  const encoder = spawn("ffmpeg", [
    "-nostdin", "-loglevel", "error", "-headers", source.headers,
    ...(start ? ["-ss", start.toFixed(3)] : []), "-i", source.url,
    "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", "-tag:v", "hvc1",
    "-c:a", "aac", "-ac", "2", "-b:a", "192k",
    "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "pipe:1",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    encoder.kill();
    finish();
    globalThis.__streamerAudioTranscodes--;
  };
  encoder.on("error", close);
  encoder.stderr.on("data", (chunk) => console.error("Compatible playback failed:", String(chunk).slice(0, 500)));

  const reader = Readable.toWeb(encoder.stdout).getReader();
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { close(); controller.close(); }
        else controller.enqueue(value);
      } catch (error) { close(); controller.error(error); }
    },
    async cancel(reason) { await reader.cancel(reason); close(); },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "video/mp4",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
