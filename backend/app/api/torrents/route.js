import { authorized, unauthorized } from "../../../lib/auth.js";
import { addTorrent } from "../../../lib/torrents.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  if (!authorized(request)) return unauthorized();
  if (Number(request.headers.get("content-length")) > 512) return Response.json({ error: "Request is too large." }, { status: 413 });
  let data;
  try { data = await request.json(); } catch { return Response.json({ error: "Invalid JSON." }, { status: 400 }); }
  if (!/^[a-f\d]{40}$/i.test(data?.infoHash ?? "")) return Response.json({ error: "Invalid torrent hash." }, { status: 400 });
  try {
    return Response.json(addTorrent(data.infoHash), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error.message || "Could not add torrent." }, { status: error.status || 500 });
  }
}
