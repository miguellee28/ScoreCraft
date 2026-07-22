export const PIANO_TICKS_PER_BEAT = 16;
export const PIANO_TICK_BEATS = 1 / PIANO_TICKS_PER_BEAT;

export type PianoEngine = "transkun-2.0.1" | "basic-pitch";

export type TimedPianoEvent = {
  midi: number;
  startSeconds: number;
  durationSeconds: number;
  velocity: number;
};

export type QuantizedPianoEvent = TimedPianoEvent & {
  sourceIndex: number;
  startBeat: number;
  beats: number;
};

export function quantizeBeat(value: number) {
  return Math.round(value * PIANO_TICKS_PER_BEAT) / PIANO_TICKS_PER_BEAT;
}

export function quantizeTranskunDuration(rawBeats: number, startBeat: number) {
  const quarterBeatModulo = ((startBeat % 0.25) + 0.25) % 0.25;
  if (quarterBeatModulo > 1e-7) {
    const snappedEnd = Math.round((startBeat + rawBeats) * 4) / 4;
    return Math.max(PIANO_TICK_BEATS, snappedEnd - startBeat);
  }
  const learnedIntervals: Array<[number, number]> = [
    [0.11148, 0.125], [0.29338, 0.25], [0.58724, 0.5], [0.78084, 0.75],
    [1.07494, 1], [1.28524, 1.25], [1.57576, 1.5], [2.28785, 2],
    [2.75502, 2.5], [3.26277, 3], [3.41602, 3.75], [Number.POSITIVE_INFINITY, 4],
  ];
  const repaired = learnedIntervals.find(([upper]) => rawBeats < upper)?.[1] ?? rawBeats;
  return Math.max(PIANO_TICK_BEATS, rawBeats > 4.25 ? quantizeBeat(rawBeats) : repaired);
}

export function repairRolledChordDurations<T extends { startBeat: number; beats: number }>(events: T[]) {
  const repaired = events.map((event) => ({ ...event }));
  const starts = [...new Set(repaired.map((event) => event.startBeat))].sort((a, b) => a - b);
  for (const start of starts) {
    const firstOnset = repaired.filter((event) => event.startBeat === start);
    const roll = repaired.filter((event) => event.startBeat >= start && event.startBeat <= start + 0.125);
    const distinctOnsets = new Set(roll.map((event) => event.startBeat));
    if (
      firstOnset.length < 3
      || roll.length < 5
      || distinctOnsets.size < 3
      || Math.max(...roll.map((event) => event.beats)) > 2.5
    ) continue;

    const endCounts = new Map<number, number>();
    roll.forEach((event) => {
      const end = event.startBeat + event.beats;
      endCounts.set(end, (endCounts.get(end) ?? 0) + 1);
    });
    const targetEnd = [...endCounts.entries()].sort((a, b) => (
      b[1] - a[1]
      || Number(b[0] % 4 === 0) - Number(a[0] % 4 === 0)
      || b[0] - a[0]
    ))[0]?.[0];
    if (targetEnd === undefined) continue;
    roll.forEach((event) => {
      event.beats = Math.max(PIANO_TICK_BEATS, targetEnd - event.startBeat);
    });
  }
  return repaired;
}

function sameBeat(left: number, right: number) {
  return Math.abs(left - right) < 1e-8;
}

export function mergePianoDurationHints(
  primaryEvents: QuantizedPianoEvent[],
  hintEvents: TimedPianoEvent[],
  tempo: number,
) {
  if (!primaryEvents.length || !hintEvents.length) return primaryEvents;
  const secondsPerBeat = 60 / tempo;
  const hintOrigin = Math.max(0, Math.min(...hintEvents.map((note) => note.startSeconds)));
  const hints = hintEvents.map((note, id) => ({
    ...note,
    id,
    startBeat: Math.max(0, quantizeBeat((note.startSeconds - hintOrigin) / secondsPerBeat)),
    beats: Math.max(0.25, Math.round((note.durationSeconds / secondsPerBeat) * 4) / 4),
  }));
  const usedHints = new Set<number>();
  const byPitch = new Map<number, QuantizedPianoEvent[]>();
  primaryEvents.forEach((note) => byPitch.set(note.midi, [...(byPitch.get(note.midi) ?? []), note]));
  byPitch.forEach((notes) => notes.sort((a, b) => a.startBeat - b.startBeat));

  return primaryEvents.map((note) => {
    const hint = hints
      .filter((candidate) => !usedHints.has(candidate.id) && candidate.midi === note.midi && sameBeat(candidate.startBeat, note.startBeat))
      .sort((a, b) => Math.abs(a.startSeconds - note.startSeconds) - Math.abs(b.startSeconds - note.startSeconds))[0];
    if (!hint) return note;
    usedHints.add(hint.id);
    const pitchNotes = byPitch.get(note.midi) ?? [];
    const pitchIndex = pitchNotes.findIndex((candidate) => candidate.sourceIndex === note.sourceIndex);
    const nextSamePitchGap = pitchIndex >= 0 && pitchIndex + 1 < pitchNotes.length
      ? pitchNotes[pitchIndex + 1].startBeat - note.startBeat
      : Number.POSITIVE_INFINITY;
    const onsetSize = primaryEvents.filter((candidate) => sameBeat(candidate.startBeat, note.startBeat)).length;
    const rawPrimaryBeats = note.durationSeconds / secondsPerBeat;

    let beats = note.beats;
    if (sameBeat(beats, 0.75) && sameBeat(hint.beats, 1) && note.midi >= 48) beats = 1;
    else if (
      sameBeat(beats, 0.5)
      && sameBeat(hint.beats, 0.25)
      && rawPrimaryBeats < 0.32
      && nextSamePitchGap > 4
    ) beats = 0.25;
    else if (
      sameBeat(beats, 1)
      && sameBeat(hint.beats, 0.75)
      && rawPrimaryBeats < 0.79
      && onsetSize <= 2
    ) beats = 0.75;
    else if (
      sameBeat(beats, 0.25)
      && sameBeat(hint.beats, 0.5)
      && note.midi < 60
      && sameBeat(nextSamePitchGap, 0.5)
    ) beats = 0.5;
    return beats === note.beats ? note : { ...note, beats };
  });
}

