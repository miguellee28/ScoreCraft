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
};

let modelPromise: Promise<BasicPitch> | null = null;

function getModel() {
  if (!modelPromise) {
    modelPromise = Promise.resolve(new BasicPitch("/basic-pitch/model.json"));
  }
  return modelPromise;
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

    onProgress(25, "Loading the local polyphonic piano model");
    const model = await getModel();
    const frames: number[][] = [];
    const onsets: number[][] = [];

    await model.evaluateModel(
      audio,
      (nextFrames, nextOnsets) => {
        frames.push(...nextFrames);
        onsets.push(...nextOnsets);
      },
      (percent) => onProgress(
        28 + Math.round(percent * 62),
        "Separating melody, chords, and bass notes",
      ),
    );

    onProgress(92, "Removing weak and duplicate piano artifacts");
    const detected = noteFramesToTime(outputToNotesPoly(
      frames,
      onsets,
      0.55,
      0.4,
      10,
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
        && note.velocity >= 45
      ))
      .sort((a, b) => a.startSeconds - b.startSeconds || b.velocity - a.velocity || a.midi - b.midi);

    const cleaned = detected.filter((note, index) => !detected
      .slice(Math.max(0, index - 20), index)
      .some((previous) => (
        previous.midi === note.midi
        && Math.abs(previous.startSeconds - note.startSeconds) < 0.075
      )));

    onProgress(96, "Preparing the readable grand staff");
    return { notes: cleaned, tempo: detectedTempo };
  } finally {
    await context.close();
  }
}
