import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

// A scratch state directory, so the test never touches a real background browser.
const stateDirectory = await mkdtemp(join(tmpdir(), "jev-browser-state-"));
process.env.JEV_BROWSER_STATE_DIR = stateDirectory;
const { connectToBackgroundBrowser, stopBackgroundBrowser } = await import("../dist/background-browser.js");
const { navigate } = await import("../dist/navigate.js");

after(async () => {
  await stopBackgroundBrowser();
  await rm(stateDirectory, { recursive: true, force: true });
});

const doneTransport = {
  name: "fixture",
  async ask({ questions }) {
    const answers = {};
    for (const [id, question] of Object.entries(questions)) {
      const keys = question.type === "noul" ? [] : Object.keys(question.criteria);
      answers[id] =
        question.type === "noul"
          ? { type: "noul", noul: 0 }
          : { type: "choice", choice: "done", confidence: 1, probabilities: Object.fromEntries(keys.map((key) => [key, key === "done" ? 1 : 0])) };
    }
    return { answers, usage: { input_tokens: 1, output_tokens: 1 }, model: "fixture" };
  },
};

test("the first connection starts the background browser; later ones reuse it at once", async (t) => {
  const server = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end("<title>Cafe</title><p>Open daily</p>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const first = await connectToBackgroundBrowser();
  assert.ok(first, "the background browser should start");
  const state = JSON.parse(await readFile(join(stateDirectory, "browser.json"), "utf8"));
  assert.match(state.wsEndpoint, /^ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
  assert.equal((await stat(join(stateDirectory, "browser.json"))).mode & 0o777, 0o600);

  const result = await navigate({ task: "check", startUrl: `http://127.0.0.1:${server.address().port}/`, browser: first, transport: doneTransport, maxSteps: 1, screenshot: "none" });
  assert.equal(result.status, "done");
  assert.equal(first.contexts().length, 0, "the run closes only its own context");
  await first.close();

  const connectStartedAt = performance.now();
  const second = await connectToBackgroundBrowser();
  const connectMs = performance.now() - connectStartedAt;
  assert.ok(second, "the background browser should still be running after a client disconnects");
  assert.ok(connectMs < 2_000, `reconnecting took ${Math.round(connectMs)} ms`);
  assert.equal(JSON.parse(await readFile(join(stateDirectory, "browser.json"), "utf8")).pid, state.pid);
  await second.close();
});

test("stop-browser ends the background browser and removes its state", async () => {
  assert.ok(await connectToBackgroundBrowser().then((browser) => browser?.close().then(() => true)));
  assert.equal(await stopBackgroundBrowser(), true);
  await assert.rejects(stat(join(stateDirectory, "browser.json")));
  assert.equal(await stopBackgroundBrowser(), false);
});
