import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runSql(args: string[], {
  stdout = JSON.stringify({ rows: [{ id: 1 }], target: { kind: "local" } }),
  stderr = "Target: local stack (127.0.0.1:54322)\n",
  status = 0,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "1dx-sql-"));
  try {
    mkdirSync(join(directory, "node_modules/.bin"), { recursive: true });
    writeFileSync(join(directory, "package.json"), '{"name":"sql-test","private":true}\n');
    writeFileSync(join(directory, "query.sql"), "select 42 as answer;");
    writeFileSync(join(directory, "run.ts"), `
      import { runSqlCommand } from ${JSON.stringify(new URL("./sql.ts", import.meta.url).href)};
      runSqlCommand(process.argv.slice(2));
    `);
    // Exercise the wrapper's real subprocess path without contacting a project.
    writeFileSync(join(directory, "node_modules/.bin/supabase"), `#!/usr/bin/env bun
      import { writeFileSync } from "node:fs";
      writeFileSync("invocation.json", JSON.stringify(process.argv.slice(2)));
      process.stdout.write(process.env.SQL_TEST_STDOUT ?? "");
      process.stderr.write(process.env.SQL_TEST_STDERR ?? "");
      process.exit(Number(process.env.SQL_TEST_STATUS));
    `, { mode: 0o755 });
    const result = spawnSync(process.execPath, [join(directory, "run.ts"), ...args], {
      cwd: directory,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        SQL_TEST_STDOUT: stdout,
        SQL_TEST_STDERR: stderr,
        SQL_TEST_STATUS: String(status),
      },
    });
    const invocation = join(directory, "invocation.json");
    return {
      ...result,
      args: existsSync(invocation) ? JSON.parse(readFileSync(invocation, "utf8")) as string[] : [],
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("Supabase CLI v3 SQL", () => {
  test("defaults to local, paginates v3 rows, and preserves target diagnostics on stderr", () => {
    const result = runSql(["select id from profiles", "--limit", "1", "--offset", "4"], {
      stdout: JSON.stringify({ rows: [{ id: 5 }, { id: 6 }], target: { kind: "local" } }),
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ rows: [{ id: 5 }], count: 1, hasMore: true, nextOffset: 5 });
    expect(result.stderr).toBe("Target: local stack (127.0.0.1:54322)\n");
    expect(result.args[2]).toContain("limit 2 offset 4");
    expect(result.args).not.toContain("--remote");
    expect(result.args).not.toContain("--yes");
  });

  for (const remote of [
    "--remote",
    "--remote=abcdefghijklmnopqrst",
    "--remote=my-branch",
    "--remote=postgresql://postgres:password@127.0.0.1:54322/postgres?sslmode=disable",
  ]) {
    test(`preserves ${remote} as one argument without consuming SQL`, () => {
      const result = runSql([remote, "select 1", "--read-only"]);
      expect(result.status).toBe(0);
      expect(result.args[2]).toBe("select * from (select 1) as __1dx_sql_query limit 1001 offset 0");
      expect(result.args).toContain(remote);
      expect(result.args).toContain("--read-only");
      expect(result.args).not.toContain("--yes");
    });
  }

  test("passes explicit consent for hosted writes and preserves command tags", () => {
    const result = runSql(["update profiles set name = 'New' where id = 1", "--yes", "--remote"], {
      stdout: "UPDATE 1\n",
    });
    expect(result.status).toBe(0);
    expect(result.args[2]).toBe("update profiles set name = 'New' where id = 1");
    expect(result.args).toContain("--yes");
    expect(result.stdout).toBe("UPDATE 1\n");
  });

  test("propagates missing hosted consent without retrying or adding --yes", () => {
    const error = JSON.stringify({ error: { name: "HostedMutationConsentRequiredError" }, target: { kind: "remote" } });
    const result = runSql(["delete from profiles where id = 1", "--remote"], { stdout: error, status: 1 });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe(error);
    expect(result.args).not.toContain("--yes");
  });

  test("reads file SQL without forwarding a conflicting --file argument", () => {
    const result = runSql(["--file", "query.sql", "--read-only", "--remote"]);
    expect(result.status).toBe(0);
    expect(result.args[2]).toContain("select 42 as answer");
    expect(result.args).not.toContain("--file");
  });

  test("rejects simultaneous inline and file SQL before invoking the CLI", () => {
    const result = runSql(["select 1", "--file", "query.sql"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Provide either inline SQL or --file, not both");
    expect(result.args).toEqual([]);
  });

  for (const output of ["table", "csv"]) {
    test(`passes ${output} output and read-only targeting through unchanged`, () => {
      const result = runSql(["select 1", "--output", output, "--read-only", "--remote"], { stdout: "value\n1\n" });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("value\n1\n");
      expect(result.args[2]).toBe("select 1");
      expect(result.args).toContain(output);
      expect(result.args).toContain("--read-only");
      expect(result.args).toContain("--remote");
    });
  }

  test("keeps v3's deprecated aliases working and exposes the CLI warning", () => {
    const result = runSql(["select 1", "--linked", "--read-only"], {
      stderr: "--linked is deprecated; use --remote.\n",
    });
    expect(result.status).toBe(0);
    expect(result.args).toContain("--linked");
    expect(result.stderr).toContain("--linked is deprecated; use --remote.");
  });

  test("rejects removed --create-ticket before invoking the CLI", () => {
    const result = runSql(["select 1", "--create-ticket"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown flag: --create-ticket");
    expect(result.args).toEqual([]);
  });
});
