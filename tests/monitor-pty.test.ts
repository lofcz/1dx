import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { waitFor } from "./terminal.tsx";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test.skipIf(process.platform === "win32")("external action owns cooked input; Ctrl+C restores the terminal and cleans runtime files", async () => {
  const root = mkdtempSync(join(tmpdir(), "1dx-pty-"));
  mkdirSync(join(root, "nested"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pty-project" }));
  writeFileSync(join(root, "interactive.sh"), `
    if stty -a | grep -q -- '-icanon'; then echo INPUT_RAW; else echo INPUT_COOKED; fi
    echo CHILD_PROMPT
    IFS= read -r value
    printf 'CHILD_READ=%s\\n' "$value"
    exit 7
  `);
  writeFileSync(join(root, "1dx.json"), JSON.stringify({
    project: { name: "PTY test" }, services: [],
    startup: { autoInstallDependencies: false, autoOpenFrontend: false },
    actions: [{ id: "interactive", label: "Interactive", shortcut: "i", mode: "external", command: "bash", args: ["interactive.sh"] }],
  }));
  let output = "";
  const child = Bun.spawn([process.execPath, cli, "start"], {
    cwd: join(root, "nested"),
    env: { ...process.env, CI: "false", CONTINUOUS_INTEGRATION: "false", FORCE_COLOR: "0" },
    terminal: { cols: 80, rows: 24, data(_terminal, chunk) { output += Buffer.from(chunk).toString(); } },
  });
  try {
    await waitFor(() => output.includes("Actions"), 5000);
    expect(existsSync(join(root, ".1dx"))).toBe(true);
    child.terminal!.write("i");
    await waitFor(() => output.includes("CHILD_PROMPT"));
    expect(output).toContain("INPUT_COOKED");
    expect(output).not.toContain("INPUT_RAW");
    child.terminal!.write("hello child\n");
    await waitFor(() => output.includes("Interactive failed: exit code 7"));
    expect(output).toContain("CHILD_READ=hello child");
    child.terminal!.resize(45, 12);
    child.terminal!.write("\x03");
    await waitFor(() => child.exitCode !== null);
    expect(await child.exited).toBe(0);
    expect(existsSync(join(root, ".1dx"))).toBe(false);
    expect(output).not.toContain("\x1b[3J");
    expect(output).toContain("\x1b[?25h");
  } finally {
    child.kill();
    await child.exited;
    child.terminal?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

test.skipIf(process.platform === "win32")("Ctrl+C during startup runs cleanup before exiting", async () => {
  const root = mkdtempSync(join(tmpdir(), "1dx-startup-exit-"));
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(join(root, "1dx.json"), JSON.stringify({
    project: { name: "Startup exit" }, services: [], actions: [],
    startup: { autoInstallDependencies: false, autoOpenFrontend: false },
  }));
  let output = "";
  const child = Bun.spawn([process.execPath, cli, "start"], {
    cwd: root,
    env: { ...process.env, CI: "false", CONTINUOUS_INTEGRATION: "false" },
    terminal: { data(_terminal, chunk) { output += Buffer.from(chunk).toString(); } },
  });
  try {
    await waitFor(() => output.includes("Entering monitor mode"));
    child.terminal!.write("\x03");
    await waitFor(() => child.exitCode !== null);
    expect(await child.exited).toBe(0);
    expect(existsSync(join(root, ".1dx"))).toBe(false);
  } finally {
    child.kill();
    await child.exited;
    child.terminal?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
