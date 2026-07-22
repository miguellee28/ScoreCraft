import { BasicPitch, noteFramesToTime, outputToNotesPoly } from "@spotify/basic-pitch";

export type PianoNoteEvent = {
  midi: number;
  startSeconds: number;
  durationSeconds: number;
  velocity: number;
};

export type PianoTranscriptionResult = {
  notes: PianoNoteEvent[];
  tempo: number;
  engine: "transkun-2.0.1" | "basic-pitch";
  durationHints?: PianoNoteEvent[];
};

type LocalTranscriptionResponse = {
  engine?: "transkun-2.0.1";
  notes?: PianoNoteEvent[];
  error?: string;
  unavailable?: boolean;
};

class LocalModelUnavailableError extends Error {}

let modelPromise: Promise<BasicPitch> | null = null;

const PIANO_PROFILE = {
  onsetThreshold: 0.48,
  frameThreshold: 0.33,
  minimumNoteLengthFrames: 7,
  minimumVelocity: 30,
  shortArtifactMaximumSeconds: 0.25,
  shortArtifactMinimumVelocity: 55,
  maximumFragmentMergeBeats: 0.92,
} as const;

function getModel() {
  if (!modelPromise) {
    modelPromise = Promise.resolve(new BasicPitch("/basic-pitch/model.json"));
  }
  return modelPromise;
}

async function transcribeWithLocalModel(
  file: File,
  onProgress: (progress: number, label: string) => void,
) {
  let progress = 25;
  const progressTimer = window.setInterval(() => {
    progress = Math.min(88, progress + Math.max(1, Math.round((88 - progress) * 0.035)));
    onProgress(progress, "Tracing complete piano notes locally (CPU; long recordings take several minutes)");
  }, 5_000);
  try {
    onProgress(progress, "Starting the high-accuracy local piano model");
    const response = await fetch("/__local/piano-transcribe", {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-ScoreCraft-Filename": encodeURIComponent(file.name),
      },
      body: file,
    });
    const result = await response.json().catch(() => ({})) as LocalTranscriptionResponse;
    if (!response.ok) {
      if (response.status === 404 || response.status === 503 || result.unavailable) {
        throw new LocalModelUnavailableError(result.error || "The high-accuracy local piano model is unavailable.");
      }
      throw new Error(result.error || "The high-accuracy local piano model failed.");
    }
    if (!result.notes?.length) throw new Error("The high-accuracy local piano model returned no notes.");
    onProgress(92, `Recovered ${result.notes.length} complete piano notes`);
    return result.notes;
  } finally {
    window.clearInterval(progressTimer);
  }
}

function estimateTempo(audio: AudioBuffer) {
  const samples = audio.getChannelData(0);
  const frameSize = 1_024;
  const hopSize = 256;
  const energies: number[] = [];
  for (let offset = 0; offset + frameSize <= samples.length; offset += hopSize) {
    let energy = 0;
    for (let index = offset; index < offset + frameSize; index += 1) energy += samples[index] * samples[index];
    energies.push(Math.log1p((energy / frameSize) * 100));
  }
  const onsets = energies.slice(1).map((energy, index) => Math.max(0, energy - energies[index]));
  const mean = onsets.reduce((sum, value) => sum + value, 0) / Math.max(1, onsets.length);
  const variance = onsets.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, onsets.length);
  const deviation = Math.sqrt(variance) || 1;
  const normalized = onsets.map((value) => (value - mean) / deviation);
  const framesPerSecond = audio.sampleRate / hopSize;
  let bestTempo = 86;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let tempo = 55; tempo <= 130; tempo += 0.25) {
    const lag = framesPerSecond * 60 / tempo;
    const lower = Math.floor(lag);
    const upper = lower + 1;
    const blend = lag - lower;
    let lowerCorrelation = 0;
    let upperCorrelation = 0;
    for (let index = 0; index + upper < normalized.length; index += 1) {
      lowerCorrelation += normalized[index] * normalized[index + lower];
      upperCorrelation += normalized[index] * normalized[index + upper];
    }
    const correlation = lowerCorrelation * (1 - blend) + upperCorrelation * blend;
    const musicalRangePreference = Math.exp(-0.5 * ((tempo - 84) / 30) ** 2);
    const score = correlation * musicalRangePreference;
    if (score > bestScore) {
      bestScore = score;
      bestTempo = tempo;
    }
  }
  return Math.round(bestTempo);
}

function normalizeDetectedNotes(notes: PianoNoteEvent[]) {
  const byPitch = new Map<number, PianoNoteEvent[]>();
  notes.forEach((note) => byPitch.set(note.midi, [...(byPitch.get(note.midi) ?? []), note]));

  const normalized: PianoNoteEvent[] = [];
  byPitch.forEach((pitchNotes) => {
    const kept: PianoNoteEvent[] = [];
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
        const duplicateOnset = onsetDistance < 0.075;
        if (duplicateOnset) {
          previous.durationSeconds = Math.max(previousEnd, note.startSeconds + note.durationSeconds) - previous.startSeconds;
          previous.velocity = Math.max(previous.velocity, note.velocity);
          return;
        }

        if (note.startSeconds < previousEnd) {
          previous.durationSeconds = Math.max(0.08, note.startSeconds - previous.startSeconds - 0.015);
        }
        kept.push({ ...note });
      });
    normalized.push(...kept);
  });
  return normalized.sort((a, b) => a.startSeconds - b.startSeconds || b.velocity - a.velocity || a.midi - b.midi);
}

