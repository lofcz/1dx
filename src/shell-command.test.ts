import { describe, expect, test } from "bun:test";
import {
  looksLikeWindowsBatch,
  resolveServiceStartCommand,
  supabaseStartRetryUnix,
  supabaseStartRetryWindows,
  toUnixShellCommand,
  withPortEnvUnix,
  withPortEnvWindows,
} from "./shell-command.ts";

const SUPABASE_SUFFIX = "echo Supabase started. This terminal can be closed.";

describe("looksLikeWindowsBatch", () => {
  test("detects the generated supabase retry script", () => {
    expect(looksLikeWindowsBatch(supabaseStartRetryWindows(SUPABASE_SUFFIX))).toBe(true);
  });

  test("detects set PORT && command", () => {
    expect(looksLikeWindowsBatch("set PORT=4001 && bun run mock-server.ts")).toBe(true);
  });

  test("leaves portable bun commands alone", () => {
    expect(looksLikeWindowsBatch("bun run dev")).toBe(false);
    expect(looksLikeWindowsBatch("bun run edge:serve")).toBe(false);
  });
});

describe("toUnixShellCommand", () => {
  test("translates the supabase retry loop and keeps the success suffix", () => {
    const unix = toUnixShellCommand(supabaseStartRetryWindows(SUPABASE_SUFFIX));
    expect(unix).toBe(supabaseStartRetryUnix(SUPABASE_SUFFIX));
    expect(unix).toContain("bun run supabase:start");
    expect(unix).toContain("sleep 5");
    expect(unix).not.toContain("goto");
    expect(unix).not.toContain("%errorlevel%");
  });

  test("keeps supabase:functions:serve as the success suffix", () => {
    const suffix = "bun run supabase:functions:serve";
    expect(toUnixShellCommand(supabaseStartRetryWindows(suffix))).toBe(supabaseStartRetryUnix(suffix));
  });

  test("translates inline set PORT && command", () => {
    expect(toUnixShellCommand("set PORT=4001 && bun run mock-server.ts")).toBe(
      "PORT=4001 bun run mock-server.ts",
    );
  });

  test("translates multiline set PORT", () => {
    expect(toUnixShellCommand(withPortEnvWindows("${edgePort}", "bun run edge:serve"))).toBe(
      withPortEnvUnix("${edgePort}", "bun run edge:serve"),
    );
  });

  test("returns portable commands unchanged", () => {
    expect(toUnixShellCommand("bun run i18n")).toBe("bun run i18n");
  });
});

describe("resolveServiceStartCommand", () => {
  test("uses shellCommand on Windows", () => {
    expect(
      resolveServiceStartCommand(
        {
          shellCommand: "set PORT=3100\nbun run edge:serve",
          unixShellCommand: "export PORT=3100\nbun run edge:serve",
        },
        true,
      ),
    ).toBe("set PORT=3100\nbun run edge:serve");
  });

  test("prefers unixShellCommand on Unix", () => {
    expect(
      resolveServiceStartCommand(
        {
          shellCommand: "set PORT=3100\nbun run edge:serve",
          unixShellCommand: "export PORT=3100\nbun run edge:serve",
        },
        false,
      ),
    ).toBe("export PORT=3100\nbun run edge:serve");
  });

  test("translates existing Windows-only 1dx.json on Unix", () => {
    const command = supabaseStartRetryWindows(SUPABASE_SUFFIX);
    expect(resolveServiceStartCommand({ shellCommand: command }, false)).toBe(
      supabaseStartRetryUnix(SUPABASE_SUFFIX),
    );
  });
});
