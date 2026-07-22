import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";
import type { Payload } from "youtube-dl-exec";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_AUDIO_BYTES = 150 * 1024 * 1024;
const MAX_DURATION_SECONDS = 15 * 60;
const MAX_SEGMENT_SECONDS = 5 * 60;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function canonicalYouTubeUrl(input: string) {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("Use a standard HTTPS YouTube link.");
  }

  const host = url.hostname.toLowerCase();
  let id = "";
  if (host === "youtu.be") {
    id = url.pathname.split("/").filter(Boolean)[0] ?? "";
  } else if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) {
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/watch") id = url.searchParams.get("v") ?? "";
    else if (["shorts", "embed", "live"].includes(parts[0] ?? "")) id = parts[1] ?? "";
  }

  if (!VIDEO_ID.test(id)) throw new Error("This is not a complete YouTube video link.");
  return `https://www.youtube.com/watch?v=${id}`;
}

async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request is too large.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    url?: unknown;
    startSeconds?: unknown;
    endSeconds?: unknown;
  };
}

export function normalizeYouTubeSegment(
  startValue: unknown,
  endValue: unknown,
  videoDuration: number,
) {
  const start = startValue === undefined ? 0 : Number(startValue);
  const end = endValue === undefined ? Math.min(videoDuration, start + MAX_SEGMENT_SECONDS) : Number(endValue);
  if (!Number.isFinite(start) || start < 0) throw new Error("Start time must be zero or later.");
  if (start >= videoDuration) throw new Error("Start time is after the video ends.");
  if (!Number.isFinite(end) || end <= start) throw new Error("End time must be after the start time.");
  if (end > videoDuration + 0.01) throw new Error("End time is after the video ends.");
  if (end - start > MAX_SEGMENT_SECONDS) throw new Error("Choose a YouTube segment of 5 minutes or less.");
  return { start, end: Math.min(end, videoDuration) };
}

function sendJson(response: ServerResponse, status: number, message: string) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ error: message }));
}

