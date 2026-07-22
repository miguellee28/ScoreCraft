import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import toneMidi from "@tonejs/midi";
import type { Plugin } from "vite";

const MAX_AUDIO_BYTES = 150 * 1024 * 1024;
const TRANSCRIPTION_TIMEOUT_MS = 20 * 60 * 1_000;
const ACCEPTED_EXTENSIONS = new Set([".aac", ".flac", ".m4a", ".mp3", ".ogg", ".wav", ".webm"]);
const { Midi } = toneMidi;

type LocalPianoNote = {
  midi: number;
  startSeconds: number;
  durationSeconds: number;
  velocity: number;
};

class ModelUnavailableError extends Error {}

function stopChild(child: ChildProcessWithoutNullStreams | null) {
  if (child) child.kill("SIGKILL");
}

function sendJson(response: ServerResponse, status: number, body: object) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(body));
}

function sameOrigin(request: IncomingMessage) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  return !origin || !host || new URL(origin).host === host;
}

async function readAudioBody(request: IncomingMessage) {
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (declaredLength > MAX_AUDIO_BYTES) throw new Error("The audio file is larger than 150 MB.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_AUDIO_BYTES) throw new Error("The audio file is larger than 150 MB.");
    chunks.push(buffer);
  }
  if (!size) throw new Error("The audio file is empty.");
  return Buffer.concat(chunks);
}

function inputExtension(request: IncomingMessage) {
  const requestedName = String(request.headers["x-scorecraft-filename"] ?? "");
  const extension = extname(requestedName).toLowerCase();
  if (ACCEPTED_EXTENSIONS.has(extension)) return extension;
  const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0];
  return ({
    "audio/aac": ".aac",
    "audio/flac": ".flac",
    "audio/mp4": ".m4a",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/webm": ".webm",
  } as Record<string, string>)[contentType] ?? ".mp3";
}

async function transcriptionRuntime() {
  const python = resolve(process.env.SCORECRAFT_TRANSKUN_PYTHON
    ?? join(process.cwd(), "tmp", ".venv-transkun", "Scripts", "python.exe"));
  const packageDirectory = resolve(process.env.SCORECRAFT_TRANSKUN_PACKAGE
    ?? join(process.cwd(), "tmp", "transkun-extracted"));
  try {
    await Promise.all([
      access(python),
      access(join(packageDirectory, "transkun", "pretrained", "2.0.pt")),
    ]);
  } catch {
    throw new ModelUnavailableError("The high-accuracy piano model is not installed. Run npm run setup:transkun, then restart ScoreCraft.");
  }
  return { python, packageDirectory };
}

function runTranskun(
  python: string,
  packageDirectory: string,
  inputPath: string,
  outputPath: string,
  onChild: (child: ChildProcessWithoutNullStreams | null) => void,
) {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(python, [
      "-m",
      "transkun.transcribe",
      inputPath,
      outputPath,
      "--device",
      "cpu",
      "--segmentHopSize",
      "8",
      "--segmentSize",
      "16",
    ], {
      env: {
        ...process.env,
        PYTHONPATH: packageDirectory,
        PYTHONUTF8: "1",
      },
      windowsHide: true,
      shell: false,
    });
    onChild(child);
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      onChild(null);
      if (error) reject(error);
      else resolvePromise();
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("High-accuracy transcription exceeded the 20-minute local CPU limit."));
    }, TRANSCRIPTION_TIMEOUT_MS);
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => finish(code === 0
      ? undefined
      : new Error(/ffmpeg|decode|audio/i.test(stderr)
        ? "The local piano model could not decode this audio format."
        : `The local piano model stopped unexpectedly (exit ${code ?? "unknown"}).`)));
  });
}

function parsePianoMidi(bytes: Buffer): LocalPianoNote[] {
  const midi = new Midi(bytes);
  return midi.tracks
    .flatMap((track) => track.notes)
    .map((note) => ({
      midi: note.midi,
      startSeconds: note.time,
      durationSeconds: note.duration,
      velocity: Math.max(1, Math.min(127, Math.round(note.velocity * 127))),
    }))
    .sort((a, b) => a.startSeconds - b.startSeconds || a.midi - b.midi);
}

export function localPianoTranscriptionPlugin(): Plugin {
  let active = false;
  return {
    name: "scorecraft-local-piano-transcription",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const requestUrl = new URL(request.url ?? "/", "http://localhost");
        if (requestUrl.pathname !== "/__local/piano-transcribe") return next();
        if (request.method !== "POST") return sendJson(response, 405, { error: "Use POST for piano transcription." });
        if (!sameOrigin(request)) return sendJson(response, 403, { error: "Cross-origin requests are not allowed." });
        if (active) return sendJson(response, 429, { error: "A high-accuracy piano transcription is already running." });

        active = true;
        let directory = "";
        let child: ChildProcessWithoutNullStreams | null = null;
        const startedAt = Date.now();
        try {
          const runtime = await transcriptionRuntime();
          directory = await mkdtemp(join(tmpdir(), "scorecraft-transkun-"));
          const inputPath = join(directory, `input${inputExtension(request)}`);
          const outputPath = join(directory, "piano.mid");
          await writeFile(inputPath, await readAudioBody(request));
          request.once("aborted", () => child?.kill("SIGKILL"));
          response.once("close", () => {
            if (!response.writableEnded) stopChild(child);
          });
          await runTranskun(runtime.python, runtime.packageDirectory, inputPath, outputPath, (nextChild) => { child = nextChild; });
          const notes = parsePianoMidi(await readFile(outputPath));
          if (!notes.length) throw new Error("The high-accuracy piano model did not detect any notes.");
          sendJson(response, 200, {
            engine: "transkun-2.0.1",
            elapsedSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
            notes,
          });
        } catch (error) {
          const unavailable = error instanceof ModelUnavailableError;
          sendJson(response, unavailable ? 503 : 500, {
            error: error instanceof Error ? error.message : "Local piano transcription failed.",
            unavailable,
          });
        } finally {
          stopChild(child);
          if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
          active = false;
        }
      });
    },
  };
}
