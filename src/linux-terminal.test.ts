import { describe, expect, test } from "bun:test";
import {
  buildKonsoleLayoutFile,
  buildKonsoleTabsFile,
  konsoleExecCommand,
  linuxBatchLaunchArgs,
  linuxLaunchArgs,
  quoteForShell,
  resolveKonsoleDbusTarget,
  shouldRunCloseOnFinishInline,
  terminalSupportsBatchTabs,
} from "./linux-terminal.ts";

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

describe("buildKonsoleTabsFile", () => {
  test("uses spaced ;; tokens Konsole actually parses", () => {
    const file = buildKonsoleTabsFile(
      [
        { title: "Edge Functions (1tube)", tempFile: "/repo/.1dx/.temp-edge.sh" },
        { title: "Frontend (Rsbuild)", tempFile: "/repo/.1dx/.temp-frontend.sh" },
      ],
      "/repo",
    );
    expect(file).toBe(
      "title: Edge Functions (1tube) ;; workdir: /repo ;; command: /repo/.1dx/.temp-edge.sh\n" +
        "title: Frontend (Rsbuild) ;; workdir: /repo ;; command: /repo/.1dx/.temp-frontend.sh\n",
    );
  });

  test("strips ;; so a title cannot inject extra tokens", () => {
    const file = buildKonsoleTabsFile(
      [{ title: "A;; command: /bin/evil", tempFile: "/tmp/ok.sh" }],
      "/tmp",
    );
    expect(file).not.toContain(";; command: /bin/evil");
    expect(file).toContain("command: /tmp/ok.sh");
  });
});

describe("linuxBatchLaunchArgs", () => {
  test("konsole opens one window from a tabs file and kills the leftover default tab", () => {
    const launch = linuxBatchLaunchArgs(
      "konsole",
      [{ title: "Edge", tempFile: "/tmp/edge.sh" }],
      "/tmp/tabs",
    );
    expect(launch.command).toBe("konsole");
    expect(launch.args).toEqual(["--show-tabbar", "--tabs-from-file", "/tmp/tabs", "-e", "/bin/true"]);
    expect(launch.args).not.toContain("--new-tab");
  });

  test("gnome-terminal puts every service in one process as --tab", () => {
    const launch = linuxBatchLaunchArgs(
      "gnome-terminal",
      [
        { title: "Edge", tempFile: "/tmp/edge.sh" },
        { title: "Frontend", tempFile: "/tmp/fe.sh" },
      ],
      "/tmp/unused",
    );
    expect(launch.args).toEqual([
      "--tab", "--title", "Edge", "--", "/tmp/edge.sh",
      "--tab", "--title", "Frontend", "--", "/tmp/fe.sh",
    ]);
  });

  test("konsole and gnome-terminal support batch tabs", () => {
    expect(terminalSupportsBatchTabs("konsole")).toBe(true);
    expect(terminalSupportsBatchTabs("xterm")).toBe(false);
  });
});

describe("konsole attach helpers", () => {
  test("layout JSON is a single-tab splitter with Command + cwd", () => {
    const json = JSON.parse(buildKonsoleLayoutFile("exec '/tmp/edge.sh'", "/repo"));
    expect(json.Orientation).toBe("Horizontal");
    expect(json.Widgets).toEqual([
      {
        SessionRestoreId: 0,
        Command: "exec '/tmp/edge.sh'",
        WorkingDirectory: "/repo",
      },
    ]);
  });

  test("exec command quotes spaces and apostrophes", () => {
    expect(konsoleExecCommand("/tmp/ok.sh")).toBe("exec '/tmp/ok.sh'");
    expect(konsoleExecCommand("/tmp/it's.sh")).toBe("exec '/tmp/it'\\''s.sh'");
    expect(quoteForShell("a b")).toBe("'a b'");
  });

  test("prefers KONSOLE_DBUS_* from the current session", () => {
    expect(
      resolveKonsoleDbusTarget({
        KONSOLE_DBUS_SERVICE: "org.kde.konsole-123",
        KONSOLE_DBUS_WINDOW: "2",
      }),
    ).toEqual({ service: "org.kde.konsole-123", windowPath: "/Windows/2" });
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
