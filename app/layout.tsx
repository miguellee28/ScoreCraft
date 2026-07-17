import type { Metadata } from "next";
import "./globals.css";

const metadataBase = new URL("https://scorecraft.example");

export const metadata: Metadata = {
  metadataBase,
  title: "ScoreCraft — Audio to playable sheet music",
  description: "Turn any melody into editable, playable multi-instrument sheet music.",
  icons: { icon: "/favicon.svg" },
  openGraph: {
    title: "ScoreCraft",
    description: "Turn any melody into playable sheet music.",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "ScoreCraft",
    description: "Turn any melody into playable sheet music.",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
