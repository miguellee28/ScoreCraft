"use client";

import {
  ChangeEvent,
  CSSProperties,
  DragEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Note = {
  midi: number;
  startBeat: number;
  beats: number;
  sourceIndex?: number;
  velocity?: number;
  startSeconds?: number;
  durationSeconds?: number;
  chord?: string;
};
type Track = {
  id: number;
  name: string;
  abbreviation: string;
  clef: string;
  color: string;
  notes: Note[];
  volume: number;
  muted: boolean;
  solo: boolean;
};

const TREBLE_CLEF = "\u{1D11E}";
const BASS_CLEF = "\u{1D122}";

const melody = [
  67, 69, 71, 72, 74, 72, 71, 69, 67, 64, 67, 69, 71, 69, 67, 66,
  67, 69, 71, 74, 76, 74, 72, 71, 69, 71, 72, 69, 67, 66, 64, 67,
];

function sequentialNotes(midis: number[]) {
  let startBeat = 0;
  return midis.map((midi, index) => {
    const beats = index % 7 === 6 ? 1 : 0.5;
    const note = { midi, startBeat, beats };
    startBeat += beats;
    return note;
  });
}

type HarmonyChord = { root: number; tones: Set<number>; label: string };

const harmonyPitchNames = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
const majorKeyProfile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const minorKeyProfile = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function inferChordProgression(notes: Note[]) {
  const histogram = Array.from({ length: 12 }, () => 0);
  notes.forEach((note) => {
    histogram[((note.midi % 12) + 12) % 12] += ((note.velocity ?? 64) / 127) * Math.min(2, note.beats);
  });
  let tonic = 0;
  let minor = false;
  let keyScore = Number.NEGATIVE_INFINITY;
  for (let candidate = 0; candidate < 12; candidate += 1) {
    for (const mode of [false, true]) {
      const profile = mode ? minorKeyProfile : majorKeyProfile;
      const score = histogram.reduce((sum, weight, pitchClass) => (
        sum + weight * profile[(pitchClass - candidate + 12) % 12]
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

  const measureCount = Math.max(1, Math.ceil(Math.max(0, ...notes.map((note) => note.startBeat + note.beats)) / 4));
  const emissions = Array.from({ length: measureCount }, (_, measure) => candidates.map((chord) => notes
    .filter((note) => note.startBeat >= measure * 4 && note.startBeat < (measure + 1) * 4)
    .reduce((score, note) => {
      const pitchClass = ((note.midi % 12) + 12) % 12;
      const weight = ((note.velocity ?? 64) / 127) * (note.midi < 60 ? 1.7 : 1);
      if (pitchClass === chord.root) return score + weight * (note.midi < 60 ? 2.5 : 1.6);
      return score + weight * (chord.tones.has(pitchClass) ? 1.2 : -0.45);
    }, 0)));

  const scores = emissions.map((row) => row.map(() => Number.NEGATIVE_INFINITY));
  const previous = emissions.map((row) => row.map(() => 0));
  emissions[0].forEach((score, chord) => { scores[0][chord] = score; });
  for (let measure = 1; measure < measureCount; measure += 1) {
    candidates.forEach((chord, chordIndex) => {
      candidates.forEach((prior, priorIndex) => {
        const interval = (chord.root - prior.root + 12) % 12;
        const transition = chordIndex === priorIndex ? 0.45 : [5, 7].includes(interval) ? 0.25 : -0.2;
        const score = scores[measure - 1][priorIndex] + emissions[measure][chordIndex] + transition;
        if (score > scores[measure][chordIndex]) {
          scores[measure][chordIndex] = score;
          previous[measure][chordIndex] = priorIndex;
        }
      });
    });
  }
  let cursor = scores[measureCount - 1].reduce((best, score, index, row) => score > row[best] ? index : best, 0);
  const progression = Array.from({ length: measureCount }, () => candidates[0]);
  for (let measure = measureCount - 1; measure >= 0; measure -= 1) {
    progression[measure] = candidates[cursor];
    cursor = previous[measure][cursor];
  }
  for (let measure = 1; measure < progression.length - 1; measure += 1) {
    const prior = progression[measure - 1];
    const next = progression[measure + 1];
    if (prior.root !== next.root || progression[measure].root === prior.root) continue;
    const currentIndex = candidates.indexOf(progression[measure]);
    const priorIndex = candidates.indexOf(prior);
    if (emissions[measure][currentIndex] - emissions[measure][priorIndex] < 1.5) progression[measure] = prior;
  }
  return progression;
}

function quantizePianoEvents(
  events: Array<{ midi: number; startSeconds: number; durationSeconds: number; velocity: number }>,
  tempo: number,
) {
  const audible = events.filter((note) => note.velocity >= 52 && note.durationSeconds >= 0.1);
  const scoreOriginSeconds = Math.max(0, Math.min(
    ...((audible.length ? audible : events).map((note) => note.startSeconds)),
  ));
  const secondsPerBeat = 60 / tempo;
  return events.map((note, sourceIndex) => ({
    midi: note.midi,
    sourceIndex,
    startBeat: Math.max(0, Math.round(((note.startSeconds - scoreOriginSeconds) / secondsPerBeat) * 4) / 4),
    beats: Math.max(0.25, Math.min(4, Math.round((note.durationSeconds / secondsPerBeat) * 4) / 4)),
    velocity: note.velocity,
    startSeconds: note.startSeconds,
    durationSeconds: note.durationSeconds,
  }));
}

function cleanPianoNotes(notes: Note[]) {
  const unique = new Map<string, Note>();
  notes
    .filter((note) => (note.velocity ?? 127) >= 40)
    .forEach((note) => {
      const key = `${note.startBeat}:${note.midi}`;
      const previous = unique.get(key);
      if (!previous || (note.velocity ?? 0) > (previous.velocity ?? 0)) unique.set(key, note);
    });

  const onsetGroups = new Map<number, Note[]>();
  unique.forEach((note) => onsetGroups.set(note.startBeat, [...(onsetGroups.get(note.startBeat) ?? []), note]));
  const progression = inferChordProgression([...unique.values()]);
  const cleaned = [...onsetGroups.entries()].flatMap(([startBeat, group]) => {
    const chord = progression[Math.min(progression.length - 1, Math.floor(startBeat / 4))];
    const treble = group.filter((note) => note.midi >= 60);
    const bass = group.filter((note) => note.midi < 60);
    const melody = [...treble].sort((a, b) => (
      ((b.velocity ?? 0) + (b.midi - 60) * 1.1) - ((a.velocity ?? 0) + (a.midi - 60) * 1.1)
    ))[0];
    const trebleByStrength = [...treble].sort((a, b) => (b.velocity ?? 0) - (a.velocity ?? 0));
    const trebleChordTones = treble
      .filter((note) => chord.tones.has(((note.midi % 12) + 12) % 12))
      .sort((a, b) => (b.velocity ?? 0) - (a.velocity ?? 0));
    const keptTreble = [melody, ...trebleChordTones, ...trebleByStrength]
      .filter((note): note is Note => Boolean(note))
      .filter((note, index, all) => all.indexOf(note) === index)
      .slice(0, 5);
    const bassChordTones = bass
      .filter((note) => chord.tones.has(((note.midi % 12) + 12) % 12))
      .sort((a, b) => {
        const aRoot = ((a.midi % 12) + 12) % 12 === chord.root ? 35 : 0;
        const bRoot = ((b.midi % 12) + 12) % 12 === chord.root ? 35 : 0;
        return ((b.velocity ?? 0) + bRoot) - ((a.velocity ?? 0) + aRoot);
      });
    const bassByStrength = [...bass].sort((a, b) => (b.velocity ?? 0) - (a.velocity ?? 0));
    const keptBass = [...bassChordTones, ...bassByStrength]
      .filter((note, index, all) => all.indexOf(note) === index)
      .slice(0, 3);
    return [...keptTreble, ...keptBass];
  }).sort((a, b) => a.startBeat - b.startBeat || a.midi - b.midi);

  progression.forEach((chord, measure) => {
    const firstTreble = cleaned.find((note) => note.midi >= 60 && note.startBeat >= measure * 4 && note.startBeat < (measure + 1) * 4);
    if (firstTreble) firstTreble.chord = chord.label;
  });
  return cleaned;
}

const baseTracks: Track[] = [
  {
    id: 1,
    name: "Piano",
    abbreviation: "Pno.",
    clef: TREBLE_CLEF,
    color: "#69406f",
    notes: sequentialNotes(melody),
    volume: 78,
    muted: false,
    solo: false,
  },
];

const noteNames = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

function noteLabel(midi: number) {
  return `${noteNames[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

const pianoSampleMidis = Array.from({ length: 30 }, (_, index) => 21 + index * 3);
let pianoSamplesPromise: Promise<Map<number, AudioBuffer>> | null = null;

function loadPianoSamples(context: AudioContext) {
  if (!pianoSamplesPromise) {
    pianoSamplesPromise = Promise.all(pianoSampleMidis.map(async (midi) => {
      const response = await fetch(`/salamander-piano/${midi}.mp3`);
      if (!response.ok) throw new Error(`Piano sample ${midi} could not be loaded`);
      return [midi, await context.decodeAudioData(await response.arrayBuffer())] as const;
    })).then((entries) => new Map(entries));
  }
  return pianoSamplesPromise;
}

function formatClock(seconds: number) {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60).toString().padStart(2, "0")}:${(whole % 60).toString().padStart(2, "0")}`;
}

function isValidYouTubeUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    let id = "";
    if (host === "youtu.be") id = url.pathname.split("/").filter(Boolean)[0] ?? "";
    else if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) {
      const parts = url.pathname.split("/").filter(Boolean);
      id = url.pathname === "/watch" ? url.searchParams.get("v") ?? "" : ["shorts", "embed", "live"].includes(parts[0] ?? "") ? parts[1] ?? "" : "";
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id);
  } catch {
    return false;
  }
}

function ScoreStaff({ track, selectedNote, onSelect }: { track: Track; selectedNote: string; onSelect: (id: string) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const bassClef = track.name === "Cello" || track.name === "Double bass";

  useEffect(() => {
    const target = container.current;
    if (!target) return;
    let cancelled = false;

    async function drawStaff() {
      const { Accidental, Formatter, Renderer, Stave, StaveNote } = await import("vexflow");
      if (cancelled || !target) return;
      target.replaceChildren();

      const indexedNotes: Array<Note & { index: number }> = [];
      let totalBeats = 0;
      for (const [index, note] of track.notes.entries()) {
        if (totalBeats + note.beats > 16) break;
        indexedNotes.push({ ...note, index });
        totalBeats += note.beats;
      }

      const measures: Array<Array<Note & { index: number }>> = [[], [], [], []];
      let measureIndex = 0;
      let beatsInMeasure = 0;
      for (const note of indexedNotes) {
        if (beatsInMeasure + note.beats > 4 && measureIndex < 3) {
          measureIndex += 1;
          beatsInMeasure = 0;
        }
        measures[measureIndex].push(note);
        beatsInMeasure += note.beats;
        if (beatsInMeasure >= 4 && measureIndex < 3) {
          measureIndex += 1;
          beatsInMeasure = 0;
        }
      }

      const width = Math.max(590, target.clientWidth || 650);
      const renderer = new Renderer(target, Renderer.Backends.SVG);
      renderer.resize(width, 104);
      const context = renderer.getContext();
      const firstMeasureWidth = Math.min(190, width * 0.29);
      const laterMeasureWidth = (width - firstMeasureWidth + 3) / 3;
      const keyNames = ["c", "c#", "d", "eb", "e", "f", "f#", "g", "ab", "a", "bb", "b"];
      const accidentals = ["", "#", "", "b", "", "n", "", "", "b", "", "b", ""];
      const renderedIndexes: number[] = [];
      let x = 0;

      measures.forEach((measure, index) => {
        const measureWidth = index === 0 ? firstMeasureWidth : laterMeasureWidth;
        const stave = new Stave(x, 12, measureWidth);
        if (index === 0) stave.addClef(bassClef ? "bass" : "treble").addKeySignature("G").addTimeSignature("4/4");
        stave.setContext(context).draw();

        const notes = measure.map((note) => {
          const pitchClass = ((note.midi % 12) + 12) % 12;
          const duration = note.beats < 0.375 ? "16" : note.beats < 0.75 ? "8" : note.beats < 1.5 ? "q" : "h";
          const staveNote = new StaveNote({
            clef: bassClef ? "bass" : "treble",
            keys: [`${keyNames[pitchClass]}/${Math.floor(note.midi / 12) - 1}`],
            duration,
            autoStem: true,
          });
          if (accidentals[pitchClass]) staveNote.addModifier(new Accidental(accidentals[pitchClass]), 0);
          renderedIndexes.push(note.index);
          return staveNote;
        });
        if (notes.length) Formatter.FormatAndDraw(context, stave, notes, { autoBeam: true });
        x += measureWidth - 1;
      });

      target.querySelectorAll<SVGGElement>(".vf-stavenote").forEach((element, renderedIndex) => {
        const originalIndex = renderedIndexes[renderedIndex];
        element.classList.toggle("selected", selectedNote === `${track.id}-${originalIndex}`);
        element.setAttribute("role", "button");
        element.setAttribute("aria-label", `Select ${noteLabel(track.notes[originalIndex].midi)}`);
        element.addEventListener("click", () => onSelect(`${track.id}-${originalIndex}`));
      });
    }

    void drawStaff();
    return () => { cancelled = true; };
  }, [bassClef, onSelect, selectedNote, track.id, track.notes]);

  return (
    <div className="staff-row" style={{ "--track": track.color } as CSSProperties}>
      <div className="staff-label">
        <span className="track-swatch" />
        <strong>{track.name}</strong>
      </div>
      <div className="engraved-staff" ref={container} />
    </div>
  );
}

function PianoSystem({
  track,
  systemStart,
  showLabel,
  selectedNote,
  onSelect,
}: {
  track: Track;
  systemStart: number;
  showLabel: boolean;
  selectedNote: string;
  onSelect: (id: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = container.current;
    if (!target) return;
    let cancelled = false;

    async function drawStaff() {
      const { Accidental, Annotation, Dot, Formatter, Renderer, Stave, StaveConnector, StaveNote, StaveTie } = await import("vexflow");
      if (cancelled || !target) return;
      target.replaceChildren();

      const width = Math.max(590, target.clientWidth || 650);
      const renderer = new Renderer(target, Renderer.Backends.SVG);
      renderer.resize(width, 205);
      const context = renderer.getContext();
      const firstMeasureWidth = Math.min(330, width * 0.54);
      const laterMeasureWidth = width - firstMeasureWidth + 1;
      const keyNames = ["c", "c#", "d", "eb", "e", "f", "f#", "g", "ab", "a", "bb", "b"];
      const accidentalNames = ["", "#", "", "b", "", "", "#", "", "b", "", "b", ""];
      const indexed = track.notes
        .map((note, index) => ({ ...note, index }))
        .filter((note) => note.startBeat >= systemStart && note.startBeat < systemStart + 8);

      const durationFor = (beats: number) => beats >= 4 ? [4, "w", false] as const
        : beats >= 3 ? [3, "h", true] as const
        : beats >= 2 ? [2, "h", false] as const
        : beats >= 1.5 ? [1.5, "q", true] as const
        : beats >= 1 ? [1, "q", false] as const
        : beats >= 0.75 ? [0.75, "8", true] as const
        : beats >= 0.5 ? [0.5, "8", false] as const
        : [0.25, "16", false] as const;

      const bindRenderedNotes = (before: number, indexes: Array<number | null>) => {
        [...target.querySelectorAll<SVGGElement>(".vf-stavenote")].slice(before).forEach((element, renderedIndex) => {
          const originalIndex = indexes[renderedIndex];
          if (originalIndex === null || originalIndex === undefined) return;
          element.classList.toggle("selected", selectedNote === `${track.id}-${originalIndex}`);
          element.setAttribute("role", "button");
          element.setAttribute("aria-label", `Select ${noteLabel(track.notes[originalIndex].midi)}`);
          element.addEventListener("click", () => onSelect(`${track.id}-${originalIndex}`));
        });
      };

      const renderVoice = (
        stave: InstanceType<typeof Stave>,
        clef: "treble" | "bass",
        measureStart: number,
        measureEnd: number,
      ) => {
        const groups = new Map<number, Array<Note & { index: number }>>();
        indexed
          .filter((note) => clef === "treble" ? note.midi >= 60 : note.midi < 60)
          .filter((note) => note.startBeat >= measureStart && note.startBeat < measureEnd)
          .forEach((note) => {
            const onset = Math.round(note.startBeat * 4) / 4;
            if (onset >= measureEnd) return;
            groups.set(onset, [...(groups.get(onset) ?? []), note]);
          });
        const earliestOnset = Math.min(...groups.keys());
        if (Number.isFinite(earliestOnset) && earliestOnset > measureStart && earliestOnset - measureStart <= 0.5) {
          groups.set(measureStart, [...(groups.get(measureStart) ?? []), ...(groups.get(earliestOnset) ?? [])]);
          groups.delete(earliestOnset);
        }
        const starts = [...groups.keys()].sort((a, b) => a - b);
        const tickables: InstanceType<typeof StaveNote>[] = [];
        const indexes: Array<number | null> = [];
        const ties: Array<InstanceType<typeof StaveTie>> = [];
        let cursor = measureStart;

        const addDuration = (beats: number, rest: boolean, group: Array<Note & { index: number }> = []) => {
          let remaining = Math.round(beats * 4) / 4;
          let previousSegment: InstanceType<typeof StaveNote> | null = null;
          let segmentIndex = 0;
          while (remaining >= 0.25) {
            const [used, duration, dotted] = durationFor(remaining);
            const sorted = [...group].sort((a, b) => a.midi - b.midi);
            const staveNote = new StaveNote({
              clef,
              keys: rest
                ? [clef === "treble" ? "b/4" : "d/3"]
                : sorted.map((note) => `${keyNames[((note.midi % 12) + 12) % 12]}/${Math.floor(note.midi / 12) - 1}`),
              duration: `${duration}${rest ? "r" : ""}`,
              autoStem: !rest,
            });
            if (dotted) Dot.buildAndAttach([staveNote], { all: true });
            if (!rest) {
              if (segmentIndex === 0) {
                sorted.forEach((note, keyIndex) => {
                  const accidental = accidentalNames[((note.midi % 12) + 12) % 12];
                  if (accidental) staveNote.addModifier(new Accidental(accidental), keyIndex);
                });
                const chord = clef === "treble" ? sorted.find((note) => note.chord)?.chord : undefined;
                if (chord) staveNote.addModifier(new Annotation(chord).setVerticalJustification("top").setJustification("left"), 0);
              }
              if (previousSegment) {
                const tiedIndexes = sorted.map((_, keyIndex) => keyIndex);
                ties.push(new StaveTie({
                  firstNote: previousSegment,
                  lastNote: staveNote,
                  firstIndexes: tiedIndexes,
                  lastIndexes: tiedIndexes,
                }));
              }
            }
            tickables.push(staveNote);
            indexes.push(rest ? null : sorted[0]?.index ?? null);
            previousSegment = rest ? null : staveNote;
            segmentIndex += 1;
            remaining -= used;
          }
        };

        starts.forEach((onset, groupIndex) => {
          if (onset > cursor) addDuration(onset - cursor, true);
          const nextOnset = starts[groupIndex + 1] ?? measureEnd;
          const group = groups.get(onset) ?? [];
          const available = Math.max(0.25, Math.min(nextOnset - onset, measureEnd - onset));
          const detectedDuration = Math.max(0.25, ...group.map((note) => note.beats));
          let engravedDuration = Math.min(available, detectedDuration);
          if (available - engravedDuration <= 0.25) engravedDuration = available;
          engravedDuration = Math.max(0.25, Math.round(engravedDuration * 4) / 4);
          addDuration(engravedDuration, false, group);
          cursor = onset + engravedDuration;
        });
        if (cursor < measureEnd) addDuration(measureEnd - cursor, true);
        if (!tickables.length) addDuration(4, true);
        const before = target.querySelectorAll(".vf-stavenote").length;
        Formatter.FormatAndDraw(context, stave, tickables, { autoBeam: true, alignRests: true });
        ties.forEach((tie) => tie.setContext(context).draw());
        bindRenderedNotes(before, indexes);
      };

      let x = 0;
      for (let measureIndex = 0; measureIndex < 2; measureIndex += 1) {
        const measureWidth = measureIndex === 0 ? firstMeasureWidth : laterMeasureWidth;
        const trebleStave = new Stave(x, 16, measureWidth);
        const bassStave = new Stave(x, 106, measureWidth);
        if (measureIndex === 0) {
          trebleStave.addClef("treble").addKeySignature("C");
          bassStave.addClef("bass").addKeySignature("C");
          if (systemStart === 0) {
            trebleStave.addTimeSignature("4/4");
            bassStave.addTimeSignature("4/4");
          }
        }
        trebleStave.setContext(context).draw();
        bassStave.setContext(context).draw();
        if (measureIndex === 0) {
          new StaveConnector(trebleStave, bassStave).setType("brace").setContext(context).draw();
          new StaveConnector(trebleStave, bassStave).setType("singleLeft").setContext(context).draw();
        }
        if (measureIndex === 1) new StaveConnector(trebleStave, bassStave).setType("singleRight").setContext(context).draw();

        const measureStart = systemStart + measureIndex * 4;
        const measureEnd = measureStart + 4;
        renderVoice(trebleStave, "treble", measureStart, measureEnd);
        renderVoice(bassStave, "bass", measureStart, measureEnd);
        x += measureWidth - 1;
      }
    }

    void drawStaff();
    return () => { cancelled = true; };
  }, [onSelect, selectedNote, systemStart, track]);

  return (
    <div className="staff-row piano-grand-system" style={{ "--track": track.color } as CSSProperties}>
      <div className="staff-label">{showLabel && <><span className="track-swatch" /><strong>Piano</strong></>}</div>
      <div className="engraved-grand-staff" ref={container} />
    </div>
  );
}

export function ScoreCraft() {
  const [sourceMode, setSourceMode] = useState<"upload" | "youtube">("upload");
  const [file, setFile] = useState<File | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [title, setTitle] = useState("Moonlit Waltz");
  const [composer, setComposer] = useState("Arranged with ScoreCraft");
  const [tracks, setTracks] = useState<Track[]>(baseTracks);
  const [playbackNotes, setPlaybackNotes] = useState<Note[]>(baseTracks[0].notes);
  const [tempo, setTempo] = useState(92);
  const [zoom, setZoom] = useState(86);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [looping, setLooping] = useState(false);
  const [metronome, setMetronome] = useState(false);
  const [selectedNote, setSelectedNote] = useState("1-3");
  const [analysis, setAnalysis] = useState<null | { progress: number; label: string }>(null);
  const [message, setMessage] = useState("Your changes are saved on this device");
  const [sourceDuration, setSourceDuration] = useState<number | null>(null);
  const [exportMenu, setExportMenu] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const totalBeats = useMemo(() => Math.max(16, ...tracks.flatMap((track) => track.notes.map((note) => note.startBeat + note.beats))), [tracks]);
  const systemStarts = useMemo(() => Array.from({ length: Math.min(40, Math.ceil(totalBeats / 8)) }, (_, index) => index * 8), [totalBeats]);
  const duration = Math.max(1, Math.ceil(sourceDuration ?? totalBeats * 60 / tempo));

  const validYoutubeUrl = isValidYouTubeUrl(youtubeUrl.trim());
  const sourceReady = sourceMode === "youtube" ? validYoutubeUrl : Boolean(file);
  const selected = useMemo(() => {
    const [trackId, index] = selectedNote.split("-").map(Number);
    return tracks.find((track) => track.id === trackId)?.notes[index];
  }, [selectedNote, tracks]);

  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
    const context = audioContext.current;
    audioContext.current = null;
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fixture = params.get("qaFixture");
    if (!fixture || !["localhost", "127.0.0.1"].includes(window.location.hostname)) return;
    const fixtureUrl = new URL(fixture, window.location.origin);
    if (fixtureUrl.origin !== window.location.origin || !fixtureUrl.pathname.startsWith("/qa/")) return;
    let cancelled = false;
    void fetch(fixtureUrl)
      .then(async (response) => {
        if (!response.ok) throw new Error(`QA fixture returned ${response.status}`);
        const blob = await response.blob();
        if (cancelled) return;
        const fixtureFile = new File([blob], fixtureUrl.pathname.split("/").pop() || "qa-audio.mp3", {
          type: blob.type || "audio/mpeg",
        });
        setSourceMode("upload");
        setFile(fixtureFile);
        setTitle(fixtureFile.name.replace(/\.[^.]+$/, ""));
        setMessage(`${fixtureFile.name} loaded as a local QA fixture`);
      })
      .catch((error) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "QA fixture could not be loaded");
      });
    return () => { cancelled = true; };
  }, []);

  function chooseFile(next: File | undefined) {
    if (!next) return;
    if (!next.type.startsWith("audio/") && !next.type.startsWith("video/") && !/\.(mp3|wav|m4a|aac|ogg|mp4|webm|mov)$/i.test(next.name)) {
      setMessage("Choose an audio or video file (MP3, WAV, M4A, MP4, or WebM)");
      return;
    }
    setFile(next);
    setTitle(next.name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " "));
    setMessage(`${next.name} is ready to transcribe`);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    chooseFile(event.dataTransfer.files[0]);
  }

  function rememberPlaybackSource(sourceFile: File) {
    const url = URL.createObjectURL(sourceFile);
    const probe = new Audio(url);
    probe.preload = "metadata";
    probe.addEventListener("loadedmetadata", () => {
      if (Number.isFinite(probe.duration)) setSourceDuration(probe.duration);
      URL.revokeObjectURL(url);
    }, { once: true });
    probe.addEventListener("error", () => {
      URL.revokeObjectURL(url);
    }, { once: true });
  }

  async function analyzeSource() {
    if (!sourceReady) {
      setMessage(sourceMode === "youtube"
        ? "Enter a complete public YouTube video link first."
        : "Add an audio or video file first");
      return;
    }
    let sourceFile = file;
    if (sourceMode === "youtube") {
      setAnalysis({ progress: 5, label: "Downloading audio from YouTube" });
      try {
        const response = await fetch("/__local/youtube-audio", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: youtubeUrl.trim() }),
        });
        if (!response.ok) {
          const result = await response.json().catch(() => ({ error: "YouTube audio could not be loaded." })) as { error?: string };
          throw new Error(result.error || "YouTube audio could not be loaded.");
        }
        const videoTitle = response.headers.get("X-ScoreCraft-Title");
        if (videoTitle) setTitle(decodeURIComponent(videoTitle));
        const videoDuration = Number(response.headers.get("X-ScoreCraft-Duration"));
        if (Number.isFinite(videoDuration) && videoDuration > 0) setSourceDuration(videoDuration);
        const audio = await response.blob();
        if (!audio.size) throw new Error("YouTube returned an empty audio track.");
        sourceFile = new File([audio], "youtube-audio.m4a", { type: audio.type || "audio/mp4" });
      } catch (error) {
        setAnalysis(null);
        setMessage(error instanceof Error ? error.message : "YouTube audio could not be loaded.");
        return;
      }
    }

    let notes: Note[] = [];
    let playbackNoteCount = 0;
    if (sourceFile) {
      try {
        rememberPlaybackSource(sourceFile);
        const { transcribePiano } = await import("./piano-transcription");
        const transcription = await transcribePiano(sourceFile, (progress, label) => setAnalysis({ progress, label }));
        const detectedTempo = transcription.tempo;
        setTempo(detectedTempo);
        const quantized = quantizePianoEvents(transcription.notes, detectedTempo);
        playbackNoteCount = quantized.length;
        setPlaybackNotes(quantized);
        const params = new URLSearchParams(window.location.search);
        const qaFixture = params.has("qaFixture") && ["localhost", "127.0.0.1"].includes(window.location.hostname);
        if (qaFixture) {
          document.documentElement.dataset.scorecraftQaTranscription = JSON.stringify({
            tempo: detectedTempo,
            notes: quantized,
          });
          setAnalysis({ progress: 100, label: "QA transcription ready" });
          setTimeout(() => setAnalysis(null), 650);
          setMessage(`QA transcription ready with ${quantized.length} detected piano notes.`);
          return;
        }
        notes = cleanPianoNotes(quantized);
      } catch (error) {
        setAnalysis(null);
        setMessage(error instanceof Error ? `Piano transcription failed: ${error.message}` : "The browser could not transcribe this audio.");
        return;
      }
    }
    if (notes.length) {
      setTracks([{ ...baseTracks[0], notes }]);
      setSelectedNote("1-0");
    }
    setAnalysis({ progress: 100, label: "Piano score ready" });
    setTimeout(() => setAnalysis(null), 650);
    setMessage(notes.length
      ? `Engraved ${notes.length} readable notes. Play preserves all ${playbackNoteCount} detected piano notes.`
      : "No clear piano notes were detected. Use a piano-only recording with little background noise.");
  }

  function stopPlayback(reset = false) {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setPlaying(false);
    if (reset) setPlayhead(0);
    const context = audioContext.current;
    audioContext.current = null;
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
  }

  async function startSynthPlayback(startAt: number) {
    const context = new AudioContext();
    audioContext.current = context;
    const resume = context.resume();
    await Promise.race([
      resume.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 250)),
    ]);
    setMessage("Loading the local sampled grand piano");
    let samples: Map<number, AudioBuffer>;
    try {
      samples = await loadPianoSamples(context);
    } catch (error) {
      stopPlayback();
      setMessage(error instanceof Error ? error.message : "The sampled piano could not be loaded");
      return;
    }
    const beatSeconds = 60 / tempo;
    const piano = tracks[0];
    const events = (!piano || piano.muted ? [] : playbackNotes)
      .map((note) => ({ note, volume: piano?.volume ?? 78 }))
      .sort((a, b) => a.note.startBeat - b.note.startBeat || a.note.midi - b.note.midi);
    if (!events.length) {
      setMessage("There are no audible piano notes. Unmute Piano or transcribe a recording first.");
      stopPlayback();
      return;
    }
    setMessage("Playing the transcribed notes with a sampled grand piano");
    let eventIndex = Math.max(0, events.findIndex(({ note }) => (
      (note.startSeconds ?? note.startBeat * beatSeconds)
      + (note.durationSeconds ?? note.beats * beatSeconds)
    ) >= startAt));
    if (eventIndex < 0) eventIndex = events.length;
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -10;
    compressor.knee.value = 8;
    compressor.ratio.value = 1.8;
    compressor.attack.value = 0.004;
    compressor.release.value = 0.2;
    const master = context.createGain();
    master.gain.value = 0.78;
    const room = context.createConvolver();
    const roomGain = context.createGain();
    const impulse = context.createBuffer(2, Math.ceil(context.sampleRate * 1.35), context.sampleRate);
    for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
      const data = impulse.getChannelData(channel);
      for (let index = 0; index < data.length; index += 1) {
        const decay = (1 - index / data.length) ** 2.8;
        const deterministicNoise = Math.sin((index + 1) * (channel + 1) * 12.9898) * 43758.5453;
        data[index] = ((deterministicNoise - Math.floor(deterministicNoise)) * 2 - 1) * decay;
      }
    }
    room.buffer = impulse;
    roomGain.gain.value = 0.065;
    master.connect(compressor);
    master.connect(room).connect(roomGain).connect(compressor);
    compressor.connect(context.destination);

    const scheduleNote = (note: Note, volume: number, sourcePosition: number) => {
      const noteStart = note.startSeconds ?? note.startBeat * beatSeconds;
      const noteDuration = Math.max(0.14, note.durationSeconds ?? note.beats * beatSeconds);
      const elapsedIntoNote = Math.max(0, sourcePosition - noteStart);
      if (elapsedIntoNote >= noteDuration) return;
      const when = Math.max(context.currentTime + 0.005, audioOrigin + noteStart);
      const audibleDuration = Math.max(0.08, noteDuration - elapsedIntoNote);
      const anchor = pianoSampleMidis.reduce((nearest, midi) => (
        Math.abs(midi - note.midi) < Math.abs(nearest - note.midi) ? midi : nearest
      ), pianoSampleMidis[0]);
      const sample = samples.get(anchor);
      if (!sample) return;
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = sample;
      source.playbackRate.value = 2 ** ((note.midi - anchor) / 12);
      const velocity = Math.max(0.02, Math.min(1, (note.velocity ?? 72) / 127) ** 1.7);
      const level = velocity * Math.max(0.1, volume / 100) * 0.82;
      const releaseAt = when + audibleDuration;
      gain.gain.setValueAtTime(level, when);
      gain.gain.setValueAtTime(level * 0.82, Math.max(when, releaseAt - 0.08));
      gain.gain.exponentialRampToValueAtTime(0.0001, releaseAt + 0.22);
      source.connect(gain).connect(master);
      const sampleOffset = elapsedIntoNote * source.playbackRate.value;
      source.start(when, Math.min(sampleOffset, Math.max(0, sample.duration - 0.05)));
      source.stop(releaseAt + 0.24);
    };

    const audioOrigin = context.currentTime - startAt;
    setPlaying(true);
    const pump = () => {
      const sourcePosition = context.currentTime - audioOrigin;
      while (eventIndex < events.length) {
        const event = events[eventIndex];
        const noteStart = event.note.startSeconds ?? event.note.startBeat * beatSeconds;
        if (noteStart > sourcePosition + 0.35) break;
        scheduleNote(event.note, event.volume, sourcePosition);
        eventIndex += 1;
      }
      const next = (sourcePosition / duration) * 100;
      if (next >= 100) {
        if (looping) {
          stopPlayback(true);
          setTimeout(() => void startPlayback(), 80);
        } else stopPlayback(true);
      } else setPlayhead(next);
    };
    pump();
    timer.current = setInterval(pump, 45);
  }

  function startPlayback() {
    if (playing) {
      stopPlayback();
      return;
    }
    const startAt = (playhead / 100) * duration;
    void startSynthPlayback(startAt).catch((error) => {
      stopPlayback();
      setMessage(error instanceof Error ? `Playback failed: ${error.message}` : "Playback could not start");
    });
  }

  function updateTrack(id: number, patch: Partial<Track>) {
    setTracks((current) => current.map((track) => track.id === id ? { ...track, ...patch } : track));
    setMessage("Mix updated");
  }

  function transposeSelected(amount: number) {
    const [trackId, noteIndex] = selectedNote.split("-").map(Number);
    const sourceIndex = tracks.find((track) => track.id === trackId)?.notes[noteIndex]?.sourceIndex;
    setTracks((current) => current.map((track) => track.id !== trackId ? track : {
      ...track,
      notes: track.notes.map((note, index) => index === noteIndex ? { ...note, midi: note.midi + amount } : note),
    }));
    if (sourceIndex !== undefined) {
      setPlaybackNotes((current) => current.map((note) => (
        note.sourceIndex === sourceIndex ? { ...note, midi: note.midi + amount } : note
      )));
    }
    setMessage(`Note moved ${amount > 0 ? "up" : "down"} one semitone`);
  }

  function xmlEscape(value: string) {
    return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character] ?? character);
  }

  function musicXmlPitch(midi: number) {
    const pitches = [
      ["C", 0], ["C", 1], ["D", 0], ["E", -1], ["E", 0], ["F", 0],
      ["F", 1], ["G", 0], ["A", -1], ["A", 0], ["B", -1], ["B", 0],
    ] as const;
    const [step, alter] = pitches[((midi % 12) + 12) % 12];
    return `<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ""}<octave>${Math.floor(midi / 12) - 1}</octave></pitch>`;
  }

  function exportMusicXml() {
    const divisions = 4;
    const partList = tracks.map((track) => `<score-part id="P${track.id}"><part-name>${xmlEscape(track.name)}</part-name><part-abbreviation>${xmlEscape(track.abbreviation)}</part-abbreviation></score-part>`).join("");
    const parts = tracks.map((track) => {
      const measures: string[] = [];
      let measure: string[] = [];
      let beats = 0;
      const flush = () => {
        const number = measures.length + 1;
        const bassClef = track.name === "Cello" || track.name === "Double bass";
        const attributes = number === 1 ? `<attributes><divisions>${divisions}</divisions><key><fifths>1</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>${bassClef ? "F" : "G"}</sign><line>${bassClef ? 4 : 2}</line></clef></attributes><direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${tempo}</per-minute></metronome></direction-type><sound tempo="${tempo}"/></direction>` : "";
        if (beats < 4) measure.push(`<note><rest/><duration>${Math.round((4 - beats) * divisions)}</duration><type>${4 - beats >= 2 ? "half" : "quarter"}</type></note>`);
        measures.push(`<measure number="${number}">${attributes}${measure.join("")}</measure>`);
        measure = [];
        beats = 0;
      };
      track.notes.forEach((note) => {
        if (beats + note.beats > 4) flush();
        const type = note.beats >= 4 ? "whole" : note.beats >= 2 ? "half" : note.beats >= 1 ? "quarter" : note.beats >= 0.5 ? "eighth" : "16th";
        measure.push(`<note>${musicXmlPitch(note.midi)}<duration>${Math.max(1, Math.round(note.beats * divisions))}</duration><type>${type}</type></note>`);
        beats += note.beats;
        if (beats >= 4) flush();
      });
      if (measure.length || !measures.length) flush();
      return `<part id="P${track.id}">${measures.join("")}</part>`;
    }).join("");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n<score-partwise version="4.0"><work><work-title>${xmlEscape(title)}</work-title></work><identification><creator type="composer">${xmlEscape(composer)}</creator><encoding><software>ScoreCraft</software></encoding></identification><part-list>${partList}</part-list>${parts}</score-partwise>`;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([xml], { type: "application/vnd.recordare.musicxml+xml" }));
    link.download = `${title.replace(/\s+/g, "-").toLowerCase() || "score"}.musicxml`;
    link.click();
    URL.revokeObjectURL(link.href);
    setExportMenu(false);
    setMessage("MusicXML exported");
  }

  function exportPianoMusicXml() {
    const divisions = 4;
    const piano = tracks[0];
    const measureCount = Math.max(1, Math.ceil(totalBeats / 4));
    const typeFor = (ticks: number) => ticks >= 16 ? "whole" : ticks >= 8 ? "half" : ticks >= 4 ? "quarter" : ticks >= 2 ? "eighth" : "16th";
    const writeStaff = (measureStart: number, staff: 1 | 2) => {
      const measureEnd = measureStart + 4;
      const notes = piano.notes
        .filter((note) => note.startBeat >= measureStart && note.startBeat < measureEnd)
        .filter((note) => staff === 1 ? note.midi >= 60 : note.midi < 60);
      const groups = new Map<number, Note[]>();
      notes.forEach((note) => {
        const onset = Math.round(note.startBeat * divisions) / divisions;
        groups.set(onset, [...(groups.get(onset) ?? []), note]);
      });
      const starts = [...groups.keys()].sort((a, b) => a - b);
      const xml: string[] = [];
      let cursorTicks = 0;
      starts.forEach((start, groupIndex) => {
        const onsetTicks = Math.round((start - measureStart) * divisions);
        if (onsetTicks > cursorTicks) {
          const restTicks = onsetTicks - cursorTicks;
          xml.push(`<note><rest/><duration>${restTicks}</duration><voice>${staff}</voice><type>${typeFor(restTicks)}</type><staff>${staff}</staff></note>`);
        }
        const group = groups.get(start) ?? [];
        const nextStart = starts[groupIndex + 1] ?? measureEnd;
        const durationTicks = Math.max(1, Math.min(
          Math.round(Math.min(...group.map((note) => note.beats)) * divisions),
          Math.round((nextStart - start) * divisions),
          16 - onsetTicks,
        ));
        group.sort((a, b) => a.midi - b.midi).forEach((note, noteIndex) => {
          xml.push(`<note>${noteIndex ? "<chord/>" : ""}${musicXmlPitch(note.midi)}<duration>${durationTicks}</duration><voice>${staff}</voice><type>${typeFor(durationTicks)}</type><velocity>${note.velocity ?? 80}</velocity><staff>${staff}</staff></note>`);
        });
        cursorTicks = onsetTicks + durationTicks;
      });
      if (cursorTicks < 16) {
        const restTicks = 16 - cursorTicks;
        xml.push(`<note><rest/><duration>${restTicks}</duration><voice>${staff}</voice><type>${typeFor(restTicks)}</type><staff>${staff}</staff></note>`);
      }
      return xml.join("");
    };

    const measures = Array.from({ length: measureCount }, (_, index) => {
      const attributes = index === 0
        ? `<attributes><divisions>${divisions}</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><staves>2</staves><clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes><direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${tempo}</per-minute></metronome></direction-type><sound tempo="${tempo}"/></direction>`
        : "";
      const measureStart = index * 4;
      return `<measure number="${index + 1}">${attributes}${writeStaff(measureStart, 1)}<backup><duration>16</duration></backup>${writeStaff(measureStart, 2)}</measure>`;
    }).join("");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n<score-partwise version="4.0"><work><work-title>${xmlEscape(title)}</work-title></work><identification><creator type="composer">${xmlEscape(composer)}</creator><encoding><software>ScoreCraft</software></encoding></identification><part-list><score-part id="P1"><part-name>Piano</part-name><part-abbreviation>Pno.</part-abbreviation></score-part></part-list><part id="P1">${measures}</part></score-partwise>`;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([xml], { type: "application/vnd.recordare.musicxml+xml" }));
    link.download = `${title.replace(/\s+/g, "-").toLowerCase() || "piano-score"}.musicxml`;
    link.click();
    URL.revokeObjectURL(link.href);
    setExportMenu(false);
    setMessage("Two-staff piano MusicXML exported");
  }

  async function exportPdf() {
    setExportMenu(false);
    setMessage("Building the paginated piano PDF");
    const paper = document.querySelector<HTMLElement>(".score-paper");
    const previousTransform = paper?.style.transform ?? "";
    try {
      if (paper) paper.style.transform = "none";
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const { jsPDF } = await import("jspdf");
      const systems = [...document.querySelectorAll<HTMLElement>(".piano-grand-system")];
      const systemSvgs = systems.map((system) => system.querySelector<SVGSVGElement>(".engraved-grand-staff svg"));
      if (!systems.length || systemSvgs.some((svg) => !svg)) throw new Error("No engraved piano systems are ready to export");

      const blobAsDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
        reader.addEventListener("error", () => reject(reader.error ?? new Error("A notation font could not be read")), { once: true });
        reader.readAsDataURL(blob);
      });
      const fontData = await Promise.all(["bravura.woff2", "academico.woff2", "academico-bold.woff2"].map(async (name) => {
        const response = await fetch(`/fonts/${name}`);
        if (!response.ok) throw new Error(`Notation font ${name} could not be loaded`);
        return blobAsDataUrl(await response.blob());
      }));
      const [bravuraFont, academicoFont, academicoBoldFont] = fontData;
      const notationPadding = 24;
      const svgToImage = async (source: SVGSVGElement) => {
        const clone = source.cloneNode(true) as SVGSVGElement;
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        clone.querySelectorAll("text").forEach((textNode) => {
          const text = textNode.textContent ?? "";
          textNode.setAttribute("font-family", /^[\u0020-\u007e]+$/.test(text) ? "Academico" : "Bravura");
        });
        const sourceWidth = Number(source.getAttribute("width")) || 650;
        const sourceHeight = Number(source.getAttribute("height")) || 205;
        const translated = document.createElementNS("http://www.w3.org/2000/svg", "g");
        translated.setAttribute("transform", `translate(${notationPadding} 0)`);
        while (clone.firstChild) translated.appendChild(clone.firstChild);
        clone.appendChild(translated);
        clone.setAttribute("width", String(sourceWidth + notationPadding * 2));
        clone.setAttribute("height", String(sourceHeight));
        clone.setAttribute("viewBox", `0 0 ${sourceWidth + notationPadding * 2} ${sourceHeight}`);
        const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
        style.textContent = `
          @font-face { font-family: Bravura; src: url("${bravuraFont}") format("woff2"); }
          @font-face { font-family: Academico; src: url("${academicoFont}") format("woff2"); font-weight: 400; }
          @font-face { font-family: Academico; src: url("${academicoBoldFont}") format("woff2"); font-weight: 700; }
        `;
        clone.insertBefore(style, clone.firstChild);
        const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml;charset=utf-8" }));
        const image = new Image();
        try {
          image.src = url;
          await image.decode();
          return image;
        } finally {
          URL.revokeObjectURL(url);
        }
      };

      const headingCanvas = document.createElement("canvas");
      headingCanvas.width = 1_400;
      headingCanvas.height = 210;
      const headingContext = headingCanvas.getContext("2d");
      if (!headingContext) throw new Error("The PDF heading canvas could not be created");
      headingContext.fillStyle = "#ffffff";
      headingContext.fillRect(0, 0, headingCanvas.width, headingCanvas.height);
      headingContext.fillStyle = "#211c25";
      headingContext.textAlign = "center";
      let titleSize = 48;
      do {
        headingContext.font = `700 ${titleSize}px Georgia, "Times New Roman", serif`;
        if (headingContext.measureText(title).width <= headingCanvas.width - 80) break;
        titleSize -= 2;
      } while (titleSize > 22);
      headingContext.fillText(title, headingCanvas.width / 2, 58);
      headingContext.font = "italic 20px Georgia, 'Times New Roman', serif";
      headingContext.fillStyle = "#69406f";
      headingContext.fillText(composer, headingCanvas.width / 2, 96);
      headingContext.fillStyle = "#211c25";
      headingContext.textAlign = "left";
      headingContext.font = "italic 18px Georgia, 'Times New Roman', serif";
      headingContext.fillText("Andante, con moto", 50, 164);
      headingContext.textAlign = "right";
      headingContext.fillText(`Quarter note = ${tempo}`, headingCanvas.width - 50, 164);

      const notationScale = 1.6;
      const labelWidth = 78;
      const systemStride = 218;
      const svgWidth = Math.max(...systemSvgs.map((svg) => Number(svg?.getAttribute("width")) || 650)) + notationPadding * 2;
      const scoreCanvas = document.createElement("canvas");
      scoreCanvas.width = Math.ceil((labelWidth + svgWidth) * notationScale);
      scoreCanvas.height = Math.ceil(systemStride * systems.length * notationScale);
      const scoreContext = scoreCanvas.getContext("2d");
      if (!scoreContext) throw new Error("The notation canvas could not be created");
      scoreContext.fillStyle = "#ffffff";
      scoreContext.fillRect(0, 0, scoreCanvas.width, scoreCanvas.height);
      for (let index = 0; index < systemSvgs.length; index += 1) {
        const image = await svgToImage(systemSvgs[index] as SVGSVGElement);
        scoreContext.drawImage(image, labelWidth * notationScale, index * systemStride * notationScale, svgWidth * notationScale, 205 * notationScale);
      }
      scoreContext.fillStyle = "#211c25";
      scoreContext.font = `700 ${13 * notationScale}px Georgia, "Times New Roman", serif`;
      scoreContext.fillText("Piano", 7 * notationScale, 90 * notationScale);

      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const marginX = 12;
      const top = 10;
      const contentWidth = pageWidth - marginX * 2;
      const systemsPerPage = 4;
      const headingHeight = Math.min(27, contentWidth * headingCanvas.height / headingCanvas.width);

      for (let pageStart = 0; pageStart < systems.length; pageStart += systemsPerPage) {
        if (pageStart) pdf.addPage("a4", "portrait");
        pdf.addImage(headingCanvas, "PNG", marginX, top, contentWidth, headingHeight, "score-heading", "FAST");
        const pageEnd = Math.min(systems.length, pageStart + systemsPerPage);
        const sourceY = Math.round(pageStart * systemStride * notationScale);
        const sourceEnd = Math.round(pageEnd * systemStride * notationScale);
        const pageCanvas = document.createElement("canvas");
        pageCanvas.width = scoreCanvas.width;
        pageCanvas.height = Math.max(1, sourceEnd - sourceY);
        const pageContext = pageCanvas.getContext("2d");
        if (!pageContext) throw new Error("The PDF page canvas could not be created");
        pageContext.fillStyle = "#ffffff";
        pageContext.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
        pageContext.drawImage(scoreCanvas, 0, sourceY, scoreCanvas.width, pageCanvas.height, 0, 0, pageCanvas.width, pageCanvas.height);
        const y = top + headingHeight + 4;
        const naturalHeight = contentWidth * pageCanvas.height / pageCanvas.width;
        const renderedHeight = Math.min(naturalHeight, pageHeight - y - 14);
        pdf.addImage(pageCanvas, "PNG", marginX, y, contentWidth, renderedHeight, `systems-${pageStart}`, "FAST");
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(8);
        pdf.setTextColor(95, 86, 99);
        pdf.text(`ScoreCraft piano transcription  |  Page ${Math.floor(pageStart / systemsPerPage) + 1}`, pageWidth / 2, pageHeight - 7, { align: "center" });
      }

      const filename = `${title.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "piano-score"}.pdf`;
      const pdfBlob = pdf.output("blob");
      const pdfUrl = URL.createObjectURL(pdfBlob);
      const link = document.createElement("a");
      link.href = pdfUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(pdfUrl), 30_000);
      document.documentElement.dataset.scorecraftPdfPages = String(pdf.getNumberOfPages());
      document.documentElement.dataset.scorecraftPdfBytes = String(pdfBlob.size);
      setMessage(`PDF exported: ${pdf.getNumberOfPages()} A4 pages with ${systems.length} aligned grand-staff systems`);
    } catch (error) {
      setMessage(error instanceof Error ? `PDF export failed: ${error.message}` : "PDF export failed");
    } finally {
      if (paper) paper.style.transform = previousTransform;
    }
  }

  const currentTime = Math.round((playhead / 100) * duration);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="ScoreCraft home">
          <span className="brand-mark"><i /><i /><i /></span>
          <span>Score<span>Craft</span></span>
        </div>
        <div className="document-title">
          <input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Score title" />
          <span className="saved-dot" /> <small>Saved</small>
        </div>
        <div className="top-actions">
          <button className="icon-button" title="Share score" aria-label="Share score">↗</button>
          <div className="export-wrap">
            <button className="button primary" onClick={() => setExportMenu(!exportMenu)}><span>⇩</span> Export</button>
            {exportMenu && (
              <div className="floating-menu export-menu">
                <button onClick={exportPdf}><b>PDF</b><span>Save a print-ready score</span></button>
                <button onClick={exportPianoMusicXml}><b>MusicXML</b><span>Two-staff piano score</span></button>
              </div>
            )}
          </div>
          <button className="avatar" aria-label="Account">MC</button>
        </div>
      </header>

      <section className="workspace">
        <aside className="source-panel">
          <div className="panel-heading">
            <span className="eyebrow">SOURCE</span>
            <button className="help" title="Your audio is analyzed in this browser">?</button>
          </div>
          <div className="source-tabs" role="tablist">
            <button className={sourceMode === "upload" ? "active" : ""} onClick={() => setSourceMode("upload")}>↑ Upload</button>
            <button className={sourceMode === "youtube" ? "active" : ""} onClick={() => setSourceMode("youtube")}>▶ YouTube</button>
          </div>

          {sourceMode === "upload" ? (
            <div className={`dropzone ${file ? "has-file" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={handleDrop} onClick={() => fileInput.current?.click()}>
              <input ref={fileInput} type="file" accept="audio/*,video/*,.mp3,.wav,.m4a,.mp4,.webm" onChange={(event: ChangeEvent<HTMLInputElement>) => chooseFile(event.target.files?.[0])} />
              <span className="upload-symbol">♫</span>
              {file ? <><strong>{file.name}</strong><span>{(file.size / 1024 / 1024).toFixed(1)} MB · ready</span></> : <><strong>Drop your recording here</strong><span>or choose an audio file</span><small>MP3, WAV, M4A · up to 150 MB</small></>}
            </div>
          ) : (
            <div className="youtube-box">
              <label htmlFor="youtube">YouTube link</label>
              <div className="url-input"><span>▶</span><input id="youtube" placeholder="https://youtu.be/…" value={youtubeUrl} onChange={(event) => setYoutubeUrl(event.target.value)} /></div>
              <p className={youtubeUrl && !validYoutubeUrl ? "input-error" : ""}>{youtubeUrl && !validYoutubeUrl ? "Enter a complete YouTube video link." : "Public YouTube audio is downloaded locally; the first 5 minutes are transcribed."}</p>
            </div>
          )}

          <div className="transcription-options">
            <div className="option-heading"><span className="eyebrow">PIANO TRANSCRIPTION</span><span className="quality-pill">Piano AI + cleanup</span></div>
            <label><span><b>Simultaneous notes</b><small>Detect chords instead of one melody line</small></span><input type="checkbox" checked readOnly /></label>
            <label><span><b>Grand staff</b><small>Split piano notes across treble and bass</small></span><input type="checkbox" checked readOnly /></label>
            <label><span><b>Local processing</b><small>The model runs on this computer</small></span><input type="checkbox" checked readOnly /></label>
          </div>

          <button className="button transcribe" onClick={analyzeSource} disabled={Boolean(analysis)}>
            <span>✦</span> {analysis ? "Transcribing piano…" : "Transcribe piano"}
          </button>
          {analysis && (
            <div className="analysis-card" role="status">
              <div><span>{analysis.label}</span><b>{analysis.progress}%</b></div>
              <i><span style={{ width: `${analysis.progress}%` }} /></i>
            </div>
          )}
          <p className="privacy-note"><span>⌾</span> Audio analysis stays private to this session.</p>
        </aside>

        <section className="editor-panel">
          <div className="notation-toolbar">
            <div className="tool-group">
              <button title="Undo">↶</button><button title="Redo">↷</button>
            </div>
            <div className="tool-group note-values">
              <button className="active" title="Quarter note">♩</button><button title="Eighth note">♪</button><button title="Half note">𝅗𝅥</button><button title="Whole note">𝅝</button>
            </div>
            <div className="tool-group">
              <button title="Move note down" onClick={() => transposeSelected(-1)}>♭</button>
              <button title="Move note up" onClick={() => transposeSelected(1)}>♯</button>
              <button title="Tie">⌒</button><button title="Dynamic">𝑓</button>
            </div>
            <div className="toolbar-spacer" />
            <label className="zoom-control"><span>−</span><input type="range" min="65" max="115" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /><span>＋</span><b>{zoom}%</b></label>
          </div>

          <div className="canvas-scroll">
            <div className="score-paper" style={{ transform: `scale(${zoom / 100})`, transformOrigin: "top center", marginBottom: `${(zoom - 85) * 4}px` }}>
              <div className="paper-texture" />
              <div className="score-heading">
                <input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Printed score title" />
                <input value={composer} onChange={(event) => setComposer(event.target.value)} aria-label="Composer or arranger" />
                <div className="score-meta"><span>Andante, con moto</span><span>♩ = {tempo}</span></div>
              </div>
              <div className="piano-score">
                {systemStarts.map((systemStart, systemIndex) => (
                  <PianoSystem key={systemStart} track={tracks[0]} systemStart={systemStart} showLabel={systemIndex === 0} selectedNote={selectedNote} onSelect={setSelectedNote} />
                ))}
              </div>
              <div className="page-footer"><span>ScoreCraft transcription</span><span>1</span></div>
            </div>
          </div>

          <div className="transport">
            <div className="time-display"><b>{formatClock(currentTime)}</b><span>/ {formatClock(duration)}</span></div>
            <span className="playback-source">Transcribed piano</span>
            <button className={looping ? "transport-active" : ""} onClick={() => setLooping(!looping)} title="Loop">↻</button>
            <button className="play-button" onClick={startPlayback} aria-label={playing ? "Pause score" : "Play score"}>{playing ? "Ⅱ" : "▶"}</button>
            <button onClick={() => stopPlayback(true)} title="Stop">■</button>
            <div className="timeline"><input type="range" min="0" max="100" step="0.1" value={playhead} onChange={(event) => setPlayhead(Number(event.target.value))} aria-label="Playback position" /><i style={{ width: `${playhead}%` }} /></div>
            <button className={metronome ? "transport-active" : ""} onClick={() => setMetronome(!metronome)} title="Metronome">♩</button>
            <label className="tempo-field"><input type="number" min="40" max="220" value={tempo} onChange={(event) => setTempo(Number(event.target.value))} /><span>BPM</span></label>
          </div>
        </section>

        <aside className="mixer-panel">
          <div className="mixer-heading"><span className="eyebrow">PIANO</span><span>1 grand-staff part</span></div>
          <div className="track-list">
            {tracks.map((track) => (
              <div className="mixer-track" key={track.id}>
                <div className="instrument-avatar" style={{ background: track.color }}>{track.abbreviation.slice(0, 2)}</div>
                <div className="track-main">
                  <div className="track-name"><b>{track.name}</b><span>Treble + bass</span></div>
                  <div className="track-controls">
                    <button className={track.muted ? "active" : ""} onClick={() => updateTrack(track.id, { muted: !track.muted })}>M</button>
                    <button className={track.solo ? "active solo" : ""} onClick={() => updateTrack(track.id, { solo: !track.solo })}>S</button>
                    <input type="range" min="0" max="100" value={track.volume} onChange={(event) => updateTrack(track.id, { volume: Number(event.target.value) })} aria-label={`${track.name} volume`} />
                    <span>{track.volume}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="inspector">
            <div className="mixer-heading"><span className="eyebrow">SELECTION</span><span>{selected ? noteLabel(selected.midi) : "—"}</span></div>
            <div className="selection-card">
              <span className="large-note">♪</span>
              <div><b>{selected ? noteLabel(selected.midi) : "No note"}</b><small>{selected ? `${selected.beats} beat duration` : "Click a note to edit"}</small></div>
              <button onClick={() => transposeSelected(-1)}>−</button><button onClick={() => transposeSelected(1)}>＋</button>
            </div>
          </div>

          <div className="tip-card"><span>⌘</span><p><b>Quick edit</b><br />Click any note on the score, then use ♭ or ♯ to correct its pitch.</p></div>
          <div className="status-message" aria-live="polite">{message}</div>
        </aside>
      </section>
    </main>
  );
}
