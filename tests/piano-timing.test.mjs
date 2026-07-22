import assert from "node:assert/strict";
import test from "node:test";
import {
  PIANO_TICK_BEATS,
  makePianoScorePlayable,
  mergePianoDurationHints,
  quantizeBeat,
  quantizePianoEvents,
  quantizeTranskunDuration,
  repairRolledChordDurations,
  repairScoreContextDurations,
} from "../app/piano-timing.ts";

test("preserves 64th-note piano timing without onset collisions", () => {
  assert.equal(PIANO_TICK_BEATS, 0.0625);
  assert.equal(quantizeBeat(0.061), 0.0625);
  assert.equal(quantizeBeat(0.126), 0.125);
  assert.notEqual(quantizeBeat(0.061), quantizeBeat(0.126));
});

test("repairs systematic Transkun offsets and keeps fine pickup endings", () => {
  assert.equal(quantizeTranskunDuration(0.85, 4), 1);
  assert.equal(quantizeTranskunDuration(0.35, 4), 0.5);
  assert.equal(quantizeTranskunDuration(1.42, 4.0625), 1.4375);
  assert.equal(quantizeTranskunDuration(1.86, 4.125), 1.875);
});

test("uses the first detected note as zero while retaining raw playback seconds", () => {
  const secondsPerBeat = 60 / 55;
  const events = [
    { midi: 60, startSeconds: 0.03125, durationSeconds: 0.85 * secondsPerBeat, velocity: 80 },
    { midi: 62, startSeconds: 0.03125 + 0.0625 * secondsPerBeat, durationSeconds: 1.42 * secondsPerBeat, velocity: 82 },
  ];
  const notes = quantizePianoEvents(events, 55, "transkun-2.0.1");
  assert.deepEqual(notes.map((note) => note.startBeat), [0, 0.0625]);
  assert.deepEqual(notes.map((note) => note.beats), [1, 1.4375]);
  assert.equal(notes[1].startSeconds, events[1].startSeconds);
  assert.equal(notes[1].durationSeconds, events[1].durationSeconds);
});

test("gives short rolled chords a shared endpoint without flattening long layered voices", () => {
  const shortRoll = repairRolledChordDurations([
    { startBeat: 94.5, beats: .75 },
    { startBeat: 94.5, beats: 1 },
    { startBeat: 94.5, beats: 1 },
    { startBeat: 94.5625, beats: 1.4375 },
    { startBeat: 94.625, beats: 1.375 },
  ]);
  assert.deepEqual(shortRoll.map((note) => note.startBeat + note.beats), [96, 96, 96, 96, 96]);

  const layeredRoll = repairRolledChordDurations([
    { startBeat: 60, beats: 4 },
    { startBeat: 60, beats: 3 },
    { startBeat: 60, beats: 4 },
    { startBeat: 60.0625, beats: 2.9375 },
    { startBeat: 60.125, beats: 2.875 },
  ]);
  assert.deepEqual(layeredRoll.map((note) => note.beats), [4, 3, 4, 2.9375, 2.875]);
});

test("uses the frame model only for conservative high-confidence release hints", () => {
  const secondsPerBeat = 60 / 55;
  const primary = [
    { midi: 50, sourceIndex: 0, startBeat: 0, beats: .25, startSeconds: .03, durationSeconds: .22 * secondsPerBeat, velocity: 80 },
    { midi: 50, sourceIndex: 1, startBeat: .5, beats: .25, startSeconds: .03 + .5 * secondsPerBeat, durationSeconds: .22 * secondsPerBeat, velocity: 80 },
    { midi: 62, sourceIndex: 2, startBeat: 1, beats: .75, startSeconds: .03 + secondsPerBeat, durationSeconds: .76 * secondsPerBeat, velocity: 80 },
  ];
  const hints = [
    { midi: 50, startSeconds: .04, durationSeconds: .5 * secondsPerBeat, velocity: 70 },
    { midi: 50, startSeconds: .04 + .5 * secondsPerBeat, durationSeconds: .5 * secondsPerBeat, velocity: 70 },
    { midi: 62, startSeconds: .04 + secondsPerBeat, durationSeconds: 1 * secondsPerBeat, velocity: 70 },
  ];
  const merged = mergePianoDurationHints(primary, hints, 55);
  assert.deepEqual(merged.map((note) => note.beats), [.5, .25, 1]);
});

test("repairs chord and repeated-section durations from score context", () => {
  const secondsPerBeat = 60 / 55;
  const note = (midi, sourceIndex, startBeat, beats, rawBeats = beats) => ({
    midi, sourceIndex, startBeat, beats,
    startSeconds: startBeat * secondsPerBeat,
    durationSeconds: rawBeats * secondsPerBeat,
    velocity: 80,
  });
  const repairedChord = repairScoreContextDurations([
    note(41, 0, 14, 2, 1.98),
    note(33, 1, 14, 2, 1.98),
    note(29, 2, 14, 2, 1.98),
    note(53, 3, 14, 1.25, 1.09),
  ], 55);
  assert.deepEqual(repairedChord.map((event) => event.beats), [2, 2, 2, 2]);

  const layeredChord = repairScoreContextDurations([
    note(43, 0, 60, 4, 4),
    note(31, 1, 60, 4, 4),
    note(58, 2, 60, 3, 3),
  ], 55);
  assert.deepEqual(layeredChord.map((event) => event.beats), [4, 4, 3]);
});

test("holds sparse melodic pickups until their structural release", () => {
  const secondsPerBeat = 60 / 55;
  const note = (midi, sourceIndex, startBeat, beats, rawBeats = beats) => ({
    midi, sourceIndex, startBeat, beats,
    startSeconds: startBeat * secondsPerBeat,
    durationSeconds: rawBeats * secondsPerBeat,
    velocity: 80,
  });
  const repaired = repairScoreContextDurations([
    note(77, 0, 0, .25, .22),
    note(46, 1, .25, .25, .22),
    note(77, 2, .5, .25, .22),
    note(69, 3, 2, .25, .11),
    note(63, 4, 3, .25, .22),
  ], 55);
  assert.equal(repaired[0].beats, .5);
  assert.equal(repaired[3].beats, .5);
});

test("reduces pedal-heavy transcription to a playable two-hand score", () => {
  const notes = [
    { midi: 48, startBeat: 0, beats: 4, velocity: 90 },
    { midi: 55, startBeat: 0, beats: 2, velocity: 76 },
    { midi: 60, startBeat: 0, beats: 1, velocity: 82 },
    { midi: 40, startBeat: .5, beats: 3, velocity: 88 },
    { midi: 57, startBeat: .5, beats: 1, velocity: 78 },
    { midi: 64, startBeat: .5, beats: 1, velocity: 84 },
  ];
  const playable = makePianoScorePlayable(notes);

  assert.ok(playable.every((note) => Number.isInteger(note.startBeat * 4)));
  const groups = new Map();
  playable.forEach((note) => {
    const key = `${note.startBeat}:${note.staff}`;
    groups.set(key, [...(groups.get(key) ?? []), note]);
  });
  groups.forEach((group) => {
    assert.ok(group.length <= 5);
    assert.ok(Math.max(...group.map((note) => note.midi)) - Math.min(...group.map((note) => note.midi)) <= 12);
    assert.ok(group.every((note) => note.beats === group[0].beats));
  });
  assert.equal(playable.find((note) => note.midi === 48)?.staff, 2);
  assert.equal(playable.find((note) => note.midi === 55)?.staff, 2);
  assert.equal(playable.find((note) => note.midi === 60)?.staff, 1);
  assert.equal(playable.find((note) => note.midi === 48)?.beats, .5);
});
