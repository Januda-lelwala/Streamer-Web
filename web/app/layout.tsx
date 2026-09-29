import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Streamer — web",
  description: "Search torrents and stream video through a connected torrent backend.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
