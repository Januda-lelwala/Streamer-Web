import { authorized, unauthorized } from "../../../../lib/auth.js";
import { getTorrent, serialize } from "../../../../lib/torrents.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request, { params }) {
  if (!authorized(request)) return unauthorized();
  const { hash } = await params;
  if (!/^[a-f\d]{40}$/i.test(hash)) return Response.json({ error: "Invalid torrent hash." }, { status: 400 });
  const entry = getTorrent(hash);
  if (!entry) return Response.json({ error: "Torrent session expired." }, { status: 404 });
  return Response.json(serialize(entry), { headers: { "Cache-Control": "no-store" } });
}
