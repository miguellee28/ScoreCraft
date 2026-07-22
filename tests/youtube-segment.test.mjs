import assert from "node:assert/strict";
import test from "node:test";
import { canonicalYouTubeUrl, normalizeYouTubeSegment } from "../local-youtube-plugin.ts";

test("canonicalizes a YouTube watch URL without playlist or radio parameters", () => {
  assert.equal(
    canonicalYouTubeUrl("https://www.youtube.com/watch?v=Pfknw2I7H9U&list=RDPfknw2I7H9U&start_radio=1"),
    "https://www.youtube.com/watch?v=Pfknw2I7H9U",
  );
});

test("normalizes explicit and automatic YouTube transcription ranges", () => {
  assert.deepEqual(normalizeYouTubeSegment(30, 90, 180), { start: 30, end: 90 });
  assert.deepEqual(normalizeYouTubeSegment(30, undefined, 180), { start: 30, end: 180 });
  assert.deepEqual(normalizeYouTubeSegment(120, undefined, 600), { start: 120, end: 420 });
});

test("rejects invalid or oversized YouTube transcription ranges", () => {
  assert.throws(() => normalizeYouTubeSegment(90, 30, 180), /after the start/);
  assert.throws(() => normalizeYouTubeSegment(0, 301, 600), /5 minutes/);
  assert.throws(() => normalizeYouTubeSegment(190, undefined, 180), /video ends/);
  assert.throws(() => normalizeYouTubeSegment(0, 181, 180), /video ends/);
});
