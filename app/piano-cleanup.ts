export type CleanupNote = {
  midi: number;
  startBeat: number;
  beats: number;
  velocity?: number;
  chord?: string;
};

type HarmonyChord = { root: number; tones: Set<number>; label: string };

const HARMONY_WINDOW_BEATS = 1;
const harmonyPitchNames = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
const majorKeyProfile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const minorKeyProfile = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pitchClass(midi: number) {
  return ((midi % 12) + 12) % 12;
}

function inferChordProgression(notes: CleanupNote[]) {
  const histogram = Array.from({ length: 12 }, () => 0);
  notes.forEach((note) => {
    histogram[pitchClass(note.midi)] += ((note.velocity ?? 64) / 127) * Math.min(2, note.beats);
  });
  let tonic = 0;
  let minor = false;
  let keyScore = Number.NEGATIVE_INFINITY;
  for (let candidate = 0; candidate < 12; candidate += 1) {
    for (const mode of [false, true]) {
      const profile = mode ? minorKeyProfile : majorKeyProfile;
      const score = histogram.reduce((sum, weight, notePitchClass) => (
        sum + weight * profile[(notePitchClass - candidate + 12) % 12]
      ), 0);
      if (score > keyScore) {
        tonic = candidate;
        minor = mode;
        keyScore = score;
      }
    }
  }

  const scale = minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  const candidates: HarmonyChord[] = scale.map((interval, degree) => {
    const root = (tonic + interval) % 12;
    const third = (tonic + scale[(degree + 2) % 7] + (degree + 2 >= 7 ? 12 : 0) - (tonic + interval) + 12) % 12;
    const fifth = (tonic + scale[(degree + 4) % 7] + (degree + 4 >= 7 ? 12 : 0) - (tonic + interval) + 12) % 12;
    const quality = fifth === 6 ? "dim" : third === 3 ? "m" : "";
    return {
      root,
      tones: new Set([root, (root + third) % 12, (root + fifth) % 12]),
      label: `${harmonyPitchNames[root]}${quality}`,
    };
  });

  const windowCount = Math.max(1, Math.ceil(Math.max(0, ...notes.map((note) => note.startBeat + note.beats)) / HARMONY_WINDOW_BEATS));
  const emissions = Array.from({ length: windowCount }, (_, window) => candidates.map((chord) => notes
    .filter((note) => note.startBeat >= window * HARMONY_WINDOW_BEATS && note.startBeat < (window + 1) * HARMONY_WINDOW_BEATS)
    .reduce((score, note) => {
      const notePitchClass = pitchClass(note.midi);
      const weight = ((note.velocity ?? 64) / 127) * (note.midi < 60 ? 1.7 : 1);
      if (notePitchClass === chord.root) return score + weight * (note.midi < 60 ? 2.5 : 1.6);
      return score + weight * (chord.tones.has(notePitchClass) ? 1.2 : -0.45);
    }, 0)));

  const scores = emissions.map((row) => row.map(() => Number.NEGATIVE_INFINITY));
  const previous = emissions.map((row) => row.map(() => 0));
  emissions[0].forEach((score, chord) => { scores[0][chord] = score; });
  for (let window = 1; window < windowCount; window += 1) {
    candidates.forEach((chord, chordIndex) => {
      candidates.forEach((prior, priorIndex) => {
        const interval = (chord.root - prior.root + 12) % 12;
        const transition = chordIndex === priorIndex ? 0.25 : [5, 7].includes(interval) ? 0.15 : -0.15;
        const score = scores[window - 1][priorIndex] + emissions[window][chordIndex] + transition;
        if (score > scores[window][chordIndex]) {
          scores[window][chordIndex] = score;
          previous[window][chordIndex] = priorIndex;
        }
      });
    });
  }
  let cursor = scores[windowCount - 1].reduce((best, score, index, row) => score > row[best] ? index : best, 0);
  const progression = Array.from({ length: windowCount }, () => candidates[0]);
  for (let window = windowCount - 1; window >= 0; window -= 1) {
    progression[window] = candidates[cursor];
    cursor = previous[window][cursor];
  }
  for (let window = 1; window < progression.length - 1; window += 1) {
    const prior = progression[window - 1];
    const next = progression[window + 1];
    if (prior.root !== next.root || progression[window].root === prior.root) continue;
    const currentIndex = candidates.indexOf(progression[window]);
    const priorIndex = candidates.indexOf(prior);
    if (emissions[window][currentIndex] - emissions[window][priorIndex] < 0.8) progression[window] = prior;
  }
  return progression;
}

