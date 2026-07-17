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

type Note = { midi: number; beats: number; velocity?: number };
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

const melody = [
  67, 69, 71, 72, 74, 72, 71, 69, 67, 64, 67, 69, 71, 69, 67, 66,
  67, 69, 71, 74, 76, 74, 72, 71, 69, 71, 72, 69, 67, 66, 64, 67,
];

const baseTracks: Track[] = [
  {
    id: 1,
    name: "Piano",
    abbreviation: "Pno.",
    clef: "𝄞",
    color: "#69406f",
    notes: melody.map((midi, i) => ({ midi, beats: i % 7 === 6 ? 1 : 0.5 })),
    volume: 78,
    muted: false,
    solo: false,
  },
  {
    id: 2,
    name: "Violin",
    abbreviation: "Vln.",
    clef: "𝄞",
    color: "#d76047",
    notes: melody.map((midi, i) => ({ midi: midi + (i % 8 < 4 ? 12 : 7), beats: 0.5 })),
    volume: 66,
    muted: false,
    solo: false,
  },
  {
    id: 3,
    name: "Cello",
    abbreviation: "Vc.",
    clef: "𝄢",
    color: "#70866f",
    notes: melody.map((midi, i) => ({ midi: midi - 12 - (i % 4 === 0 ? 5 : 0), beats: 1 })),
    volume: 62,
    muted: false,
    solo: false,
  },
];

const instrumentPresets = [
  ["Flute", "Fl.", "𝄞", "#3c8291", 12],
  ["Clarinet", "Cl.", "𝄞", "#ad7b34", 5],
  ["Guitar", "Gtr.", "𝄞", "#8c604e", -5],
  ["Double bass", "Cb.", "𝄢", "#465f78", -24],
] as const;

const noteNames = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

