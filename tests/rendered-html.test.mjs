import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("renders the ScoreCraft music workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>ScoreCraft/);
  assert.match(html, /Transcribe piano/);
  assert.match(html, /1 grand-staff part/);
  assert.match(html, /Piano AI \+ cleanup/);
  assert.match(html, /Transcribed piano/);
  assert.match(html, /Moonlit Waltz/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/);
});

test("keeps full transcription playback and print-ready piano export", async () => {
  const [component, transcription, youtubePlugin, styles, samples] = await Promise.all([
    readFile(new URL("../app/ScoreCraft.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/piano-transcription.ts", import.meta.url), "utf8"),
    readFile(new URL("../local-youtube-plugin.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readdir(new URL("../public/salamander-piano/", import.meta.url)),
  ]);
  assert.match(component, /Play preserves all/);
  assert.match(component, /\/salamander-piano\/\$\{midi\}\.mp3/);
  assert.match(component, /quantizePianoEvents/);
  assert.match(component, /const audioOrigin = context\.currentTime - startAt/);
  assert.match(component, /pump\(\);/);
  assert.match(component, /elapsedIntoNote \* source\.playbackRate\.value/);
  assert.match(component, /\*\* 1\.7/);
  assert.match(component, /new StaveTie/);
  assert.match(component, /available - engravedDuration <= 0\.25/);
  assert.match(component, /PDF exported: \$\{pdf\.getNumberOfPages\(\)\} A4 pages/);
  assert.match(transcription, /onsetThreshold: 0\.48/);
  assert.match(transcription, /frameThreshold: 0\.33/);
  assert.match(transcription, /function normalizeDetectedNotes/);
  assert.match(youtubePlugin, /const maxDownloadAttempts = 3/);
  assert.match(youtubePlugin, /X-ScoreCraft-Download-Attempt/);
  assert.match(styles, /\.piano-grand-system:nth-child\(4n\)/);
  assert.match(styles, /\/fonts\/bravura\.woff2/);
  assert.equal(samples.filter((name) => name.endsWith(".mp3")).length, 30);
});
