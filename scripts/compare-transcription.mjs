import { readFile, writeFile } from "node:fs/promises";
import toneMidi from "@tonejs/midi";

const { Midi } = toneMidi;
const [transcriptionPath, midiPath, reportPath = "tmp/transcription-comparison.json"] = process.argv.slice(2);
if (!transcriptionPath || !midiPath) {
  throw new Error("Usage: node scripts/compare-transcription.mjs <transcription.json> <reference.mid> [report.json]");
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function matchNotes(predicted, reference, offsetSeconds, toleranceSeconds) {
  const referenceByPitch = new Map();
  reference.forEach((note, index) => referenceByPitch.set(note.midi, [
    ...(referenceByPitch.get(note.midi) ?? []),
    { ...note, referenceIndex: index },
  ]));
  const usedReference = new Set();
  const matches = [];
  const falsePositiveIndexes = [];
  predicted.forEach((note, predictedIndex) => {
    const candidates = referenceByPitch.get(note.midi) ?? [];
    let best = null;
    let bestError = Number.POSITIVE_INFINITY;
    candidates.forEach((candidate) => {
      if (usedReference.has(candidate.referenceIndex)) return;
      const onsetError = Math.abs(note.startSeconds + offsetSeconds - candidate.startSeconds);
      if (onsetError <= toleranceSeconds && onsetError < bestError) {
        best = candidate;
        bestError = onsetError;
      }
    });
    if (best) {
      usedReference.add(best.referenceIndex);
      matches.push({ predictedIndex, referenceIndex: best.referenceIndex, onsetError: bestError });
    } else falsePositiveIndexes.push(predictedIndex);
  });
  const falseNegativeIndexes = reference
    .map((_, index) => index)
    .filter((index) => !usedReference.has(index));
  const precision = matches.length / Math.max(1, predicted.length);
  const recall = matches.length / Math.max(1, reference.length);
  const f1 = 2 * precision * recall / Math.max(1e-9, precision + recall);
  return { matches, falsePositiveIndexes, falseNegativeIndexes, precision, recall, f1 };
}

function histogram(notes, indexes) {
  const counts = new Map();
  indexes.forEach((index) => counts.set(notes[index].midi, (counts.get(notes[index].midi) ?? 0) + 1));
  return [...counts.entries()]
    .map(([midi, count]) => ({ midi, count }))
    .sort((a, b) => b.count - a.count || a.midi - b.midi)
    .slice(0, 20);
}

const transcription = JSON.parse(await readFile(transcriptionPath, "utf8"));
const predicted = transcription.notes
  .map((note) => ({
    midi: note.midi,
    startSeconds: note.startSeconds,
    durationSeconds: note.durationSeconds,
    velocity: note.velocity,
  }))
  .sort((a, b) => a.startSeconds - b.startSeconds || a.midi - b.midi);
const secondsPerBeat = 60 / transcription.tempo;
const scoreOriginSeconds = Math.min(...transcription.notes
  .filter((note) => (note.velocity ?? 127) >= 52 && (note.durationSeconds ?? 0) >= 0.1)
  .map((note) => note.startSeconds));
const gridPredicted = transcription.notes
  .map((note) => ({
    midi: note.midi,
    startSeconds: scoreOriginSeconds + note.startBeat * secondsPerBeat,
    durationSeconds: note.beats * secondsPerBeat,
    velocity: note.velocity,
  }))
  .sort((a, b) => a.startSeconds - b.startSeconds || a.midi - b.midi);
const midi = new Midi(await readFile(midiPath));
const reference = midi.tracks
  .filter((track) => track.channel !== 9)
  .flatMap((track) => track.notes.map((note) => ({
    midi: note.midi,
    startSeconds: note.time,
    durationSeconds: note.duration,
    velocity: Math.round(note.velocity * 127),
  })))
  .sort((a, b) => a.startSeconds - b.startSeconds || a.midi - b.midi);

function findBestOffset(notes, toleranceSeconds, centerSeconds = 0, radiusSeconds = 1.5) {
  let bestOffsetSeconds = 0;
  let bestResult = { f1: -1 };
  const start = centerSeconds - radiusSeconds;
  const end = centerSeconds + radiusSeconds;
  for (let offset = start; offset <= end; offset += 0.005) {
    const result = matchNotes(notes, reference, offset, toleranceSeconds);
    if (result.f1 > bestResult.f1) {
      bestResult = result;
      bestOffsetSeconds = Number(offset.toFixed(3));
    }
  }
  return { offsetSeconds: bestOffsetSeconds, result: bestResult };
}

const strictFit = findBestOffset(predicted, 0.05);
const looseFit = findBestOffset(predicted, 0.1);
const broadFit = findBestOffset(predicted, 0.2);
const strict = strictFit.result;
const loose = looseFit.result;
const broad = broadFit.result;
const durationErrors = loose.matches.map(({ predictedIndex, referenceIndex }) => (
  Math.abs(predicted[predictedIndex].durationSeconds - reference[referenceIndex].durationSeconds)
));
const durationIous = loose.matches.map(({ predictedIndex, referenceIndex }) => {
  const note = predicted[predictedIndex];
  const ref = reference[referenceIndex];
  const predictedStart = note.startSeconds + looseFit.offsetSeconds;
  const predictedEnd = predictedStart + note.durationSeconds;
  const referenceEnd = ref.startSeconds + ref.durationSeconds;
  const intersection = Math.max(0, Math.min(predictedEnd, referenceEnd) - Math.max(predictedStart, ref.startSeconds));
  const union = Math.max(predictedEnd, referenceEnd) - Math.min(predictedStart, ref.startSeconds);
  return intersection / Math.max(1e-9, union);
});

const report = {
  detectedTempo: transcription.tempo,
  midiTempo: midi.header.tempos,
  predictedNotes: predicted.length,
  referenceNotes: reference.length,
  bestOffsetSeconds50ms: strictFit.offsetSeconds,
  bestOffsetSeconds100ms: looseFit.offsetSeconds,
  precision50ms: strict.precision,
  recall50ms: strict.recall,
  f1_50ms: strict.f1,
  precision100ms: loose.precision,
  recall100ms: loose.recall,
  f1_100ms: loose.f1,
  f1_200ms: broad.f1,
  matches100ms: loose.matches.length,
  falsePositives100ms: loose.falsePositiveIndexes.length,
  falseNegatives100ms: loose.falseNegativeIndexes.length,
  medianOnsetErrorSeconds: median(loose.matches.map((match) => match.onsetError)),
  medianDurationErrorSeconds: median(durationErrors),
  medianDurationIoU: median(durationIous),
  mostCommonFalsePositivePitches: histogram(predicted, loose.falsePositiveIndexes),
  mostCommonMissedPitches: histogram(reference, loose.falseNegativeIndexes),
};

const gridLooseFit = findBestOffset(gridPredicted, 0.1);
const gridStrictFit = findBestOffset(gridPredicted, 0.05);
const gridLoose = gridLooseFit.result;
const gridStrict = gridStrictFit.result;
report.scoreGrid = {
  scoreOriginSeconds,
  bestOffsetSeconds50ms: gridStrictFit.offsetSeconds,
  bestOffsetSeconds100ms: gridLooseFit.offsetSeconds,
  matches100ms: gridLoose.matches.length,
  precision100ms: gridLoose.precision,
  recall100ms: gridLoose.recall,
  f1_100ms: gridLoose.f1,
  f1_50ms: gridStrict.f1,
  falsePositives100ms: gridLoose.falsePositiveIndexes.length,
  falseNegatives100ms: gridLoose.falseNegativeIndexes.length,
  medianOnsetErrorSeconds: median(gridLoose.matches.map((match) => match.onsetError)),
};

const postFilters = [];
for (const shortDurationSeconds of [0.15, 0.25, 0.35, 0.5, 0.75]) {
  for (const shortNoteMinimumVelocity of [40, 45, 50, 55, 60, 65, 70]) {
    const filtered = predicted.filter((note) => (
      note.durationSeconds >= shortDurationSeconds
      || note.velocity >= shortNoteMinimumVelocity
    ));
    // Filtering cannot materially move the model's global timing offset, so a
    // narrow search around the unfiltered fit makes large sweeps repeatable.
    const strictFiltered = findBestOffset(filtered, 0.05, strictFit.offsetSeconds, 0.03);
    const looseFiltered = findBestOffset(filtered, 0.1, looseFit.offsetSeconds, 0.03);
    postFilters.push({
      shortDurationSeconds,
      shortNoteMinimumVelocity,
      predictedNotes: filtered.length,
      offsetSeconds50ms: strictFiltered.offsetSeconds,
      f1_50ms: strictFiltered.result.f1,
      precision50ms: strictFiltered.result.precision,
      recall50ms: strictFiltered.result.recall,
      f1_100ms: looseFiltered.result.f1,
      precision100ms: looseFiltered.result.precision,
      recall100ms: looseFiltered.result.recall,
    });
  }
}
postFilters.sort((a, b) => b.f1_50ms - a.f1_50ms || b.f1_100ms - a.f1_100ms);
report.bestPostFilters = postFilters.slice(0, 15);

function rearticulateAtEnsembleOnsets(notes, {
  minimumSegmentSeconds,
  onsetWindowSeconds,
  minimumOtherPitches,
}) {
  return notes.flatMap((note, noteIndex) => {
    if (note.durationSeconds < minimumSegmentSeconds * 2) return [note];
    const endSeconds = note.startSeconds + note.durationSeconds;
    const candidates = notes
      .filter((other, otherIndex) => (
        otherIndex !== noteIndex
        && other.midi !== note.midi
        && other.velocity >= 55
        && other.startSeconds >= note.startSeconds + minimumSegmentSeconds
        && other.startSeconds <= endSeconds - minimumSegmentSeconds
      ))
      .sort((a, b) => a.startSeconds - b.startSeconds);
    const clusters = [];
    candidates.forEach((candidate) => {
      const cluster = clusters[clusters.length - 1];
      if (!cluster || candidate.startSeconds - cluster.center > onsetWindowSeconds) {
        clusters.push({ center: candidate.startSeconds, pitches: new Set([candidate.midi]) });
      } else {
        cluster.pitches.add(candidate.midi);
        cluster.center = (cluster.center + candidate.startSeconds) / 2;
      }
    });
    const cuts = clusters
      .filter((cluster) => cluster.pitches.size >= minimumOtherPitches)
      .map((cluster) => cluster.center)
      .filter((cut, index, all) => index === 0 || cut - all[index - 1] >= minimumSegmentSeconds);
    if (!cuts.length) return [note];
    const boundaries = [note.startSeconds, ...cuts, endSeconds];
    return boundaries.slice(0, -1).map((startSeconds, index) => ({
      ...note,
      startSeconds,
      durationSeconds: boundaries[index + 1] - startSeconds,
      velocity: index === 0 ? note.velocity : Math.max(55, Math.round(note.velocity * 0.9)),
    }));
  }).sort((a, b) => a.startSeconds - b.startSeconds || a.midi - b.midi);
}

const rearticulationSweep = [];
for (const filter of report.bestPostFilters.slice(0, 6)) {
  const filtered = predicted.filter((note) => (
    note.durationSeconds >= filter.shortDurationSeconds
    || note.velocity >= filter.shortNoteMinimumVelocity
  ));
  for (const minimumSegmentBeats of [0.3, 0.45, 0.6, 0.8]) {
    for (const onsetWindowSeconds of [0.06, 0.1, 0.14]) {
      for (const minimumOtherPitches of [2, 3, 4]) {
        const repaired = rearticulateAtEnsembleOnsets(filtered, {
          minimumSegmentSeconds: minimumSegmentBeats * secondsPerBeat,
          onsetWindowSeconds,
          minimumOtherPitches,
        });
        const strictRepaired = findBestOffset(repaired, 0.05, strictFit.offsetSeconds, 0.03);
        const looseRepaired = findBestOffset(repaired, 0.1, looseFit.offsetSeconds, 0.03);
        rearticulationSweep.push({
          shortDurationSeconds: filter.shortDurationSeconds,
          shortNoteMinimumVelocity: filter.shortNoteMinimumVelocity,
          minimumSegmentBeats,
          onsetWindowSeconds,
          minimumOtherPitches,
          predictedNotes: repaired.length,
          f1_50ms: strictRepaired.result.f1,
          precision50ms: strictRepaired.result.precision,
          recall50ms: strictRepaired.result.recall,
          f1_100ms: looseRepaired.result.f1,
          precision100ms: looseRepaired.result.precision,
          recall100ms: looseRepaired.result.recall,
        });
      }
    }
  }
}
rearticulationSweep.sort((a, b) => b.f1_50ms - a.f1_50ms || b.f1_100ms - a.f1_100ms);
report.bestRearticulation = rearticulationSweep.slice(0, 15);

function mergeNearbySamePitch(notes, maximumOnsetDistanceSeconds) {
  const byPitch = new Map();
  notes.forEach((note) => byPitch.set(note.midi, [...(byPitch.get(note.midi) ?? []), note]));
  const merged = [];
  byPitch.forEach((pitchNotes) => {
    const kept = [];
    pitchNotes
      .sort((a, b) => a.startSeconds - b.startSeconds || b.velocity - a.velocity)
      .forEach((note) => {
        const previous = kept[kept.length - 1];
        if (!previous) {
          kept.push({ ...note });
          return;
        }
        const previousEnd = previous.startSeconds + previous.durationSeconds;
        const onsetDistance = note.startSeconds - previous.startSeconds;
        const gap = note.startSeconds - previousEnd;
        const weakContinuation = gap <= 0.05 && note.velocity <= previous.velocity * 0.9;
        const overlappingArtifact = note.startSeconds < previousEnd && note.velocity <= previous.velocity * 1.12;
        if (onsetDistance <= maximumOnsetDistanceSeconds && (weakContinuation || overlappingArtifact)) {
          previous.durationSeconds = Math.max(previousEnd, note.startSeconds + note.durationSeconds) - previous.startSeconds;
          previous.velocity = Math.max(previous.velocity, note.velocity);
          return;
        }
        if (note.startSeconds < previousEnd) {
          previous.durationSeconds = Math.max(0.08, note.startSeconds - previous.startSeconds - 0.015);
        }
        kept.push({ ...note });
      });
    merged.push(...kept);
  });
  return merged.sort((a, b) => a.startSeconds - b.startSeconds || a.midi - b.midi);
}

report.samePitchMergeSweep = [
  0.1,
  0.15,
  0.2,
  0.25,
  0.35,
  0.5,
  0.75,
  0.92 * secondsPerBeat,
  1,
  1.5,
  2,
  3,
  10,
]
  .map((maximumOnsetDistanceSeconds) => {
    const merged = mergeNearbySamePitch(predicted, maximumOnsetDistanceSeconds);
    const strictMerged = findBestOffset(merged, 0.05, strictFit.offsetSeconds, 0.03);
    const looseMerged = findBestOffset(merged, 0.1, looseFit.offsetSeconds, 0.03);
    return {
      maximumOnsetDistanceSeconds,
      predictedNotes: merged.length,
      f1_50ms: strictMerged.result.f1,
      precision50ms: strictMerged.result.precision,
      recall50ms: strictMerged.result.recall,
      f1_100ms: looseMerged.result.f1,
      precision100ms: looseMerged.result.precision,
      recall100ms: looseMerged.result.recall,
    };
  })
  .sort((a, b) => b.f1_50ms - a.f1_50ms || b.f1_100ms - a.f1_100ms);
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
