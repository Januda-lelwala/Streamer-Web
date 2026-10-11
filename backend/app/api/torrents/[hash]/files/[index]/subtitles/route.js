import { spawn } from "node:child_process";
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
  const streamValue = new URL(request.url).searchParams.get("stream");
  const embedded = streamValue !== null;
  if (!file || (embedded && (!/^\d{1,3}$/.test(streamValue) || !/\.(mp4|m4v|webm|ogv|mov|mkv|avi)$/i.test(file.name))) ||
    (!embedded && (!/\.(srt|vtt|ass|ssa)$/i.test(file.name) || file.length > 5 * 1024 * 1024))) {
    return Response.json({ error: "Subtitle track is unavailable." }, { status: 400 });
  }

  selectPlaybackFile(entry, Number(index));
  const finish = beginStream(entry);
  const source = mediaInput(hash, index);
  let output = "";
  let error = "";
  try {
    const subtitle = await new Promise((resolve, reject) => {
      const child = spawn("ffmpeg", [
        "-nostdin", "-loglevel", "error", "-headers", source.headers, "-i", source.url,
        ...(embedded ? ["-map", `0:${streamValue}`] : ["-map", "0:s:0"]),
        "-f", "webvtt", "pipe:1",
      ], { stdio: ["ignore", "pipe", "pipe"] });
      const timeout = setTimeout(() => child.kill(), 30000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.length > 2 * 1024 * 1024) child.kill();
      });
      child.stderr.on("data", (chunk) => { error = (error + chunk).slice(-500); });
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0 && output.startsWith("WEBVTT")) resolve(output);
        else reject(new Error(error || "Subtitle conversion failed or exceeded its limit."));
      });
    });
    return new Response(subtitle, { headers: { "Content-Type": "text/vtt; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  } catch (cause) {
    console.error("Subtitle conversion failed:", cause);
    return Response.json({ error: "Could not load this subtitle track." }, { status: 502 });
  } finally {
    finish();
  }
}
