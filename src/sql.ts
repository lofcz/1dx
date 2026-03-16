import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const DEFAULT_LIMIT = 1000;
const ALLOWED_OUTPUTS = new Set(["json", "table", "csv"]);
const SUPABASE_VALUE_FLAGS = new Set([
  "--db-url",
  "--dns-resolver",
  "--network-id",
  "--profile",
  "--workdir",
]);
const SUPABASE_BOOLEAN_FLAGS = new Set([
  "--create-ticket",
  "--debug",
  "--experimental",
  "--linked",
  "--local",
  "--yes",
]);

type OutputFormat = "json" | "table" | "csv";

type ParsedSqlArgs = {
  sql: string;
  output: OutputFormat;
  limit: number;
  offset: number;
  forwardedArgs: string[];
};

type JsonQueryPayload = {
  rows?: unknown;
};

const getFlagValue = (token: string, args: string[], index: number) => {
  const equalSignIndex = token.indexOf("=");
  if (equalSignIndex >= 0) {
    return {
      value: token.slice(equalSignIndex + 1),
      nextIndex: index,
    };
  }

  const nextValue = args[index + 1];
  if (nextValue == null) {
    throw new Error(`Missing value for ${token}.`);
  }

  return {
    value: nextValue,
    nextIndex: index + 1,
  };
};

const parsePositiveInteger = (value: string, flagName: string, minimum: number) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${flagName} must be an integer >= ${minimum}.`);
  }

  return parsed;
};

const readSqlInput = (args: string[]) => {
  let output: OutputFormat = "json";
  let filePath: string | null = null;
  let limit = DEFAULT_LIMIT;
  let offset = 0;
  const forwardedArgs: string[] = [];
  const sqlTokens: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];

    if (token === "--help" || token === "-h") {
      printSqlHelp();
      process.exit(0);
    }

    if (token === "--") {
      sqlTokens.push(...args.slice(index + 1));
      break;
    }

    if (
      token === "--output" ||
      token === "-o" ||
      token.startsWith("--output=")
    ) {
      const { value, nextIndex } = getFlagValue(token, args, index);
      if (!ALLOWED_OUTPUTS.has(value)) {
        throw new Error(`--output must be one of: json, table, csv.`);
      }
      output = value as OutputFormat;
      index = nextIndex;
      continue;
    }

    if (
      token === "--file" ||
      token === "-f" ||
      token.startsWith("--file=")
    ) {
      const { value, nextIndex } = getFlagValue(token, args, index);
      filePath = value;
      index = nextIndex;
      continue;
    }

    if (token === "--limit" || token.startsWith("--limit=")) {
      const { value, nextIndex } = getFlagValue(token, args, index);
      limit = parsePositiveInteger(value, "--limit", 1);
      index = nextIndex;
      continue;
    }

    if (token === "--offset" || token.startsWith("--offset=")) {
      const { value, nextIndex } = getFlagValue(token, args, index);
      offset = parsePositiveInteger(value, "--offset", 0);
      index = nextIndex;
      continue;
    }

    const flagName = token.split("=")[0];
    if (SUPABASE_BOOLEAN_FLAGS.has(flagName)) {
      forwardedArgs.push(token);
      continue;
    }

    if (SUPABASE_VALUE_FLAGS.has(flagName)) {
      const { value, nextIndex } = getFlagValue(token, args, index);
      forwardedArgs.push(flagName, value);
      index = nextIndex;
      continue;
    }

    if (token.startsWith("-")) {
      throw new Error(`Unknown flag: ${token}`);
    }

    sqlTokens.push(token);
  }

  if (filePath && sqlTokens.length > 0) {
    throw new Error(`Provide either inline SQL or --file, not both.`);
  }

  const sql = filePath
    ? readFileSync(filePath, "utf8")
    : sqlTokens.join(" ").trim();

  if (!sql) {
    throw new Error(`SQL is required. Pass a query string or use --file.`);
  }

  return {
    sql,
    output,
    limit,
    offset,
    forwardedArgs,
  } satisfies ParsedSqlArgs;
};

const trimTrailingSemicolons = (sql: string) =>
  sql.trim().replace(/;+$/u, "").trim();

const canPaginateQuery = (sql: string) => {
  const normalized = trimTrailingSemicolons(sql).toLowerCase();
  return (
    normalized.startsWith("select ") ||
    normalized.startsWith("select\n") ||
    normalized.startsWith("with ") ||
    normalized.startsWith("with\n") ||
    normalized.startsWith("values ") ||
    normalized.startsWith("values\n")
  );
};

const buildPaginatedQuery = (sql: string, limit: number, offset: number) => {
  const normalized = trimTrailingSemicolons(sql);
  return `select * from (${normalized}) as __1dx_sql_query limit ${limit} offset ${offset}`;
};

const getSupabaseQueryArgs = (
  sql: string,
  output: OutputFormat,
  forwardedArgs: string[],
) => ["x", "supabase", "db", "query", sql, "--output", output, ...forwardedArgs];

const runSupabaseQuery = (
  sql: string,
  output: OutputFormat,
  forwardedArgs: string[],
) =>
  spawnSync(process.execPath, getSupabaseQueryArgs(sql, output, forwardedArgs), {
    encoding: "utf8",
    cwd: process.cwd(),
  });

const writeOutputAndExit = (stdout: string, stderr: string, exitCode: number) => {
  if (stdout) {
    process.stdout.write(stdout);
  }
  if (stderr) {
    process.stderr.write(stderr);
  }
  process.exit(exitCode);
};

const extractJsonPayload = (stdout: string) => {
  const jsonStart = stdout.indexOf("{");
  if (jsonStart < 0) {
    throw new Error("Supabase CLI did not return JSON output.");
  }

  const parsed = JSON.parse(stdout.slice(jsonStart)) as JsonQueryPayload;
  if (!Array.isArray(parsed.rows)) {
    throw new Error("Supabase CLI JSON output did not include a rows array.");
  }

  return parsed.rows;
};

const printJsonResult = (rows: unknown[], limit: number, offset: number) => {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const result: {
    rows: unknown[];
    count: number;
    hasMore?: true;
    nextOffset?: number;
  } = {
    rows: pageRows,
    count: pageRows.length,
  };

  if (hasMore) {
    result.hasMore = true;
    result.nextOffset = offset + limit;
  }

  process.stdout.write(
    `${JSON.stringify(result, null, 2)}\n`,
  );
};

export function printSqlHelp() {
  console.log(`
