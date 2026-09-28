const PAGE_SIZE = 20;
const TRACKERS = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.btorrent.xyz",
];

type ApibayItem = {
  name?: string;
  info_hash?: string;
  seeders?: string;
  leechers?: string;
  size?: string;
  num_files?: string;
};

type CsvItem = {
  name?: string;
  infohash?: string;
  size_bytes?: number;
  seeders?: number;
  leechers?: number;
};

type CsvResponse = {
  torrents?: CsvItem[];
};

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4);
  return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
}

function buildMagnet(hash: string, name: string) {
  const params = new URLSearchParams();
  params.set("dn", name);
  for (const tracker of TRACKERS) params.append("tr", tracker);
  return `magnet:?xt=urn:btih:${hash}&${params}`;
}

async function searchCsv(query: string, page: number) {
  const url = new URL("https://torrents-csv.com/service/search");
  url.searchParams.set("q", query);
  url.searchParams.set("size", "100");
  const upstream = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
  if (!upstream.ok) throw new Error(`Fallback search provider returned ${upstream.status}`);
  const data: CsvResponse = await upstream.json();
  if (!Array.isArray(data.torrents)) throw new Error("Fallback search provider sent an invalid response");

  const results = data.torrents
    .filter((item) => item && /^[a-f\d]{40}$/i.test(item.infohash ?? "") && item.name)
    .map((item) => ({
      name: item.name!,
      size: formatBytes(Number(item.size_bytes)),
      seeds: Number(item.seeders) || 0,
      peers: Number(item.leechers) || 0,
      files: 0,
      magnet: buildMagnet(item.infohash!, item.name!),
    }));
  const totalResults = results.length;
  return {
    results: results.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    page,
    totalPages: Math.ceil(totalResults / PAGE_SIZE),
    totalResults,
    query,
  };
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = (params.get("q") ?? "").trim();
  const rawPage = Number(params.get("page") ?? "1");
  if (query.length < 2 || query.length > 100 || !Number.isInteger(rawPage) || rawPage < 1 || rawPage > 100) {
    return Response.json({ error: "Enter a search of 2–100 characters and a valid page." }, { status: 400 });
  }

  try {
    let data: unknown;
    try {
      const upstream = await fetch(`https://apibay.org/q.php?q=${encodeURIComponent(query)}&cat=0`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      if (!upstream.ok) throw new Error(`Search provider returned ${upstream.status}`);
      data = await upstream.json();
      if (!Array.isArray(data)) throw new Error("Search provider sent an invalid response");
    } catch (error) {
      console.warn("Primary search provider failed:", error);
      return Response.json(await searchCsv(query, rawPage), { headers: { "Cache-Control": "public, max-age=60" } });
    }

    const results = (data as ApibayItem[])
      .filter((item) => item && /^[a-f\d]{40}$/i.test(item.info_hash ?? "") && !/^0+$/.test(item.info_hash ?? "") && item.name !== "No results returned")
      .map((item) => {
        return {
          name: item.name ?? "Untitled torrent",
          size: formatBytes(Number(item.size)),
          seeds: Number(item.seeders) || 0,
          peers: Number(item.leechers) || 0,
          files: Number(item.num_files) || 0,
          magnet: buildMagnet(item.info_hash!, item.name ?? "Untitled torrent"),
        };
      });

    return Response.json({
      results: results.slice((rawPage - 1) * PAGE_SIZE, rawPage * PAGE_SIZE),
      page: rawPage,
      totalPages: Math.ceil(results.length / PAGE_SIZE),
      totalResults: results.length,
      query,
    }, { headers: { "Cache-Control": "public, max-age=60" } });
  } catch (error) {
    console.error("Search failed:", error);
    return Response.json({ error: "Search is temporarily unavailable. Please try again." }, { status: 502 });
  }
}
