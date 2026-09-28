import { proxyTorrent } from "./proxy";

export async function POST(request: Request) {
  return proxyTorrent(request);
}
