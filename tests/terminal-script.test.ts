import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTerminalScript } from "../src/monitor.tsx";
import { waitFor } from "./terminal.tsx";

test("one-shot scripts preserve failure and correctly quote the project directory", async () => {
  const root = mkdtempSync(join(tmpdir(), process.platform === "win32" ? "1dx-script-" : '1dx-script-$value-"quoted"-'));
  try {
    const script = createTerminalScript(root, "failure", "Failure", process.platform === "win32" ? "cmd /c exit 7" : "false", undefined, true);
    const child = Bun.spawn(process.platform === "win32" ? ["cmd", "/c", script] : ["bash", script], { stdout: "pipe", stderr: "pipe" });
    expect(await child.exited).toBe(process.platform === "win32" ? 7 : 1);
    expect(await new Response(child.stderr).text()).toBe("");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("service shells close after the owning monitor exits even if the exit flag is removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "1dx-owner-"));
  let shell: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const modulePath = new URL("../src/monitor.tsx", import.meta.url).href;
    const owner = Bun.spawn([process.execPath, "-e", `import {createTerminalScript} from ${JSON.stringify(modulePath)}; console.log(createTerminalScript(${JSON.stringify(root)}, 'owned', 'Owned', 'echo done'));`], { stdout: "pipe", stderr: "pipe" });
    const script = (await new Response(owner.stdout).text()).trim();
    expect(await owner.exited).toBe(0);
    shell = Bun.spawn(["bash", script], { stdout: "pipe", stderr: "pipe" });
    await waitFor(() => shell!.exitCode !== null);
    expect(await shell.exited).toBe(0);
  } finally {
    shell?.kill();
    if (shell) await shell.exited;
    rmSync(root, { recursive: true, force: true });
  }
});
