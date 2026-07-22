import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { attachLocalRoutes } from "../scripts/start-vps.mjs";

test("exposes local processing routes without swallowing production requests", async (context) => {
  const server = createServer((_request, response) => {
    response.statusCode = 204;
    response.end();
  });
  attachLocalRoutes(server, process.cwd());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;

  const youtubeResponse = await fetch(`${origin}/__local/youtube-audio`, { method: "GET" });
  assert.equal(youtubeResponse.status, 405);
  assert.deepEqual(await youtubeResponse.json(), { error: "Use POST for YouTube audio requests." });

  const pianoResponse = await fetch(`${origin}/__local/piano-transcribe`, { method: "GET" });
  assert.equal(pianoResponse.status, 405);
  assert.deepEqual(await pianoResponse.json(), { error: "Use POST for piano transcription." });

  const appResponse = await fetch(`${origin}/anything-else`);
  assert.equal(appResponse.status, 204);
});
