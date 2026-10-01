export async function proxyTorrent(request: Request) {
  const backend = process.env.TORRENT_BACKEND_URL;
  const token = process.env.TORRENT_BACKEND_TOKEN;
  if (!backend || !token) {
    return Response.json({ error: "Server playback is not configured yet." }, { status: 503 });
  }
  try {
    const source = new URL(request.url);
    const destination = new URL(source.pathname, backend);
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    const range = request.headers.get("range");
    if (range) headers.set("Range", range);
    if (request.method === "POST") headers.set("Content-Type", "application/json");
    const upstream = await fetch(destination, {
      method: request.method,
      headers,
      body: request.method === "POST" ? await request.text() : undefined,
      cache: "no-store",
      redirect: "manual",
    });
    if (upstream.status >= 300 && upstream.status < 400) throw new Error("Torrent backend redirected unexpectedly.");
    if (!source.pathname.includes("/files/") && !upstream.headers.get("Content-Type")?.toLowerCase().includes("application/json")) {
      const body = upstream.status === 530 ? await upstream.text() : "";
      const error = body.includes("error code: 1033")
        ? "Streaming server is offline: its Cloudflare Tunnel is disconnected (error 1033)."
        : "Streaming server returned an unexpected response.";
      return Response.json({ error }, { status: 502, headers: { "Cache-Control": "no-store" } });
    }
    const responseHeaders = new Headers();
    for (const name of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "X-Content-Type-Options"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    responseHeaders.set("Cache-Control", "no-store");
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    console.error("Torrent backend request failed:", error);
    return Response.json({ error: "Torrent backend is unavailable." }, { status: 502 });
  }
}