function mergeSamePitchFragments(notes: PianoNoteEvent[], tempo: number) {
  const maximumOnsetDistanceSeconds = PIANO_PROFILE.maximumFragmentMergeBeats * 60 / tempo;
  const byPitch = new Map<number, PianoNoteEvent[]>();
  notes.forEach((note) => byPitch.set(note.midi, [...(byPitch.get(note.midi) ?? []), note]));

  const repaired: PianoNoteEvent[] = [];
  byPitch.forEach((pitchNotes) => {
    const kept: PianoNoteEvent[] = [];
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
        if (
          onsetDistance <= maximumOnsetDistanceSeconds
          && (weakContinuation || overlappingArtifact)
        ) {
          previous.durationSeconds = Math.max(previousEnd, note.startSeconds + note.durationSeconds) - previous.startSeconds;
          previous.velocity = Math.max(previous.velocity, note.velocity);
          return;
        }

        if (note.startSeconds < previousEnd) {
          previous.durationSeconds = Math.max(0.08, note.startSeconds - previous.startSeconds - 0.015);
        }
        kept.push({ ...note });
      });
    repaired.push(...kept);
  });

  return repaired.sort((a, b) => a.startSeconds - b.startSeconds || b.velocity - a.velocity || a.midi - b.midi);
}

async function transcribeWithBrowserModel(
  audio: AudioBuffer,
  tempo: number,
  onProgress?: (percent: number) => void,
) {
  const model = await getModel();
  const frames: number[][] = [];
  const onsets: number[][] = [];
  await model.evaluateModel(
    audio,
    (nextFrames, nextOnsets) => {
      frames.push(...nextFrames);
      onsets.push(...nextOnsets);
    },
    (percent) => onProgress?.(percent),
  );

  const detected = noteFramesToTime(outputToNotesPoly(
    frames,
    onsets,
    PIANO_PROFILE.onsetThreshold,
    PIANO_PROFILE.frameThreshold,
    PIANO_PROFILE.minimumNoteLengthFrames,
    true,
    4200,
    27.5,
  ))
    .map((note) => ({
      midi: note.pitchMidi,
      startSeconds: note.startTimeSeconds,
      durationSeconds: note.durationSeconds,
      velocity: Math.round(note.amplitude * 127),
    }))
    .filter((note) => (
      note.midi >= 24
      && note.midi <= 100
      && note.durationSeconds >= 0.1
      && note.velocity >= PIANO_PROFILE.minimumVelocity
    ))
    .sort((a, b) => a.startSeconds - b.startSeconds || b.velocity - a.velocity || a.midi - b.midi);

  const shortArtifactMaximumSeconds = Math.min(
    PIANO_PROFILE.shortArtifactMaximumSeconds,
    15 / tempo,
  );
  const cleaned = normalizeDetectedNotes(detected).filter((note) => (
    note.durationSeconds >= shortArtifactMaximumSeconds
    || note.velocity >= PIANO_PROFILE.shortArtifactMinimumVelocity
  ));
  return mergeSamePitchFragments(cleaned, tempo);
}

export async function transcribePiano(
  file: File,
  onProgress: (progress: number, label: string) => void,
): Promise<PianoTranscriptionResult> {
  const context = new AudioContext();
  try {
    onProgress(14, "Decoding the piano recording");
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    const analyzedSeconds = Math.min(decoded.duration, 300);

    onProgress(20, "Preparing clean mono audio for the piano model");
    const offline = new OfflineAudioContext(1, Math.ceil(analyzedSeconds * 22_050), 22_050);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0, 0, analyzedSeconds);
    const audio = await offline.startRendering();
    const detectedTempo = estimateTempo(audio);
    try {
      const localNotes = await transcribeWithLocalModel(file, onProgress);
      onProgress(96, "Reconstructing score timing for playback and notation");
      return { notes: localNotes, tempo: detectedTempo, engine: "transkun-2.0.1" };
    } catch (error) {
      if (!(error instanceof LocalModelUnavailableError)) throw error;
      onProgress(25, "High-accuracy model is not installed; using the browser piano model");
    }

    const repaired = await transcribeWithBrowserModel(audio, detectedTempo, (percent) => {
      onProgress(28 + Math.round(percent * 62), "Separating melody, chords, and bass notes");
    });
    onProgress(96, "Preparing the readable grand staff");
    return { notes: repaired, tempo: detectedTempo, engine: "basic-pitch" };
  } finally {
    await context.close();
  }
}
