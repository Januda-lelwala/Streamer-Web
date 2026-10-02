import { authorized, unauthorized } from "../../../../../../lib/auth.js";
import { beginStream, getTorrent, selectPlaybackFile } from "../../../../../../lib/torrents.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function byteRange(value, length) {
  if (!value) return { start: 0, end: length - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, length - suffix);
    end = length - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : length - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= length || end < start) return null;
  return { start, end: Math.min(end, length - 1), partial: true };
}

export async function GET(request, { params }) {
  if (!authorized(request)) return unauthorized();
  const { hash, index } = await params;
  if (!/^[a-f\d]{40}$/i.test(hash) || !/^(0|[1-9]\d*)$/.test(index)) return Response.json({ error: "Invalid file." }, { status: 400 });
  const entry = getTorrent(hash);
  if (!entry || entry.status !== "ready" || !entry.torrent) return Response.json({ error: "Torrent is not ready." }, { status: 404 });
  const file = entry.torrent.files[Number(index)];
  if (!file) return Response.json({ error: "File not found." }, { status: 404 });
  const range = byteRange(request.headers.get("range"), file.length);
  if (!range) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${file.length}` } });
  selectPlaybackFile(entry, Number(index));
  const finish = beginStream(entry);
  const reader = file.stream({ start: range.start, end: range.end }).getReader();
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { finish(); controller.close(); }
        else controller.enqueue(value);
      } catch (error) { finish(); controller.error(error); }
    },
    async cancel(reason) { finish(); await reader.cancel(reason); },
  });
  return new Response(stream, {
    status: range.partial ? 206 : 200,
    headers: {
      "Accept-Ranges": "bytes",
      "Content-Type": file.type || "application/octet-stream",
      "Content-Length": String(range.end - range.start + 1),
      ...(range.partial ? { "Content-Range": `bytes ${range.start}-${range.end}/${file.length}` } : {}),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
