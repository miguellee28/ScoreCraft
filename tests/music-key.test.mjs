import assert from "node:assert/strict";
import test from "node:test";

import { detectMusicalKey, spellMidi } from "../app/music-key.ts";

const note = (midi, beats = 1, velocity = 90) => ({ midi, beats, velocity });

test("detects major and minor keys from weighted score notes", () => {
  const eFlatMajor = detectMusicalKey([
    note(51, 4), note(55, 2), note(58, 2),
    note(56, 2), note(60, 1), note(63, 1),
    note(58, 3), note(62, 1), note(65, 1), note(51, 4),
  ]);
  assert.equal(eFlatMajor.name, "E♭ major");
  assert.equal(eFlatMajor.fifths, -3);

  const aMinor = detectMusicalKey([
    note(45, 4), note(52, 2), note(57, 3), note(60), note(64),
    note(53), note(59), note(64), note(45, 4),
  ]);
  assert.equal(aMinor.name, "A minor");
});

test("spells notes and accidentals relative to the detected signature", () => {
  const gMajor = { tonic: 7, mode: "major", name: "G major", vexKey: "G", fifths: 1 };
  assert.deepEqual(spellMidi(66, gMajor), {
    vexKey: "f#/4", step: "F", alter: 1, octave: 4, accidental: null,
  });
  assert.equal(spellMidi(65, gMajor).accidental, "n");

  const fSharpMajor = { tonic: 6, mode: "major", name: "F♯ major", vexKey: "F#", fifths: 6 };
  assert.deepEqual(spellMidi(65, fSharpMajor), {
    vexKey: "e#/4", step: "E", alter: 1, octave: 4, accidental: null,
  });
});
