export function mediaInput(hash, index) {
  const port = Number(process.env.PORT) || 3001;
  return {
    url: `http://127.0.0.1:${port}/api/torrents/${hash}/files/${index}`,
    headers: `Authorization: Bearer ${process.env.STREAM_BACKEND_TOKEN}\r\n`,
  };
}
