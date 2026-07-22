export type KeyDetectionNote = {
  midi: number;
  beats: number;
  velocity?: number;
};

export type MusicalKey = {
  tonic: number;
  mode: "major" | "minor";
  name: string;
  vexKey: string;
  fifths: number;
};

export type SpelledPitch = {
  vexKey: string;
  step: string;
  alter: number;
  octave: number;
  accidental: "#" | "b" | "n" | null;
};

const majorKeyProfile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const minorKeyProfile = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const keyChoices: MusicalKey[] = [
  { tonic: 0, mode: "major", name: "C major", vexKey: "C", fifths: 0 },
  { tonic: 1, mode: "major", name: "D♭ major", vexKey: "Db", fifths: -5 },
  { tonic: 2, mode: "major", name: "D major", vexKey: "D", fifths: 2 },
  { tonic: 3, mode: "major", name: "E♭ major", vexKey: "Eb", fifths: -3 },
  { tonic: 4, mode: "major", name: "E major", vexKey: "E", fifths: 4 },
  { tonic: 5, mode: "major", name: "F major", vexKey: "F", fifths: -1 },
  { tonic: 6, mode: "major", name: "F♯ major", vexKey: "F#", fifths: 6 },
  { tonic: 7, mode: "major", name: "G major", vexKey: "G", fifths: 1 },
  { tonic: 8, mode: "major", name: "A♭ major", vexKey: "Ab", fifths: -4 },
  { tonic: 9, mode: "major", name: "A major", vexKey: "A", fifths: 3 },
  { tonic: 10, mode: "major", name: "B♭ major", vexKey: "Bb", fifths: -2 },
  { tonic: 11, mode: "major", name: "B major", vexKey: "B", fifths: 5 },
  { tonic: 0, mode: "minor", name: "C minor", vexKey: "Cm", fifths: -3 },
  { tonic: 1, mode: "minor", name: "C♯ minor", vexKey: "C#m", fifths: 4 },
  { tonic: 2, mode: "minor", name: "D minor", vexKey: "Dm", fifths: -1 },
  { tonic: 3, mode: "minor", name: "E♭ minor", vexKey: "Ebm", fifths: -6 },
  { tonic: 4, mode: "minor", name: "E minor", vexKey: "Em", fifths: 1 },
  { tonic: 5, mode: "minor", name: "F minor", vexKey: "Fm", fifths: -4 },
  { tonic: 6, mode: "minor", name: "F♯ minor", vexKey: "F#m", fifths: 3 },
  { tonic: 7, mode: "minor", name: "G minor", vexKey: "Gm", fifths: -2 },
  { tonic: 8, mode: "minor", name: "G♯ minor", vexKey: "G#m", fifths: 5 },
  { tonic: 9, mode: "minor", name: "A minor", vexKey: "Am", fifths: 0 },
  { tonic: 10, mode: "minor", name: "B♭ minor", vexKey: "Bbm", fifths: -5 },
  { tonic: 11, mode: "minor", name: "B minor", vexKey: "Bm", fifths: 2 },
];

const letters = ["C", "D", "E", "F", "G", "A", "B"] as const;
const naturalPitchClasses = new Map<string, number>([["C", 0], ["D", 2], ["E", 4], ["F", 5], ["G", 7], ["A", 9], ["B", 11]]);
const sharpOrder = ["F", "C", "G", "D", "A", "E", "B"];
const flatOrder = ["B", "E", "A", "D", "G", "C", "F"];

function pitchClass(midi: number) {
  return ((midi % 12) + 12) % 12;
}

function signatureAlterations(fifths: number) {
  const alterations = new Map<string, number>();
  if (fifths > 0) sharpOrder.slice(0, fifths).forEach((letter) => alterations.set(letter, 1));
  if (fifths < 0) flatOrder.slice(0, -fifths).forEach((letter) => alterations.set(letter, -1));
  return alterations;
}

export function detectMusicalKey(notes: KeyDetectionNote[]): MusicalKey {
  if (!notes.length) return keyChoices[0];
  const histogram = Array.from({ length: 12 }, () => 0);
  notes.forEach((note) => {
    const weight = Math.max(0.125, Math.min(4, note.beats)) * ((note.velocity ?? 80) / 127) * (note.midi < 60 ? 1.2 : 1);
    histogram[pitchClass(note.midi)] += weight;
  });

  return keyChoices.reduce((best, candidate) => {
    const profile = candidate.mode === "minor" ? minorKeyProfile : majorKeyProfile;
    const score = histogram.reduce((sum, weight, notePitchClass) => (
      sum + weight * profile[(notePitchClass - candidate.tonic + 12) % 12]
    ), 0);
    const bestProfile = best.mode === "minor" ? minorKeyProfile : majorKeyProfile;
    const bestScore = histogram.reduce((sum, weight, notePitchClass) => (
      sum + weight * bestProfile[(notePitchClass - best.tonic + 12) % 12]
    ), 0);
    return score > bestScore ? candidate : best;
  }, keyChoices[0]);
}

export function spellMidi(midi: number, key: MusicalKey): SpelledPitch {
  const targetPitchClass = pitchClass(midi);
  const signature = signatureAlterations(key.fifths);
  let step = letters.find((letter) => {
    const natural = naturalPitchClasses.get(letter) ?? 0;
    return (natural + (signature.get(letter) ?? 0) + 12) % 12 === targetPitchClass;
  });
  let alter = step ? (signature.get(step) ?? 0) : 0;

  if (!step) {
    const sharpSpellings = [["C", 0], ["C", 1], ["D", 0], ["D", 1], ["E", 0], ["F", 0], ["F", 1], ["G", 0], ["G", 1], ["A", 0], ["A", 1], ["B", 0]] as const;
    const flatSpellings = [["C", 0], ["D", -1], ["D", 0], ["E", -1], ["E", 0], ["F", 0], ["G", -1], ["G", 0], ["A", -1], ["A", 0], ["B", -1], ["B", 0]] as const;
    [step, alter] = (key.fifths < 0 ? flatSpellings : sharpSpellings)[targetPitchClass];
  }

  const natural = naturalPitchClasses.get(step) ?? 0;
  const octave = (midi - natural - alter) / 12 - 1;
  const signatureAlter = signature.get(step) ?? 0;
  const accidental = signatureAlter === alter ? null : alter === 0 ? "n" : alter > 0 ? "#" : "b";
  const vexAccidental = alter > 0 ? "#" : alter < 0 ? "b" : "";
  return {
    vexKey: `${step.toLowerCase()}${vexAccidental}/${octave}`,
    step,
    alter,
    octave,
    accidental,
  };
}
