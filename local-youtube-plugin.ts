import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";
import type { Payload } from "youtube-dl-exec";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_AUDIO_BYTES = 150 * 1024 * 1024;
const MAX_DURATION_SECONDS = 15 * 60;
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
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as { url?: unknown };
}

function sendJson(response: ServerResponse, status: number, message: string) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ error: message }));
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

          const format = metadata.formats
            .filter((item) => item.vcodec === "none" && item.acodec !== "none" && item.ext === "m4a")
            .sort((a, b) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0))[0];
          if (!format) throw new Error("No browser-compatible audio track was found for this video.");
          if ((format.filesize ?? format.filesize_approx ?? 0) > MAX_AUDIO_BYTES) throw new Error("This audio track is larger than 150 MB.");

          let bytes = 0;
          let activeProcess: ReturnType<typeof youtubeDl.exec> | null = null;
          let responseStarted = false;
          let clientClosed = false;
          const maxDownloadAttempts = 3;

          const runDownload = (attempt: number) => {
            if (clientClosed) return;
            const process = youtubeDl.exec(canonicalUrl, {
              output: "-",
              format: format.format_id,
              noPlaylist: true,
              ignoreConfig: true,
              noWarnings: true,
              noProgress: true,
              socketTimeout: 20,
              retries: 3,
              extractorRetries: 3,
              jsRuntimes: "node",
            }, { timeout: 180_000, windowsHide: true });
            activeProcess = process;
            let stderr = "";
            let settled = false;

            const finishAttempt = (success: boolean, detail = "") => {
              if (settled) return;
              settled = true;
              if (success && responseStarted) {
                response.end();
                return;
              }
              if (!response.headersSent && attempt + 1 < maxDownloadAttempts) {
                setTimeout(() => runDownload(attempt + 1), 300 * (attempt + 1));
                return;
              }
              const friendlyDetail = /403|forbidden/i.test(detail)
                ? "YouTube temporarily rejected the audio download after 3 attempts. Try Transcribe piano again."
                : "YouTube could not provide this video's audio after 3 attempts.";
              if (!response.headersSent) sendJson(response, 502, friendlyDetail);
              else response.destroy();
            };

            process.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000); });
            process.stdout?.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > MAX_AUDIO_BYTES) {
                settled = true;
                process.kill("SIGKILL");
                if (!response.headersSent) sendJson(response, 413, "The downloaded audio exceeded 150 MB.");
                else response.destroy();
                return;
              }
              if (!responseStarted) {
                responseStarted = true;
                response.statusCode = 200;
                response.setHeader("Content-Type", "audio/mp4");
                response.setHeader("Cache-Control", "no-store");
                response.setHeader("Content-Disposition", "inline; filename=scorecraft-youtube.m4a");
                response.setHeader("X-ScoreCraft-Title", encodeURIComponent(metadata.title || "YouTube piano transcription"));
                response.setHeader("X-ScoreCraft-Duration", String(metadata.duration));
                response.setHeader("X-ScoreCraft-Download-Attempt", String(attempt + 1));
              }
              response.write(chunk);
            });
            process.once("error", (error) => finishAttempt(false, error.message));
            process.once("close", (code) => finishAttempt(code === 0, stderr));
          };

          runDownload(0);
          response.once("close", () => {
            clientClosed = true;
            if (activeProcess && !activeProcess.killed) activeProcess.kill("SIGKILL");
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "YouTube audio could not be loaded.";
          sendJson(response, message.includes("too large") ? 413 : 400, message);
        }
      });
    },
  };
}
