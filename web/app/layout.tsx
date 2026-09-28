import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Streamer — web",
  description: "Search torrents and stream WebRTC-ready video in your browser.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
