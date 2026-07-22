import assert from "node:assert/strict";
import test from "node:test";
import { normalizeYouTubeSegment } from "../local-youtube-plugin.ts";

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