\x1b[36m\x1b[1m1dx sql\x1b[0m

\x1b[33mUsage:\x1b[0m
  bunx 1dxway sql "SELECT * FROM pg_tables"
  bunx 1dxway sql --file ./query.sql
  bunx 1dxway sql "SELECT * FROM pg_tables" --output table
  bunx 1dxway sql "SELECT * FROM pg_tables" --limit 250 --offset 250

\x1b[33mOptions:\x1b[0m
  \x1b[32m-o, --output\x1b[0m    Output format: json, table, csv (default: json)
  \x1b[32m-f, --file\x1b[0m      Read SQL from a file
  \x1b[32m--limit\x1b[0m         Maximum JSON rows per page (default: 1000)
  \x1b[32m--offset\x1b[0m        Row offset for JSON pagination (default: 0)
  \x1b[32m-h, --help\x1b[0m      Show this help message

\x1b[33mBehavior:\x1b[0m
  JSON output always returns rows plus a count of matched rows in the current response.
  When a JSON query has more than the page limit, 1dx also returns pagination metadata.
  Table and CSV output are passed through from the Supabase CLI unchanged.

\x1b[33mSupabase flags:\x1b[0m
  Pass through flags like --linked, --local, --db-url, --profile, or --workdir.
`);
}

export function runSqlCommand(rawArgs: string[]) {
  let parsed: ParsedSqlArgs;

  try {
    parsed = readSqlInput(rawArgs);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${text}\n`);
    process.stderr.write(`Run "bunx 1dxway sql --help" for usage.\n`);
    process.exit(1);
  }

  if (parsed.output !== "json") {
    const result = spawnSync(
      process.execPath,
      getSupabaseQueryArgs(parsed.sql, parsed.output, parsed.forwardedArgs),
      {
        cwd: process.cwd(),
        stdio: "inherit",
      },
    );
    if (result.error) {
      process.stderr.write(`${result.error.message}\n`);
      process.exit(1);
    }

    process.exit(result.status ?? 1);
  }

  const pageLimit = parsed.limit + 1;
  const paginatedSql = canPaginateQuery(parsed.sql)
    ? buildPaginatedQuery(parsed.sql, pageLimit, parsed.offset)
    : parsed.sql;
  const result = runSupabaseQuery(paginatedSql, parsed.output, parsed.forwardedArgs);

  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    process.exit(1);
  }

  if ((result.status ?? 1) !== 0) {
    writeOutputAndExit(result.stdout, result.stderr, result.status ?? 1);
  }

  try {
    const rows = extractJsonPayload(result.stdout);
    printJsonResult(rows, parsed.limit, parsed.offset);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${text}\n`);
    process.exit(1);
  }
}
