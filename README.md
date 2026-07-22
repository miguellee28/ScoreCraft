# ScoreCraft

ScoreCraft is a local piano-transcription workspace. It accepts an uploaded audio file or a YouTube link, transcribes the piano performance, plays the detected notes with a sampled grand piano, and exports a two-staff score as PDF or MusicXML.

Nothing needs to be deployed. The high-accuracy transcription route runs only in the local Vite development server.

## Requirements

- Node.js 22.13 or newer
- Python 3.10, 3.11, or 3.12
- FFmpeg on `PATH`
- Windows (the included setup script creates a Windows virtual environment)

## Local setup

```powershell
npm install
npm run setup:transkun
npm run dev
```

If more than one Python is installed and the setup script cannot find a compatible version, run `powershell -ExecutionPolicy Bypass -File scripts/setup-transkun.ps1 -Python C:\path\to\python.exe`.

Open the localhost URL printed by `npm run dev`. The first Transkun setup downloads the CPU PyTorch runtime and the approximately 54 MB piano checkpoint into the ignored `tmp/` directory.

Transkun analyzes overlapping audio windows and is intentionally slower than the browser fallback. On a CPU-only machine, a three-to-four-minute recording can take several minutes. Keep the local terminal open until transcription finishes.

For a YouTube source, enter Start and End as seconds, `M:SS`, or `H:MM:SS`. Leaving End blank transcribes from Start to the video end, capped at five minutes. ScoreCraft downloads only the selected section locally, which reduces both download and transcription time.

## Accuracy verification

Compare a generated Transkun MIDI with a reference MIDI:

```powershell
npm run compare:midi -- path\to\transcribed.mid path\to\reference.mid optional-browser-hints.json
```

The report separates exact pitch/onset matches from duration and velocity matches. ScoreCraft uses a 16-ticks-per-beat internal grid so 32nd- and 64th-note offsets survive playback, grand-staff engraving, MusicXML, and PDF export.

## Commands

- `npm run dev` — start ScoreCraft locally
- `npm run setup:transkun` — install the isolated high-accuracy piano runtime
- `npm run build` — compile a production build for verification
- `npm test` — build and run the timing/rendering tests
- `npm run compare:midi -- <generated.mid> <reference.mid>` — compare transcription structure

## Transcription engines

ScoreCraft prefers the local Transkun 2.0.1 piano model. If that runtime is not installed, it falls back to Spotify Basic Pitch in the browser. The browser fallback is faster to start but is less accurate on dense polyphonic piano recordings.

The Transkun checkpoint is trained on MAESTRO. Review its dataset/model terms before commercial redistribution; the setup script downloads the model locally and does not commit it to this repository.
