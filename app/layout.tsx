import type { Metadata } from "next";
import "./globals.css";

const metadataBase = new URL("https://scorecraft.example");

export const metadata: Metadata = {
  metadataBase,
  title: "ScoreCraft — Audio to playable sheet music",
  description: "Turn piano recordings and Synthesia videos into editable grand-staff sheet music.",
  icons: { icon: "/favicon.svg" },
  openGraph: {
    title: "ScoreCraft",
    description: "Turn piano audio into playable grand-staff sheet music.",
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "ScoreCraft",
    description: "Turn piano audio into playable grand-staff sheet music.",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