function friendlyYouTubeError(error: unknown) {
  const message = error instanceof Error ? error.message : "YouTube audio could not be loaded.";
  if (/spawn .*yt-dlp(?:\.exe)?.*ENOENT|yt-dlp(?:\.exe)?.*(?:not found|cannot find|no such file)/i.test(message)) {
    return "The YouTube downloader is not installed on this server. Run npm install without --ignore-scripts, then restart ScoreCraft.";
  }
  if (/ffmpeg.*(?:not found|not installed)|ffprobe.*(?:not found|not installed)/i.test(message)) {
    return "FFmpeg is not installed on this server. Install FFmpeg, then restart ScoreCraft.";
  }
  if (/timed?\s*out|timeout/i.test(message)) {
    return "YouTube took too long to respond. Try again or choose a shorter section.";
  }
  if (/sign in.*(?:not a bot|confirm)|confirm you(?:'|’)?re not a bot/i.test(message)) {
    return "YouTube blocked this VPS address. Export YouTube cookies to the server and set SCORECRAFT_YOUTUBE_COOKIES to that file, then restart ScoreCraft.";
  }
  return message;
}

function youtubeAuthenticationOptions() {
  const cookieFile = process.env.SCORECRAFT_YOUTUBE_COOKIES?.trim();
  return cookieFile ? { cookies: resolve(cookieFile) } : {};
}

export function localYouTubeAudioPlugin(): Plugin {
  return {
    name: "scorecraft-local-youtube-audio",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const requestUrl = new URL(request.url ?? "/", "http://localhost");
        if (requestUrl.pathname !== "/__local/youtube-audio") return next();
        if (request.method !== "POST") return sendJson(response, 405, "Use POST for YouTube audio requests.");

        const origin = request.headers.origin;
        const host = request.headers.host;
        if (origin && host && new URL(origin).host !== host) return sendJson(response, 403, "Cross-origin requests are not allowed.");

        try {
          const body = await readJsonBody(request);
          if (typeof body.url !== "string") throw new Error("A YouTube URL is required.");
          const canonicalUrl = canonicalYouTubeUrl(body.url);
          const { default: youtubeDl } = await import("youtube-dl-exec");
          const metadata = await youtubeDl(canonicalUrl, {
            ...youtubeAuthenticationOptions(),
            dumpSingleJson: true,
            skipDownload: true,
            noPlaylist: true,
            ignoreConfig: true,
            noWarnings: true,
            noProgress: true,
            socketTimeout: 20,
            retries: 2,
            jsRuntimes: "node",
          }, { timeout: 60_000, windowsHide: true }) as Payload;

          if (metadata.is_live || metadata.live_status === "is_live") throw new Error("Live streams are not supported.");
          if (!metadata.duration || metadata.duration > MAX_DURATION_SECONDS) throw new Error("Choose a video shorter than 15 minutes.");
          const segment = normalizeYouTubeSegment(body.startSeconds, body.endSeconds, metadata.duration);

          const format = metadata.formats
            .filter((item) => item.vcodec === "none" && item.acodec !== "none" && item.ext === "m4a")
            .sort((a, b) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0))[0];
          if (!format) throw new Error("No browser-compatible audio track was found for this video.");
          if ((format.filesize ?? format.filesize_approx ?? 0) > MAX_AUDIO_BYTES) throw new Error("This audio track is larger than 150 MB.");

          const segmentDirectory = join(server.config.root, "tmp", "youtube-segments");
          await mkdir(segmentDirectory, { recursive: true });
          const outputName = `${randomUUID()}.m4a`;
          const outputPath = join(segmentDirectory, outputName);
          const downloaderOutput = join("tmp", "youtube-segments", outputName);
          let activeProcess: ReturnType<typeof youtubeDl.exec> | null = null;
          let responseStarted = false;
          let clientClosed = false;
          const maxDownloadAttempts = 3;
          const needsTrim = segment.start > 0.01 || segment.end < metadata.duration - 0.01;
          const cleanup = () => { void rm(outputPath, { force: true }).catch(() => undefined); };

          const runDownload = async (attempt: number) => {
            if (clientClosed) return;
            await rm(outputPath, { force: true }).catch(() => undefined);
            const process = youtubeDl.exec(canonicalUrl, {
              ...youtubeAuthenticationOptions(),
              output: downloaderOutput,
              format: format.format_id,
              ...(needsTrim ? {
                downloadSections: `*${segment.start}-${segment.end}`,
                forceKeyframesAtCuts: true,
              } : {}),
              noPlaylist: true,
              ignoreConfig: true,
              noWarnings: true,
              noProgress: true,
              socketTimeout: 20,
              retries: 3,
              extractorRetries: 3,
              jsRuntimes: "node",
            }, { timeout: 180_000, windowsHide: true, cwd: server.config.root });
            activeProcess = process;
            let stderr = "";
            let settled = false;

            const finishAttempt = async (success: boolean, detail = "") => {
              if (settled) return;
              settled = true;
              activeProcess = null;
              if (success && !clientClosed) {
                try {
                  const info = await stat(outputPath);
                  if (info.size > MAX_AUDIO_BYTES) {
                    cleanup();
                    return sendJson(response, 413, "The downloaded audio exceeded 150 MB.");
                  }
                  responseStarted = true;
                  response.statusCode = 200;
                  response.setHeader("Content-Type", "audio/mp4");
                  response.setHeader("Content-Length", String(info.size));
                  response.setHeader("Cache-Control", "no-store");
                  response.setHeader("Content-Disposition", "inline; filename=scorecraft-youtube.m4a");
                  response.setHeader("X-ScoreCraft-Title", encodeURIComponent(metadata.title || "YouTube piano transcription"));
                  response.setHeader("X-ScoreCraft-Duration", String(segment.end - segment.start));
                  response.setHeader("X-ScoreCraft-Segment-Start", String(segment.start));
                  response.setHeader("X-ScoreCraft-Segment-End", String(segment.end));
                  response.setHeader("X-ScoreCraft-Download-Attempt", String(attempt + 1));
                  const stream = createReadStream(outputPath);
                  stream.once("error", () => response.destroy());
                  stream.pipe(response);
                  return;
                } catch (error) {
                  detail = error instanceof Error ? error.message : detail;
                  success = false;
                }
              }
              cleanup();
              if (!success && !response.headersSent && !clientClosed && attempt + 1 < maxDownloadAttempts) {
                setTimeout(() => { void runDownload(attempt + 1); }, 300 * (attempt + 1));
                return;
              }
              const friendlyDetail = /403|forbidden/i.test(detail)
                ? "YouTube temporarily rejected the audio download after 3 attempts. Try Transcribe piano again."
                : "YouTube could not provide this video's audio after 3 attempts.";
              if (!response.headersSent) sendJson(response, 502, friendlyDetail);
              else response.destroy();
            };

            process.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000); });
            process.once("error", (error) => { void finishAttempt(false, error.message); });
            process.once("close", (code) => { void finishAttempt(code === 0, stderr); });
            void process.catch(() => undefined);
          };

          void runDownload(0);
          response.once("close", () => {
            clientClosed = true;
            if (activeProcess && !activeProcess.killed) activeProcess.kill("SIGKILL");
            if (responseStarted) cleanup();
          });
        } catch (error) {
          const message = friendlyYouTubeError(error);
          sendJson(response, message.includes("too large") ? 413 : 400, message);
        }
      });
    },
  };
}
