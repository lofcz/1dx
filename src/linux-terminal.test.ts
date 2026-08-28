import { describe, expect, test } from "bun:test";
import { linuxLaunchArgs, shouldRunCloseOnFinishInline } from "./linux-terminal.ts";

describe("linuxLaunchArgs", () => {
  test("konsole never combines --new-tab with -e", () => {
    const launch = linuxLaunchArgs("konsole", "Backend (Supabase)", "/tmp/.temp-backend.sh");
    expect(launch.command).toBe("konsole");
    expect(launch.args).not.toContain("--new-tab");
    expect(launch.args).toContain("-e");
    expect(launch.args.at(-1)).toBe("/tmp/.temp-backend.sh");
  });

  test("gnome-terminal runs the script directly after --", () => {
    const launch = linuxLaunchArgs("gnome-terminal", "Edge", "/tmp/edge.sh");
    expect(launch.args.slice(-2)).toEqual(["--", "/tmp/edge.sh"]);
  });
});

describe("shouldRunCloseOnFinishInline", () => {
  test("one-shot bootstraps run inside the monitor on Unix", () => {
    expect(shouldRunCloseOnFinishInline(false, true)).toBe(true);
  });

  test("Windows keeps the existing cmd window for close-on-finish", () => {
    expect(shouldRunCloseOnFinishInline(true, true)).toBe(false);
  });

  test("long-running services still use a terminal tab", () => {
    expect(shouldRunCloseOnFinishInline(false, false)).toBe(false);
  });
});
