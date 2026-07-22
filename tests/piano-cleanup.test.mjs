import assert from "node:assert/strict";
import test from "node:test";

import { cleanPianoNotes } from "../app/piano-cleanup.ts";

const note = (midi, startBeat, beats = 1, velocity = 80) => ({ midi, startBeat, beats, velocity });

test("tracks harmony by beat and removes isolated bass false positives", () => {
  const cleaned = cleanPianoNotes([
    note(48, 0), note(52, 0), note(55, 0), note(67, 0),
    note(43, 1), note(47, 1), note(50, 1), note(67, 1),
    note(43, 2), note(47, 2), note(50, 2), note(54, 2), note(67, 2),
    note(36, 2.25, 0.25, 58),
    note(43, 3), note(47, 3), note(50, 3), note(67, 3),
    note(38, 3.5, 0.5, 62),
    note(48, 4), note(52, 4), note(55, 4), note(67, 4),
  ]);

  assert.deepEqual(cleaned.filter((entry) => entry.startBeat === 0 && entry.midi < 60).map((entry) => entry.midi), [48, 52, 55]);
  assert.equal(cleaned.find((entry) => entry.startBeat === 0 && entry.midi >= 60)?.chord, "C");
  assert.equal(cleaned.find((entry) => entry.startBeat === 1 && entry.midi >= 60)?.chord, "G");
  assert.deepEqual(cleaned.filter((entry) => entry.startBeat === 2 && entry.midi < 60).map((entry) => entry.midi), [43, 47, 50]);
  assert.equal(cleaned.some((entry) => entry.startBeat === 2.25 || entry.startBeat === 3.5), false);
});

test("keeps intentional bass passing notes when chord attacks are far apart", () => {
  const cleaned = cleanPianoNotes([
    note(48, 0), note(52, 0), note(55, 0), note(67, 0),
    note(50, 2, 0.5, 70),
    note(48, 4), note(52, 4), note(55, 4), note(67, 4),
  ]);
  assert.equal(cleaned.some((entry) => entry.startBeat === 2 && entry.midi === 50), true);
});
