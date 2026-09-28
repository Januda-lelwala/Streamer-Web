import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const source = join(process.cwd(), "node_modules", "webtorrent", "dist");
const destination = join(process.cwd(), "public");
await mkdir(destination, { recursive: true });
await Promise.all(["webtorrent.min.js", "sw.min.js"].map((file) => copyFile(join(source, file), join(destination, file))));