function removeBracketedBassArtifacts<T extends CleanupNote>(notes: T[]) {
  const groups = new Map<number, T[]>();
  notes.forEach((note) => groups.set(note.startBeat, [...(groups.get(note.startBeat) ?? []), note]));
  const chordStarts = [...groups.entries()]
    .filter(([, group]) => group.filter((note) => note.midi < 60).length >= 2)
    .map(([startBeat]) => startBeat)
    .sort((a, b) => a - b);

  return notes.filter((note) => {
    const group = groups.get(note.startBeat) ?? [];
    if (note.midi >= 60 || group.some((groupNote) => groupNote.midi >= 60) || group.length !== 1 || note.beats > 0.5) return true;
    const prior = [...chordStarts].reverse().find((startBeat) => startBeat < note.startBeat);
    const next = chordStarts.find((startBeat) => startBeat > note.startBeat);
    return prior === undefined || next === undefined || note.startBeat - prior > 1 || next - note.startBeat > 1;
  });
}

export function cleanPianoNotes<T extends CleanupNote>(notes: T[]) {
  const unique = new Map<string, T>();
  notes
    .filter((note) => (note.velocity ?? 127) >= 40)
    .forEach((note) => {
      const key = `${note.startBeat}:${note.midi}`;
      const previous = unique.get(key);
      if (!previous || (note.velocity ?? 0) > (previous.velocity ?? 0)) unique.set(key, note);
    });

  const deartifacted = removeBracketedBassArtifacts([...unique.values()]);
  const onsetGroups = new Map<number, T[]>();
  deartifacted.forEach((note) => onsetGroups.set(note.startBeat, [...(onsetGroups.get(note.startBeat) ?? []), note]));
  const progression = inferChordProgression(deartifacted);
  const cleaned = [...onsetGroups.entries()].flatMap(([startBeat, group]) => {
    const chord = progression[Math.min(progression.length - 1, Math.floor(startBeat / HARMONY_WINDOW_BEATS))];
    const treble = group.filter((note) => note.midi >= 60);
    const bass = group.filter((note) => note.midi < 60);
    const melody = [...treble].sort((a, b) => (
      ((b.velocity ?? 0) + (b.midi - 60) * 1.1) - ((a.velocity ?? 0) + (a.midi - 60) * 1.1)
    ))[0];
    const trebleByStrength = [...treble].sort((a, b) => (b.velocity ?? 0) - (a.velocity ?? 0));
    const trebleChordTones = treble
      .filter((note) => chord.tones.has(pitchClass(note.midi)))
      .sort((a, b) => (b.velocity ?? 0) - (a.velocity ?? 0));
    const keptTreble = [melody, ...trebleChordTones, ...trebleByStrength]
      .filter((note): note is T => Boolean(note))
      .filter((note, index, all) => all.indexOf(note) === index)
      .slice(0, 5);
    const bassChordTones = bass
      .filter((note) => chord.tones.has(pitchClass(note.midi)))
      .sort((a, b) => {
        const aRoot = pitchClass(a.midi) === chord.root ? 35 : 0;
        const bRoot = pitchClass(b.midi) === chord.root ? 35 : 0;
        return ((b.velocity ?? 0) + bRoot) - ((a.velocity ?? 0) + aRoot);
      });
    const bassByStrength = [...bass].sort((a, b) => (b.velocity ?? 0) - (a.velocity ?? 0));
    const keptBass = [...bassChordTones, ...bassByStrength]
      .filter((note, index, all) => all.indexOf(note) === index)
      .slice(0, 3);
    return [...keptTreble, ...keptBass];
  }).sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi);

  let previousChord = "";
  progression.forEach((chord, window) => {
    if (chord.label === previousChord) return;
    const windowStart = window * HARMONY_WINDOW_BEATS;
    const firstTreble = cleaned.find((note) => note.midi >= 60 && note.startBeat >= windowStart && note.startBeat < windowStart + HARMONY_WINDOW_BEATS);
    if (firstTreble) {
      firstTreble.chord = chord.label;
      previousChord = chord.label;
    }
  });
  return cleaned;
}
