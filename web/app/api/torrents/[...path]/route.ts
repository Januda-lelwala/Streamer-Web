import { proxyTorrent } from "../proxy";

export async function GET(request: Request) {
  return proxyTorrent(request);
}
