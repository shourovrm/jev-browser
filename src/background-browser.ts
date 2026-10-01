// The CLI's background browser: one warm Helium kept running between CLI
// runs, so each `jev-browser run` connects in well under a second instead of
// launching a browser and paying the 6 s uBlock Origin warm-up.
//
// `jev-browser browser-daemon` (started detached by the first CLI run) launches
// a Playwright browser server on loopback, warms it up, then writes its
// endpoint to a state file readable only by this user. CLI runs connect to it
// and each run gets its own fresh context. The daemon exits after
// IDLE_SHUTDOWN_MS without a run.
import { chromium, type Browser } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, open, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { browserLaunchOptions, warmUpBrowser } from "./navigate.js";

const IDLE_SHUTDOWN_MS = 15 * 60_000;
const IDLE_CHECK_MS = 30_000;
// Launch plus the 6 s warm-up, with room for a slow machine.
const DAEMON_START_TIMEOUT_MS = 20_000;
// A lock older than this belongs to a daemon start that died.
const STALE_LOCK_MS = 30_000;

interface DaemonState {
  wsEndpoint: string;
  pid: number;
  headless: boolean;
  executablePath: string | null;
}

/** Where the state and lock files live; JEV_BROWSER_STATE_DIR overrides it (tests use a scratch dir). */
export function stateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.JEV_BROWSER_STATE_DIR) return env.JEV_BROWSER_STATE_DIR;
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, "jev-browser");
  return join(homedir(), ".cache", "jev-browser");
}

const statePath = () => join(stateDirectory(), "browser.json");
const lockPath = () => join(stateDirectory(), "browser.lock");

async function readState(): Promise<DaemonState | null> {
  try {
    return JSON.parse(await readFile(statePath(), "utf8")) as DaemonState;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The daemon only serves runs that would have launched the same browser the same way. */
function stateMatchesThisRun(state: DaemonState): boolean {
  const wanted = browserLaunchOptions();
  return state.headless === wanted.headless && state.executablePath === (wanted.executablePath ?? null);
}

/** Marks activity, so the daemon's idle shutdown counts from the latest run. */
async function touchState(): Promise<void> {
  const now = new Date();
  await utimes(statePath(), now, now).catch(() => {});
}

async function connectToState(state: DaemonState): Promise<Browser | null> {
  if (!processIsAlive(state.pid) || !stateMatchesThisRun(state)) return null;
  const browser = await chromium.connect(state.wsEndpoint, { timeout: 3_000 }).catch(() => null);
  if (browser) await touchState();
  return browser;
}

/**
 * A connection to the warm background browser, starting it first when none
 * is running. Returns null when it cannot be had in time; the caller then
 * launches a browser for the run as before. Close the returned browser when
 * the run ends: that disconnects this client and leaves the daemon running.
 */
export async function connectToBackgroundBrowser(): Promise<Browser | null> {
  const running = await readState();
  if (running) {
    const browser = await connectToState(running);
    if (browser) return browser;
  }
  await startDaemonUnlessStarting();
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const state = await readState();
    if (state && state.pid !== running?.pid) {
      const browser = await connectToState(state);
      if (browser) return browser;
    }
  }
  return null;
}

/** Starts a detached daemon, unless another CLI run started one in the last STALE_LOCK_MS. */
async function startDaemonUnlessStarting(): Promise<void> {
  await mkdir(stateDirectory(), { recursive: true, mode: 0o700 });
  const lockAge = await stat(lockPath()).then((info) => Date.now() - info.mtimeMs).catch(() => null);
  if (lockAge !== null && lockAge < STALE_LOCK_MS) return;
  await rm(lockPath(), { force: true });
  const lock = await open(lockPath(), "wx", 0o600).catch(() => null);
  if (!lock) return; // another run took the lock first; its daemon will write the state
  await lock.close();
  const entry = fileURLToPath(new URL("./index.js", import.meta.url));
  spawn(process.execPath, [entry, "browser-daemon"], { detached: true, stdio: "ignore", env: process.env }).unref();
}

/** `jev-browser browser-daemon`: launch, warm up, publish the endpoint, serve until idle. */
export async function runBrowserDaemon(): Promise<void> {
  const launchedAt = performance.now();
  const launch = browserLaunchOptions();
  // Loopback only, and an unguessable path: the endpoint drives a browser.
  const server = await chromium.launchServer({ ...launch, host: "127.0.0.1", wsPath: `/${randomBytes(16).toString("hex")}` });
  const warmUpClient = await chromium.connect(server.wsEndpoint());
  await warmUpBrowser(warmUpClient, launchedAt);
  await warmUpClient.close();

  const state: DaemonState = { wsEndpoint: server.wsEndpoint(), pid: process.pid, headless: launch.headless, executablePath: launch.executablePath ?? null };
  await mkdir(stateDirectory(), { recursive: true, mode: 0o700 });
  await writeFile(statePath(), JSON.stringify(state), { mode: 0o600 });
  await rm(lockPath(), { force: true });

  const shutDown = async () => {
    // Remove the state only if it is still ours; a newer daemon may own it.
    if ((await readState())?.pid === process.pid) await rm(statePath(), { force: true });
    await server.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", shutDown);
  process.on("SIGINT", shutDown);
  server.process().on("exit", shutDown); // the browser crashed or was killed
  setInterval(async () => {
    const lastRunAt = await stat(statePath()).then((info) => info.mtimeMs).catch(() => 0);
    if (Date.now() - lastRunAt > IDLE_SHUTDOWN_MS) await shutDown();
  }, IDLE_CHECK_MS);
}

/** `jev-browser stop-browser`: stop the background browser if one is running. Returns whether one was. */
export async function stopBackgroundBrowser(): Promise<boolean> {
  const state = await readState();
  if (!state || !processIsAlive(state.pid)) {
    await rm(statePath(), { force: true });
    return false;
  }
  process.kill(state.pid, "SIGTERM");
  for (let waited = 0; waited < 5_000 && processIsAlive(state.pid); waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}
