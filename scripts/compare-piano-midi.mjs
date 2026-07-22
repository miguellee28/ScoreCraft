import { readFile } from "node:fs/promises";
import toneMidi from "@tonejs/midi";
import { makePianoScorePlayable, quantizePianoEvents } from "../app/piano-timing.ts";

const [predictedPath, referencePath, durationHintsPath] = process.argv.slice(2);
if (!predictedPath || !referencePath) {
  console.error("Usage: npm run compare:midi -- <transcribed.mid> <reference.mid> [browser-duration-hints.json]");
  process.exit(2);
}

const { Midi } = toneMidi;
const predictedMidi = new Midi(await readFile(predictedPath));
const referenceMidi = new Midi(await readFile(referencePath));
const tempo = referenceMidi.header.tempos[0]?.bpm ?? 120;
const predictedEvents = predictedMidi.tracks.flatMap((track) => track.notes).map((note) => ({
  midi: note.midi,
  startSeconds: note.time,
  durationSeconds: note.duration,
  velocity: Math.max(1, Math.min(127, Math.round(note.velocity * 127))),
}));
const durationHints = durationHintsPath
  ? (JSON.parse(await readFile(durationHintsPath, "utf8")).notes ?? [])
  : [];
const predicted = quantizePianoEvents(predictedEvents, tempo, "transkun-2.0.1");
const playableScore = makePianoScorePlayable(predicted);
const reference = referenceMidi.tracks.flatMap((track) => track.notes).map((note, id) => ({
  id,
  midi: note.midi,
  startBeat: note.ticks / referenceMidi.header.ppq,
  beats: note.durationTicks / referenceMidi.header.ppq,
  velocity: Math.max(1, Math.min(127, Math.round(note.velocity * 127))),
}));

const used = new Set();
let onsetMatches = 0;
let durationMatches = 0;
let velocityMatches = 0;
for (const note of predicted) {
  const match = reference.find((candidate) => (
    !used.has(candidate.id)
    && candidate.midi === note.midi
    && Math.abs(candidate.startBeat - note.startBeat) < 1e-8
  ));
  if (!match) continue;
  used.add(match.id);
  onsetMatches += 1;
  if (Math.abs(match.beats - note.beats) < 1e-8) durationMatches += 1;
  if (match.velocity === note.velocity) velocityMatches += 1;
}

const f1 = (matches) => {
  const precision = matches / Math.max(1, predicted.length);
  const recall = matches / Math.max(1, reference.length);
  return 2 * precision * recall / Math.max(Number.EPSILON, precision + recall);
};
const result = {
  tempo,
  predictedNotes: predicted.length,
  referenceNotes: reference.length,
  pitchAndOnsetMatches: onsetMatches,
  pitchAndOnsetF1: f1(onsetMatches),
  exactDurationMatches: durationMatches,
  exactDurationF1: f1(durationMatches),
  exactVelocityMatches: velocityMatches,
  durationHints: durationHints.length,
  playableScoreNotes: playableScore.length,
  playableMaximumHandSpan: Math.max(0, ...[...new Set(playableScore.map((note) => `${note.startBeat}:${note.staff}`))]
    .map((key) => {
      const group = playableScore.filter((note) => `${note.startBeat}:${note.staff}` === key);
      return Math.max(...group.map((note) => note.midi)) - Math.min(...group.map((note) => note.midi));
    })),
  playableMaximumNotesPerHand: Math.max(0, ...[...new Set(playableScore.map((note) => `${note.startBeat}:${note.staff}`))]
    .map((key) => playableScore.filter((note) => `${note.startBeat}:${note.staff}` === key).length)),
};
console.log(JSON.stringify(result, null, 2));
if (onsetMatches !== predicted.length || onsetMatches !== reference.length) process.exitCode = 1;
