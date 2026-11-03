import React from "react";
import { expect, test } from "bun:test";
import { OneDxConfigSchema } from "../src/config.ts";
import { Monitor } from "../src/monitor.tsx";
import { testTerminal, waitFor } from "./terminal.tsx";

test("empty actions tolerate Enter and resize", async () => {
  const config = OneDxConfigSchema.parse({ project: { name: "Empty" }, services: [], actions: [] });
  const app = testTerminal(<Monitor projectRoot={process.cwd()} config={config} onExit={() => {}} />);
  try {
    await waitFor(() => app.frame().includes("No actions configured"));
    app.stdin.write("\r");
    app.resize(12);
    await Bun.sleep(30);
    expect(app.frame()).toContain("No actions configured");
    app.stdin.write("\x03");
    await app.waitUntilExit();
  } finally { await app.close(); }
});

test("long action menus follow selection and remain usable after shrinking", async () => {
  let exits = 0;
  const config = OneDxConfigSchema.parse({
    project: { name: "Scroll" }, services: [],
    actions: Array.from({ length: 30 }, (_, i) => ({ id: `a${i}`, shortcut: String(i), label: `Action ${i}`, mode: "internal", builtIn: "exit" })),
  });
  const app = testTerminal(<Monitor projectRoot={process.cwd()} config={config} onExit={() => { exits++; }} />, 14);
  try {
    await waitFor(() => app.frame().includes("❯ 0. Action 0"));
    app.stdin.write("\x1b[F");
    await waitFor(() => app.frame().includes("❯ 29. Action 29"));
    expect(app.frame()).not.toContain("0. Action 0");
    app.resize(10, 40);
    await waitFor(() => app.frame().includes("❯ 29. Action 29") && app.frame().split("\n").length <= 10);
    app.stdin.write("\x1b[H");
    await waitFor(() => app.frame().includes("❯ 0. Action 0"));
    app.stdin.write("\r");
    await waitFor(() => exits === 1);
  } finally { await app.close(); }
});

test("failed follow-up commands stay visible until dismissed", async () => {
  const config = OneDxConfigSchema.parse({
    project: { name: "Follow-up" }, services: [],
    actions: [{ id: "run", shortcut: "r", label: "Run", mode: "inline", command: "echo ready", onSuccess: { command: "exit 1", label: "Failed follow-up", args: [] } }],
  });
  const app = testTerminal(<Monitor projectRoot={process.cwd()} config={config} onExit={() => {}} />);
  try {
    await waitFor(() => app.frame().includes("Actions"));
    app.stdin.write("r");
    await waitFor(() => app.frame().includes("Command failed - press any key"));
    await Bun.sleep(600);
    expect(app.frame()).toContain("Failed follow-up");
    app.resize(10);
    await waitFor(() => app.frame().includes("Command failed - press any key"));
    app.stdin.write(" ");
    await waitFor(() => app.frame().includes("Actions"));
  } finally { await app.close(); }
});
