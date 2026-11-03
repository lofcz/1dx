import React from "react";
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandRunner, commandOutputLines } from "../src/command-runner.tsx";
import { testTerminal, waitFor } from "./terminal.tsx";

test("output preserves indentation and blank lines while normalizing progress and ANSI", () => {
  expect(commandOutputLines("\x1b[31m  red\x1b[0m\r\n\nold\rnew\n")).toEqual(["  red", "", "new"]);
});

test("resize and fresh props keep one command alive, preserving full diagnostics and split UTF-8", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "1dx-command-"));
  const script = join(cwd, "command.ts");
  writeFileSync(script, `
    import {appendFileSync, existsSync} from 'node:fs';
    appendFileSync('runs', 'run\\n');
    process.stdout.write('Found local migration files to be inserted before the last migration on remote database.\\n--include-all\\n');
    process.stdout.write('  par');
    await Bun.sleep(40);
    process.stdout.write('tial ');
    const bytes = Buffer.from('ž');
    process.stdout.write(bytes.subarray(0, 1));
    await Bun.sleep(40);
    process.stdout.write(bytes.subarray(1));
    process.stdout.write('\\n');
    while (!existsSync('finish')) await Bun.sleep(10);
    for (let i = 0; i < 30; i++) console.log('line ' + i);
    process.exit(1);
  `);
  const completions: Array<{ success: boolean; output: string }> = [];
  let staleCalls = 0;
  const app = testTerminal(<CommandRunner cwd={cwd} command={process.execPath} args={[script]} label="Check" maxLines={15} onDone={() => { staleCalls++; }} />);
  try {
    await waitFor(() => existsSync(join(cwd, "runs")));
    app.rerender(<CommandRunner cwd={cwd} command={process.execPath} args={[script]} label="Check" maxLines={2} onDone={(success, output) => completions.push({ success, output })} />);
    await waitFor(() => app.frame().includes("partial ž"));
    writeFileSync(join(cwd, "finish"), "");
    await waitFor(() => completions.length === 1);
    expect(readFileSync(join(cwd, "runs"), "utf8")).toBe("run\n");
    expect(staleCalls).toBe(0);
    expect(completions[0].success).toBe(false);
    expect(completions[0].output).toContain("--include-all");
    expect(completions[0].output).toContain("  partial ž\n");
    expect(completions[0].output).toContain("line 29");
    await waitFor(() => app.frame().includes("line 29"));
    expect(app.frame()).not.toContain("line 0\n");
  } finally {
    await app.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("spawn failure completes once even when close follows error", async () => {
  let calls = 0;
  const app = testTerminal(<CommandRunner cwd="/nonexistent/1dx-test-directory" command={process.execPath} args={[]} label="Missing cwd" onDone={(success) => {
    expect(success).toBe(false);
    calls++;
  }} />);
  try {
    await waitFor(() => calls > 0);
    await Bun.sleep(50);
    expect(calls).toBe(1);
  } finally { await app.close(); }
});

test.skipIf(process.platform === "win32")("unmount terminates the running shell's child and never calls onDone", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "1dx-cancel-"));
  const script = join(cwd, "child.ts");
  writeFileSync(script, `await Bun.write('pid', String(process.pid)); setInterval(() => {}, 1000);`);
  let calls = 0;
  const app = testTerminal(<CommandRunner cwd={cwd} command={process.execPath} args={[script]} label="Long command" onDone={() => { calls++; }} />);
  let pid: number | undefined;
  try {
    await waitFor(() => existsSync(join(cwd, "pid")));
    pid = Number(readFileSync(join(cwd, "pid"), "utf8"));
    await app.close();
    await waitFor(() => { try { process.kill(pid!, 0); return false; } catch { return true; } });
    expect(calls).toBe(0);
  } finally {
    await app.close();
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    rmSync(cwd, { recursive: true, force: true });
  }
});
