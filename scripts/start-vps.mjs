import { spawnSync } from "node:child_process";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startProdServer } from "vinext/server/prod-server";
import { localPianoTranscriptionPlugin } from "../local-piano-transcription-plugin.ts";
import { localYouTubeAudioPlugin } from "../local-youtube-plugin.ts";

const require = createRequire(import.meta.url);

function captureMiddleware(plugin, root) {
  let middleware;
  plugin.configureServer?.({
    config: { root },
    middlewares: {
      use(handler) {
        middleware = handler;
      },
    },
  });
  if (!middleware) throw new Error(`Plugin ${plugin.name} did not register its server middleware.`);
  return middleware;
}

export function attachLocalRoutes(server, root = process.cwd()) {
  const fallbackListeners = server.listeners("request");
  if (fallbackListeners.length !== 1) {
    throw new Error(`Expected one production request handler, found ${fallbackListeners.length}.`);
  }

  const middleware = [
    captureMiddleware(localYouTubeAudioPlugin(), root),
    captureMiddleware(localPianoTranscriptionPlugin(), root),
  ];
  const fallback = fallbackListeners[0];
  server.removeAllListeners("request");
  server.on("request", (request, response) => {
    const dispatch = (index) => {
      if (response.writableEnded) return;
      const handler = middleware[index];
      if (!handler) {
        fallback.call(server, request, response);
        return;
      }
      Promise.resolve(handler(request, response, () => dispatch(index + 1))).catch((error) => {
        console.error("[ScoreCraft] Local route error:", error);
        if (!response.headersSent) {
          response.statusCode = 500;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ error: "The local processing route failed unexpectedly." }));
        } else {
          response.destroy();
        }
      });
    };
    dispatch(0);
  });
}

function optionValue(names) {
  for (let index = 2; index < process.argv.length; index += 1) {
    if (names.includes(process.argv[index])) return process.argv[index + 1];
    const [name, value] = process.argv[index].split("=", 2);
    if (names.includes(name) && value) return value;
  }
  return undefined;
}

async function printRuntimeWarnings() {
  try {
    const youtubeDl = require("youtube-dl-exec");
    await access(youtubeDl.constants.YOUTUBE_DL_PATH);
    console.log(`[ScoreCraft] yt-dlp: ${youtubeDl.constants.YOUTUBE_DL_PATH}`);
  } catch {
    console.warn("[ScoreCraft] YouTube downloads are unavailable: yt-dlp is missing. Run `npm install` without `--ignore-scripts`.");
  }

  const ffmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore", windowsHide: true });
  if (ffmpeg.error || ffmpeg.status !== 0) {
    console.warn("[ScoreCraft] FFmpeg is missing from PATH. Install FFmpeg before transcribing YouTube segments.");
  }
}

export async function main() {
  const root = process.cwd();
  const portValue = optionValue(["--port", "-p"]);
  const host = optionValue(["--host", "--hostname", "-H"]) ?? process.env.HOST ?? "0.0.0.0";
  const port = portValue ? Number(portValue) : process.env.PORT ? Number(process.env.PORT) : 3000;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Port must be an integer from 0 to 65535.");

  await printRuntimeWarnings();
  const { server } = await startProdServer({ port, host });
  attachLocalRoutes(server, root);
  console.log("[ScoreCraft] YouTube and local piano routes are enabled for this VPS server.");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
