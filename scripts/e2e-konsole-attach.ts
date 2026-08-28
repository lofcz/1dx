#!/usr/bin/env bun
/**
 * Live Konsole attach E2E. Starts a real window, reads the env Konsole
 * actually sets (KONSOLE_DBUS_WINDOW=/Windows/1, unique :1.N name),
 * then attaches tabs the same way `dev start` does.
 *
 * Usage: bun scripts/e2e-konsole-attach.ts
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { spawn } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import {
  findQdbus,
  resolveKonsoleDbusTarget,
  tryAttachKonsoleTabs,
} from "../src/linux-terminal.ts";

const TIMEOUT_MS = 20_000;

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

async function waitForFile(path: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = await Bun.file(path).text();
      if (text.includes("KONSOLE_DBUS_SERVICE=") && text.includes("KONSOLE_DBUS_WINDOW=")) {
        return text;
      }
    } catch {
      // not written yet
    }
    await Bun.sleep(80);
  }
  fail(`timed out waiting for ${path}`);
}

function parseEnvFile(text: string) {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

function qdbus(qdbusBin: string, ...args: string[]) {
  const result = Bun.spawnSync([qdbusBin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    fail(`qdbus ${args.join(" ")} failed: ${result.stderr.toString() || result.stdout.toString()}`);
  }
  return result.stdout.toString().trim();
}

const workdir = mkdtempSync(join(tmpdir(), "1dx-konsole-e2e-"));
const envFile = join(workdir, "konsole.env");
const layoutFile = join(workdir, "layout.json");
const markerA = join(workdir, "a.ok");
const markerB = join(workdir, "b.ok");
const scriptA = join(workdir, "a.sh");
const scriptB = join(workdir, "b.sh");

writeFileSync(scriptA, `#!/bin/bash\ntouch ${JSON.stringify(markerA)}\nexec sleep 120\n`);
writeFileSync(scriptB, `#!/bin/bash\ntouch ${JSON.stringify(markerB)}\nexec sleep 120\n`);
chmodSync(scriptA, 0o755);
chmodSync(scriptB, 0o755);

const probe = spawn(
  "konsole",
  [
    "--nofork",
    "-e",
    "bash",
    "-lc",
    `printf 'KONSOLE_DBUS_SERVICE=%s\\nKONSOLE_DBUS_WINDOW=%s\\nDBUS_SESSION_BUS_ADDRESS=%s\\n' "$KONSOLE_DBUS_SERVICE" "$KONSOLE_DBUS_WINDOW" "$DBUS_SESSION_BUS_ADDRESS" > ${JSON.stringify(envFile)} && exec sleep 120`,
  ],
  { detached: true, stdio: "ignore" },
);
probe.unref();

const cleanup = () => {
  try {
    if (probe.pid) process.kill(-probe.pid, "TERM");
  } catch {
    // already gone
  }
  try {
    if (probe.pid) process.kill(probe.pid, "TERM");
  } catch {
    // already gone
  }
  rmSync(workdir, { recursive: true, force: true });
};

process.on("exit", cleanup);

const envText = await waitForFile(envFile, TIMEOUT_MS);
const env = parseEnvFile(envText);
console.log("Konsole env:");
console.log(`  KONSOLE_DBUS_SERVICE=${env.KONSOLE_DBUS_SERVICE}`);
console.log(`  KONSOLE_DBUS_WINDOW=${env.KONSOLE_DBUS_WINDOW}`);

assert(env.KONSOLE_DBUS_SERVICE, "Konsole did not set KONSOLE_DBUS_SERVICE");
assert(env.KONSOLE_DBUS_WINDOW, "Konsole did not set KONSOLE_DBUS_WINDOW");
assert(
  env.KONSOLE_DBUS_WINDOW.startsWith("/"),
  `expected real Konsole window path, got ${env.KONSOLE_DBUS_WINDOW}`,
);

const resolved = resolveKonsoleDbusTarget(
  {
    KONSOLE_DBUS_SERVICE: env.KONSOLE_DBUS_SERVICE,
    KONSOLE_DBUS_WINDOW: env.KONSOLE_DBUS_WINDOW,
    DBUS_SESSION_BUS_ADDRESS: env.DBUS_SESSION_BUS_ADDRESS,
  },
  [],
);
assert(resolved, "resolveKonsoleDbusTarget returned null");
assert(
  resolved.windowPath === env.KONSOLE_DBUS_WINDOW.replace(/\/{2,}/g, "/"),
  `window path mutated: ${env.KONSOLE_DBUS_WINDOW} -> ${resolved.windowPath}`,
);
assert(
  resolved.windowPath === "/Windows/1" || resolved.windowPath.startsWith("/Windows/"),
  `unexpected window path ${resolved.windowPath}`,
);
console.log(`resolved windowPath=${resolved.windowPath}`);

const qdbusBin = findQdbus();
assert(qdbusBin, "qdbus not found");

const before = qdbus(qdbusBin, resolved.service, resolved.windowPath, "org.kde.konsole.Window.sessionList");
console.log(`sessions before attach: ${before}`);

const result = tryAttachKonsoleTabs(
  [
    { title: "E2E Edge", tempFile: scriptA },
    { title: "E2E Frontend", tempFile: scriptB },
  ],
  workdir,
  layoutFile,
  writeFileSync,
  { restoreFocus: true, target: resolved },
);

console.log(`attach result: ${JSON.stringify(result)}`);
assert(result.ok, `attach failed: ${result.ok === false ? result.reason : "unknown"}`);

const after = qdbus(qdbusBin, resolved.service, resolved.windowPath, "org.kde.konsole.Window.sessionList");
const sessionIds = after.split(/\s+/).filter(Boolean);
console.log(`sessions after attach: ${after}`);
assert(sessionIds.length >= 3, `expected at least 3 sessions, got ${after}`);

const titles = sessionIds.map((id) => {
  try {
    return qdbus(qdbusBin, resolved.service, `/Sessions/${id}`, "org.kde.konsole.Session.title", "0");
  } catch {
    return "";
  }
});
console.log(`titles: ${JSON.stringify(titles)}`);
assert(titles.includes("E2E Edge"), `missing E2E Edge title in ${JSON.stringify(titles)}`);
assert(titles.includes("E2E Frontend"), `missing E2E Frontend title in ${JSON.stringify(titles)}`);

const markerDeadline = Date.now() + 5000;
while (Date.now() < markerDeadline) {
  if (await Bun.file(markerA).exists() && await Bun.file(markerB).exists()) break;
  await Bun.sleep(80);
}
assert(await Bun.file(markerA).exists(), "attached tab A never ran");
assert(await Bun.file(markerB).exists(), "attached tab B never ran");

console.log("PASS: attached 2 tabs into the existing Konsole using real /Windows/1 env");
process.exit(0);