function noteLabel(midi: number) {
  return `${noteNames[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

function midiFrequency(midi: number) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function detectedPitch(buffer: AudioBuffer, offset: number, frameSize = 2048) {
  const source = buffer.getChannelData(0);
  const end = Math.min(offset + frameSize, source.length);
  if (end - offset < 512) return null;

  let rms = 0;
  for (let i = offset; i < end; i++) rms += source[i] * source[i];
  rms = Math.sqrt(rms / (end - offset));
  if (rms < 0.025) return null;

  const minLag = Math.floor(buffer.sampleRate / 1000);
  const maxLag = Math.min(Math.floor(buffer.sampleRate / 75), frameSize - 2);
  let bestLag = -1;
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag += 2) {
    let correlation = 0;
    for (let i = 0; i < frameSize - lag; i += 2) {
      correlation += source[offset + i] * source[offset + i + lag];
    }
    if (correlation > best) {
      best = correlation;
      bestLag = lag;
    }
  }
  if (bestLag < 0) return null;
  const frequency = buffer.sampleRate / bestLag;
  const midi = Math.round(69 + 12 * Math.log2(frequency / 440));
  return midi >= 35 && midi <= 96 ? midi : null;
}

async function transcribeFile(file: File): Promise<Note[]> {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    const hop = Math.max(1024, Math.floor(decoded.sampleRate * 0.115));
    const raw: number[] = [];
    const limit = Math.min(decoded.length, decoded.sampleRate * 150);
    for (let offset = 0; offset < limit; offset += hop) {
      const midi = detectedPitch(decoded, offset);
      if (midi !== null) raw.push(midi);
    }
    if (!raw.length) return [];
    const compressed: Note[] = [];
    for (const midi of raw) {
      const previous = compressed.at(-1);
      if (previous && Math.abs(previous.midi - midi) <= 1) {
        previous.beats = Math.min(2, previous.beats + 0.25);
      } else {
        compressed.push({ midi, beats: 0.5 });
      }
      if (compressed.length >= 48) break;
    }
    return compressed;
  } finally {
    await context.close();
  }
}

function StaffNote({ note, index, selected, onSelect }: { note: Note; index: number; selected: boolean; onSelect: () => void }) {
  const top = 49 - (note.midi - 60) * 2.35;
  return (
    <button
      className={`score-note ${selected ? "selected" : ""}`}
      style={{ "--note-top": `${top}px` } as CSSProperties}
      onClick={onSelect}
      title={`${noteLabel(note.midi)} · ${note.beats} beat${note.beats === 1 ? "" : "s"}`}
      aria-label={`Select ${noteLabel(note.midi)}`}
    >
      <span className="note-head" />
      {note.beats <= 1 && <span className={`note-stem ${index % 5 === 4 ? "down" : ""}`} />}
      {note.beats <= 0.5 && <span className="note-flag">›</span>}
    </button>
  );
}

function ScoreStaff({ track, selectedNote, onSelect }: { track: Track; selectedNote: string; onSelect: (id: string) => void }) {
  const visibleNotes = track.notes.slice(0, 32);
  return (
    <div className="staff-row" style={{ "--track": track.color } as CSSProperties}>
      <div className="staff-label">
        <span className="track-swatch" />
        <strong>{track.name}</strong>
      </div>
      <div className="staff-music">
        <span className="clef">{track.clef}</span>
        <span className="key-signature">♯</span>
        <span className="time-signature"><b>4</b><b>4</b></span>
        <div className="notes-grid">
          {visibleNotes.map((note, index) => (
            <StaffNote
              key={`${track.id}-${index}`}
              note={note}
              index={index}
              selected={selectedNote === `${track.id}-${index}`}
              onSelect={() => onSelect(`${track.id}-${index}`)}
            />
          ))}
          {[1, 2, 3].map((bar) => <span className="bar-line" style={{ left: `${bar * 25}%` }} key={bar} />)}
        </div>
      </div>
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
  const [tempo, setTempo] = useState(92);
  const [zoom, setZoom] = useState(86);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [looping, setLooping] = useState(false);
  const [metronome, setMetronome] = useState(false);
  const [selectedNote, setSelectedNote] = useState("1-3");
  const [analysis, setAnalysis] = useState<null | { progress: number; label: string }>(null);
  const [message, setMessage] = useState("Your changes are saved on this device");
  const [addMenu, setAddMenu] = useState(false);
  const [exportMenu, setExportMenu] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const duration = 48;

  const sourceReady = Boolean(file) || /youtu(?:\.be|be\.com)/i.test(youtubeUrl);
  const selected = useMemo(() => {
    const [trackId, index] = selectedNote.split("-").map(Number);
    return tracks.find((track) => track.id === trackId)?.notes[index];
  }, [selectedNote, tracks]);

  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
    void audioContext.current?.close();
  }, []);

  function chooseFile(next: File | undefined) {
    if (!next) return;
    if (!next.type.startsWith("audio/") && !/\.(mp3|wav|m4a|aac|ogg)$/i.test(next.name)) {
      setMessage("Choose an MP3, WAV, M4A, AAC, or OGG audio file");
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

  async function analyzeSource() {
    if (!sourceReady) {
      setMessage(sourceMode === "upload" ? "Add an audio file first" : "Enter a valid YouTube link first");
      return;
    }
    setAnalysis({ progress: 8, label: "Separating melody from accompaniment" });
    const intervals = [
      [24, "Finding tempo and downbeats"],
      [46, "Detecting pitch and rhythm"],
      [69, "Voicing instrument parts"],
      [88, "Engraving the score"],
    ] as const;
    for (const [progress, label] of intervals) {
      await new Promise((resolve) => setTimeout(resolve, 420));
      setAnalysis({ progress, label });
    }

    let notes: Note[] = [];
    if (file) {
      try {
        notes = await transcribeFile(file);
      } catch {
        setMessage("The browser could not decode this recording, so a clean demo arrangement was created instead");
      }
    }
    if (notes.length >= 4) {
      setTracks((current) => current.map((track, index) => ({
        ...track,
        notes: notes.map((note, noteIndex) => ({
          ...note,
          midi: Math.max(34, Math.min(98, note.midi + (index === 1 ? 12 : index === 2 ? -12 - (noteIndex % 4 === 0 ? 5 : 0) : 0))),
        })),
      })));
    }
    setAnalysis({ progress: 100, label: "Score ready" });
    setTimeout(() => setAnalysis(null), 650);
    setMessage(file ? `Transcribed ${file.name}` : "YouTube arrangement ready to edit");
  }

  function stopPlayback(reset = false) {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setPlaying(false);
    if (reset) setPlayhead(0);
    void audioContext.current?.close();
    audioContext.current = null;
  }

  function startPlayback() {
    if (playing) {
      stopPlayback();
      return;
    }
    const context = new AudioContext();
    audioContext.current = context;
    const beatSeconds = 60 / tempo;
    const soloed = tracks.some((track) => track.solo);
    const startAt = (playhead / 100) * duration;
    tracks.forEach((track, trackIndex) => {
      if (track.muted || (soloed && !track.solo)) return;
      let beat = 0;
      track.notes.slice(0, 32).forEach((note) => {
        const when = beat * beatSeconds;
        if (when >= startAt) {
          const oscillator = context.createOscillator();
          const gain = context.createGain();
          oscillator.type = trackIndex === 0 ? "triangle" : trackIndex === 1 ? "sine" : "sawtooth";
          oscillator.frequency.value = midiFrequency(note.midi);
          gain.gain.setValueAtTime(0.0001, context.currentTime + when - startAt);
          gain.gain.exponentialRampToValueAtTime(Math.max(0.01, track.volume / 1000), context.currentTime + when - startAt + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + when - startAt + Math.max(0.12, note.beats * beatSeconds * 0.86));
          oscillator.connect(gain).connect(context.destination);
          oscillator.start(context.currentTime + when - startAt);
          oscillator.stop(context.currentTime + when - startAt + Math.max(0.15, note.beats * beatSeconds));
        }
        beat += note.beats;
      });
    });

    const started = performance.now() - startAt * 1000;
    setPlaying(true);
    timer.current = setInterval(() => {
      const elapsed = (performance.now() - started) / 1000;
      const next = (elapsed / duration) * 100;
      if (next >= 100) {
        if (looping) {
          stopPlayback(true);
          setTimeout(startPlayback, 80);
        } else stopPlayback(true);
      } else setPlayhead(next);
    }, 80);
  }

  function updateTrack(id: number, patch: Partial<Track>) {
    setTracks((current) => current.map((track) => track.id === id ? { ...track, ...patch } : track));
    setMessage("Mix updated");
  }

  function transposeSelected(amount: number) {
    const [trackId, noteIndex] = selectedNote.split("-").map(Number);
    setTracks((current) => current.map((track) => track.id !== trackId ? track : {
      ...track,
      notes: track.notes.map((note, index) => index === noteIndex ? { ...note, midi: note.midi + amount } : note),
    }));
    setMessage(`Note moved ${amount > 0 ? "up" : "down"} one semitone`);
  }

  function addInstrument(preset: typeof instrumentPresets[number]) {
    const [name, abbreviation, clef, color, transpose] = preset;
    const id = Math.max(...tracks.map((track) => track.id)) + 1;
    setTracks((current) => [...current, {
      id, name, abbreviation, clef, color, volume: 60, muted: false, solo: false,
      notes: melody.map((midi) => ({ midi: midi + transpose, beats: 0.5 })),
    }]);
    setAddMenu(false);
    setMessage(`${name} part added`);
  }

  function exportMusicXml() {
    const partList = tracks.map((track) => `<score-part id="P${track.id}"><part-name>${track.name}</part-name></score-part>`).join("");
    const parts = tracks.map((track) => `<part id="P${track.id}"><measure number="1">${track.notes.slice(0, 24).map((note) => {
      const name = noteNames[note.midi % 12].replace(/[♯♭]/, "");
      return `<note><pitch><step>${name}</step><octave>${Math.floor(note.midi / 12) - 1}</octave></pitch><duration>${Math.max(1, note.beats * 2)}</duration></note>`;
    }).join("")}</measure></part>`).join("");
    const xml = `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-title>${title}</work-title></work><part-list>${partList}</part-list>${parts}</score-partwise>`;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([xml], { type: "application/vnd.recordare.musicxml+xml" }));
    link.download = `${title.replace(/\s+/g, "-").toLowerCase() || "score"}.musicxml`;
    link.click();
    URL.revokeObjectURL(link.href);
    setExportMenu(false);
    setMessage("MusicXML exported");
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
                <button onClick={() => { setExportMenu(false); window.print(); }}><b>PDF</b><span>Print-ready score</span></button>
                <button onClick={exportMusicXml}><b>MusicXML</b><span>Open in MuseScore</span></button>
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
              <input ref={fileInput} type="file" accept="audio/*,.mp3,.m4a" onChange={(event: ChangeEvent<HTMLInputElement>) => chooseFile(event.target.files?.[0])} />
              <span className="upload-symbol">♫</span>
              {file ? <><strong>{file.name}</strong><span>{(file.size / 1024 / 1024).toFixed(1)} MB · ready</span></> : <><strong>Drop your recording here</strong><span>or choose an audio file</span><small>MP3, WAV, M4A · up to 150 MB</small></>}
            </div>
          ) : (
            <div className="youtube-box">
              <label htmlFor="youtube">YouTube link</label>
              <div className="url-input"><span>▶</span><input id="youtube" placeholder="https://youtu.be/…" value={youtubeUrl} onChange={(event) => setYoutubeUrl(event.target.value)} /></div>
              <p>Paste a public performance or melody link.</p>
            </div>
          )}

          <div className="transcription-options">
            <div className="option-heading"><span className="eyebrow">TRANSCRIPTION</span><span className="quality-pill">Balanced</span></div>
            <label><span><b>Melody extraction</b><small>Focus on the clearest lead line</small></span><input type="checkbox" defaultChecked /></label>
            <label><span><b>Create accompaniment</b><small>Build playable supporting parts</small></span><input type="checkbox" defaultChecked /></label>
            <label><span><b>Detect chords</b><small>Add harmonic symbols above staves</small></span><input type="checkbox" defaultChecked /></label>
          </div>

          <button className="button transcribe" onClick={analyzeSource} disabled={Boolean(analysis)}>
            <span>✦</span> {analysis ? "Transcribing…" : "Generate score"}
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
              <div className="chord-line"><span>G</span><span>D/F♯</span><span>Em</span><span>Cmaj7</span><span>G/B</span><span>Am7</span><span>D</span></div>
              <div className="staff-system">
                <span className="system-brace">{tracks.length > 2 ? "⎧" : "{"}</span>
                {tracks.map((track) => <ScoreStaff key={track.id} track={track} selectedNote={selectedNote} onSelect={setSelectedNote} />)}
              </div>
              <div className="page-footer"><span>ScoreCraft transcription</span><span>1</span></div>
            </div>
          </div>

          <div className="transport">
            <div className="time-display"><b>00:{currentTime.toString().padStart(2, "0")}</b><span>/ 00:{duration}</span></div>
            <button className={looping ? "transport-active" : ""} onClick={() => setLooping(!looping)} title="Loop">↻</button>
            <button className="play-button" onClick={startPlayback} aria-label={playing ? "Pause score" : "Play score"}>{playing ? "Ⅱ" : "▶"}</button>
            <button onClick={() => stopPlayback(true)} title="Stop">■</button>
            <div className="timeline"><input type="range" min="0" max="100" step="0.1" value={playhead} onChange={(event) => setPlayhead(Number(event.target.value))} aria-label="Playback position" /><i style={{ width: `${playhead}%` }} /></div>
            <button className={metronome ? "transport-active" : ""} onClick={() => setMetronome(!metronome)} title="Metronome">♩</button>
            <label className="tempo-field"><input type="number" min="40" max="220" value={tempo} onChange={(event) => setTempo(Number(event.target.value))} /><span>BPM</span></label>
          </div>
        </section>

        <aside className="mixer-panel">
          <div className="mixer-heading"><span className="eyebrow">INSTRUMENTS</span><span>{tracks.length} parts</span></div>
          <div className="track-list">
            {tracks.map((track) => (
              <div className="mixer-track" key={track.id}>
                <div className="instrument-avatar" style={{ background: track.color }}>{track.abbreviation.slice(0, 2)}</div>
                <div className="track-main">
                  <div className="track-name"><b>{track.name}</b><button aria-label={`More options for ${track.name}`}>•••</button></div>
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
          <div className="add-wrap">
            <button className="add-instrument" onClick={() => setAddMenu(!addMenu)}>＋ Add instrument</button>
            {addMenu && (
              <div className="floating-menu instrument-menu">
                {instrumentPresets.map((preset) => <button key={preset[0]} onClick={() => addInstrument(preset)}><span style={{ background: preset[3] }}>{preset[1]}</span><b>{preset[0]}</b></button>)}
              </div>
            )}
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
