import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { attachLocalRoutes } from "../scripts/start-vps.mjs";

test("exposes local processing routes without swallowing production requests", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "scorecraft-server-test-"));
  await mkdir(join(root, "dist", "client", "assets"), { recursive: true });
  await writeFile(join(root, "dist", "client", "assets", "app-test123.js"), "console.log('served');");
  const server = createServer((_request, response) => {
    response.statusCode = 204;
    response.end();
  });
  attachLocalRoutes(server, root);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  context.after(() => rm(root, { recursive: true, force: true }));

  const address = server.address();
  assert(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;

  const youtubeResponse = await fetch(`${origin}/__local/youtube-audio`, { method: "GET" });
  assert.equal(youtubeResponse.status, 405);
  assert.deepEqual(await youtubeResponse.json(), { error: "Use POST for YouTube audio requests." });

  const pianoResponse = await fetch(`${origin}/__local/piano-transcribe`, { method: "GET" });
  assert.equal(pianoResponse.status, 405);
  assert.deepEqual(await pianoResponse.json(), { error: "Use POST for piano transcription." });

  const assetResponse = await fetch(`${origin}/assets/app-test123.js`);
  assert.equal(assetResponse.status, 200);
  assert.equal(await assetResponse.text(), "console.log('served');");

  const appResponse = await fetch(`${origin}/anything-else`);
  assert.equal(appResponse.status, 204);
});
