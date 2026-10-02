import { spawn } from "node:child_process";
import { authorized, unauthorized } from "../../../../../../../lib/auth.js";
import { mediaInput } from "../../../../../../../lib/media-input.js";
import { beginStream, getTorrent } from "../../../../../../../lib/torrents.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function probe(entry, hash, index) {
  const finish = beginStream(entry);
  const source = mediaInput(hash, index);
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v", "error", "-headers", source.headers,
      "-show_entries", "format=duration:stream=codec_type,codec_name,channels",
      "-of", "json", source.url,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let error = "";
    const timeout = setTimeout(() => child.kill(), 20000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 65536) child.kill();
    });
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      finish();
      if (code !== 0) return reject(new Error(error.slice(0, 500) || "Could not read media details."));
      try {
        const data = JSON.parse(output);
        const duration = Number(data.format?.duration);
        resolve({
          duration: Number.isFinite(duration) && duration > 0 ? duration : null,
          videoCodec: data.streams?.find((stream) => stream.codec_type === "video")?.codec_name || null,
          audioCodec: data.streams?.find((stream) => stream.codec_type === "audio")?.codec_name || null,
        });
      } catch (cause) { reject(cause); }
    });
  });
}

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
  if (!entry.torrent.files[Number(index)]) {
    return Response.json({ error: "File not found." }, { status: 404 });
  }
  const cache = entry.mediaMetadata ??= new Map();
  if (!cache.has(index)) cache.set(index, probe(entry, hash, index));
  try {
    return Response.json(await cache.get(index), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    cache.delete(index);
    console.error("Media probe failed:", error);
    return Response.json({ error: "Could not read video duration." }, { status: 502 });
  }
}