export function repairScoreContextDurations(events: QuantizedPianoEvent[], tempo: number) {
  const repaired = events.map((event) => ({ ...event }));
  if (!repaired.length) return repaired;
  const secondsPerBeat = 60 / tempo;
  const starts = [...new Set(repaired.map((note) => note.startBeat))].sort((a, b) => a - b);
  const groups = new Map(starts.map((start) => [
    start,
    repaired.filter((note) => sameBeat(note.startBeat, start)),
  ]));
  const baseline = new Map(repaired.map((note) => [note.sourceIndex, note.beats]));
  const baseDuration = (note: QuantizedPianoEvent) => baseline.get(note.sourceIndex) ?? note.beats;
  const rawDuration = (note: QuantizedPianoEvent) => note.durationSeconds / secondsPerBeat;
  const hand = (midi: number) => midi < 60 ? 0 : 1;
  const nextGap = (
    note: QuantizedPianoEvent,
    predicate: (notes: QuantizedPianoEvent[]) => boolean,
  ) => {
    const next = starts.find((start) => start > note.startBeat && predicate(groups.get(start) ?? []));
    return next === undefined ? null : next - note.startBeat;
  };
  const contexts = repaired.map((note) => {
    const nextStart = starts.find((start) => start > note.startBeat);
    return {
      same: nextGap(note, (notes) => notes.some((candidate) => candidate.midi === note.midi)),
      any: nextGap(note, () => true),
      sameHand: nextGap(note, (notes) => notes.some((candidate) => hand(candidate.midi) === hand(note.midi))),
      near5: nextGap(note, (notes) => notes.some((candidate) => Math.abs(candidate.midi - note.midi) <= 5)),
      near7: nextGap(note, (notes) => notes.some((candidate) => Math.abs(candidate.midi - note.midi) <= 7)),
      nextMax: nextStart === undefined
        ? null
        : Math.max(...(groups.get(nextStart) ?? []).map((candidate) => candidate.midi)),
    };
  });

  // Repeated local phrases provide independent evidence for the intended release.
  const signature = (note: QuantizedPianoEvent) => `${note.midi}/${repaired
    .filter((candidate) => Math.abs(candidate.startBeat - note.startBeat) <= 1)
    .map((candidate) => `${quantizeBeat(candidate.startBeat - note.startBeat)}:${candidate.midi}`)
    .sort()
    .join("|")}`;
  const motifs = new Map<string, QuantizedPianoEvent[]>();
  repaired.forEach((note) => motifs.set(signature(note), [...(motifs.get(signature(note)) ?? []), note]));
  (["max", "mean"] as const).forEach((aggregate) => repaired.forEach((note, index) => {
    const motif = motifs.get(signature(note)) ?? [];
    if (motif.length < 2) return;
    const average = motif.reduce((sum, candidate) => sum + rawDuration(candidate), 0) / motif.length;
    const deviation = Math.sqrt(motif.reduce((sum, candidate) => (
      sum + (rawDuration(candidate) - average) ** 2
    ), 0) / motif.length);
    const aggregateRaw = aggregate === "max"
      ? Math.max(...motif.map(rawDuration))
      : average;
    const candidate = quantizeTranskunDuration(aggregateRaw, note.startBeat);
    const endpoints = Object.values(contexts[index]).filter((value): value is number => value !== null);
    if (
      !sameBeat(candidate, baseDuration(note))
      && endpoints.some((endpoint) => sameBeat(endpoint, candidate))
      && deviation / Math.max(average, 1e-6) <= 0.5
      && rawDuration(note) / Math.max(aggregateRaw, 1e-6) >= 0.35
    ) note.beats = candidate;
  }));

  // Notes struck together usually share a release, even when one string decays sooner.
  repaired.forEach((note) => {
    const chord = groups.get(note.startBeat) ?? [];
    const longer = [...new Set(chord.map(baseDuration).filter((duration) => duration > baseDuration(note)))]
      .sort((a, b) => b - a);
    for (const candidate of longer) {
      const support = chord.filter((member) => sameBeat(baseDuration(member), candidate));
      if (
        support.length
        && Math.min(...support.map((member) => Math.abs(member.midi - note.midi))) <= 7
        && rawDuration(note) / candidate >= 0.55
      ) {
        note.beats = candidate;
        break;
      }
    }
  });

  // A high melody tone can decay before its written release; follow its next nearby attack.
  repaired.forEach((note, index) => {
    const context = contexts[index];
    if (
      context.near7 !== null
      && context.near7 > baseDuration(note)
      && context.near7 <= 4
      && rawDuration(note) >= 0.6
      && context.nextMax !== null
      && note.midi - context.nextMax >= 9
    ) note.beats = context.near7;
  });

  // Rolled chords start on adjacent 64th-note slots but converge on one release point.
  const rollGroups: QuantizedPianoEvent[][] = [];
  starts.forEach((start, index) => {
    const rollStarts = [start];
    for (let cursor = index + 1; cursor < starts.length; cursor += 1) {
      if (starts[cursor] - starts[cursor - 1] > PIANO_TICK_BEATS + 1e-9) break;
      if (starts[cursor] - start > 0.125 + 1e-9) break;
      rollStarts.push(starts[cursor]);
    }
    const notes = rollStarts.flatMap((rollStart) => groups.get(rollStart) ?? []);
    if (rollStarts.length >= 2 && notes.length >= 3) rollGroups.push(notes);
  });
  rollGroups.forEach((roll) => {
    const ends = roll.map((note) => quantizeBeat(note.startBeat + baseDuration(note)));
    const counts = new Map([...new Set(ends)].map((end) => [
      end,
      ends.filter((candidate) => sameBeat(candidate, end)).length,
    ]));
    const [targetEnd, support] = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    if (support < 2) return;
    roll.forEach((note) => {
      const candidate = targetEnd - note.startBeat;
      const offQuarter = ((note.startBeat % 0.25) + 0.25) % 0.25 > 1e-7;
      if (candidate >= PIANO_TICK_BEATS && (candidate > note.beats || offQuarter)) note.beats = candidate;
    });
  });

  // Three long chord tones are enough evidence to restore one early-decaying member.
  repaired.forEach((note) => {
    const chord = groups.get(note.startBeat) ?? [];
    const candidates = [...new Set(chord
      .map(baseDuration)
      .filter((duration) => duration > baseDuration(note) && duration >= 2))]
      .sort((a, b) => b - a);
    for (const candidate of candidates) {
      if (
        chord.filter((member) => sameBeat(baseDuration(member), candidate)).length >= 3
        && rawDuration(note) / candidate >= 0.5
      ) {
        note.beats = candidate;
        break;
      }
    }
  });

  // Sparse melodic pickups need a small notation prior when audio decay has no frame evidence.
  repaired.forEach((note, index) => {
    const context = contexts[index];
    if (
      sameBeat(baseDuration(note), 0.25)
      && sameBeat(context.same ?? -1, 0.5)
      && sameBeat(context.near7 ?? -1, 0.5)
    ) note.beats = 0.5;
    if (
      sameBeat(baseDuration(note), 0.25)
      && rawDuration(note) <= 0.125
      && (groups.get(note.startBeat)?.length ?? 0) === 1
      && context.any !== null
      && context.any >= 1
      && context.near7 !== null
      && context.near7 >= 1
    ) note.beats = Math.min(0.5, context.any / 2);
  });
  return repaired;
}

export function quantizePianoEvents(
  events: TimedPianoEvent[],
  tempo: number,
  engine: PianoEngine,
) {
  if (!events.length) return [];
  const scoreOriginSeconds = Math.max(0, Math.min(...events.map((note) => note.startSeconds)));
  const secondsPerBeat = 60 / tempo;
  const quantized = events.map((note, sourceIndex) => {
    const startBeat = Math.max(0, quantizeBeat((note.startSeconds - scoreOriginSeconds) / secondsPerBeat));
    const rawDurationBeats = note.durationSeconds / secondsPerBeat;
    return {
      ...note,
      sourceIndex,
      startBeat,
      beats: engine === "transkun-2.0.1"
        ? quantizeTranskunDuration(rawDurationBeats, startBeat)
        : Math.max(PIANO_TICK_BEATS, quantizeBeat(rawDurationBeats)),
    };
  });
  if (engine !== "transkun-2.0.1") return quantized;
  return repairScoreContextDurations(quantized, tempo);
}
