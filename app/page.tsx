import type { Metadata } from "next";
import { ScoreCraft } from "./ScoreCraft";

export const metadata: Metadata = {
  title: "ScoreCraft — Audio to playable sheet music",
  description:
    "Turn recordings and YouTube performances into editable, playable multi-instrument scores.",
};

export default function Home() {
  return <ScoreCraft />;
}
