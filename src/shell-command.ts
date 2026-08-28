export type ServiceStart = {
  shellCommand: string;
  unixShellCommand?: string;
};

const WINDOWS_BATCH_MARKERS = [
  /%[A-Za-z_][A-Za-z0-9_]*%/,
  /\bgoto\b/i,
  /\bexit\s+\/b\b/i,
  /\bset\s+\/a\b/i,
  /\btimeout\s+\/t\b/i,
  /(?:^|\n)\s*set\s+[A-Za-z_][A-Za-z0-9_]*=/m,
  /(?:^|\n)\s*:[A-Za-z_][A-Za-z0-9_]*/m,
];

export function looksLikeWindowsBatch(command: string): boolean {
  return WINDOWS_BATCH_MARKERS.some((marker) => marker.test(command));
}

export function supabaseStartRetryWindows(successSuffix: string): string {
  return [
    "set RETRY_COUNT=0",
    ":supabase_start_retry",
    "set /a RETRY_COUNT+=1",
    "if %RETRY_COUNT% gtr 10 (",
    "  echo Supabase start failed after 10 attempts. Exiting.",
    "  exit /b 1",
    ")",
    "bun run supabase:start",
    "if %errorlevel% neq 0 (",
    "  echo Retrying in 5 seconds... ^(attempt %RETRY_COUNT% of 10^)",
    "  timeout /t 5 /nobreak >nul",
    "  goto supabase_start_retry",
    ")",
    successSuffix,
  ].join("\n");
}

export function supabaseStartRetryUnix(successSuffix: string): string {
  return [
    "RETRY_COUNT=0",
    "while true; do",
    "  RETRY_COUNT=$((RETRY_COUNT + 1))",
    "  if [ \"$RETRY_COUNT\" -gt 10 ]; then",
    "    echo \"Supabase start failed after 10 attempts. Exiting.\"",
    "    exit 1",
    "  fi",
    "  if bun run supabase:start; then",
    "    break",
    "  fi",
    "  echo \"Retrying in 5 seconds... (attempt $RETRY_COUNT of 10)\"",
    "  sleep 5",
    "done",
    successSuffix,
  ].join("\n");
}

export function withPortEnvWindows(portExpr: string, command: string): string {
  return `set PORT=${portExpr}\n${command}`;
}

export function withPortEnvUnix(portExpr: string, command: string): string {
  return `export PORT=${portExpr}\n${command}`;
}

function translateInlineSetAnd(command: string): string | null {
  const match = command.match(/^\s*set\s+([A-Za-z_][A-Za-z0-9_]*)=(\S+)\s*&&\s*(.+)$/s);
  if (!match) return null;
  return `${match[1]}=${match[2]} ${match[3]}`;
}

function translateMultilineSetEnv(command: string): string {
  const lines = command.split(/\r?\n/);
  const exports: string[] = [];
  const rest: string[] = [];

  for (const line of lines) {
    const match = line.match(/^\s*set\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !/^\/a\b/.test(match[2])) {
      exports.push(`export ${match[1]}=${match[2]}`);
      continue;
    }
    rest.push(line);
  }

  return [...exports, ...rest].join("\n");
}

function extractSupabaseRetrySuffix(command: string): string {
  const lines = command.split(/\r?\n/);
  let lastControlIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? "";
    if (
      /^goto\b/i.test(line) ||
      /^\)\s*$/.test(line) ||
      /timeout\s+\/t/i.test(line) ||
      /%errorlevel%/i.test(line)
    ) {
      lastControlIdx = i;
    }
  }

  const suffix = lines
    .slice(lastControlIdx + 1)
    .map((line) => line.replace(/\^\(/g, "(").replace(/\^\)/g, ")").trimEnd())
    .filter((line) => line.trim().length > 0)
    .join("\n");

  return suffix || 'echo "Supabase started. This terminal can be closed."';
}

export function toUnixShellCommand(command: string): string {
  if (!looksLikeWindowsBatch(command)) {
    return command;
  }

  if (/bun run supabase:start/.test(command) && (/\bgoto\b/i.test(command) || /%errorlevel%/i.test(command))) {
    return supabaseStartRetryUnix(extractSupabaseRetrySuffix(command));
  }

  return translateInlineSetAnd(command) ?? translateMultilineSetEnv(command);
}

export function resolveServiceStartCommand(start: ServiceStart, isWin = process.platform === "win32"): string {
  if (isWin) {
    return start.shellCommand;
  }
  if (start.unixShellCommand) {
    return start.unixShellCommand;
  }
  return toUnixShellCommand(start.shellCommand);
}
