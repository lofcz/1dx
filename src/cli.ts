#!/usr/bin/env bun

import { findProjectRoot, loadOneDxConfig } from "./config.ts";
import { runInstaller } from "./install.tsx";
import { startMonitor } from "./monitor.tsx";
import { printSqlHelp, runSqlCommand } from "./sql.ts";

const command = process.argv[2];

function printHelp() {
  console.log(`
\x1b[36m\x1b[1m1dx\x1b[0m

\x1b[33mUsage:\x1b[0m
  bunx 1dxway
  bunx 1dxway start
  bunx 1dxway sql "SELECT * FROM pg_tables"
  bunx 1dxway help

\x1b[33mCommands:\x1b[0m
  \x1b[32m(default)\x1b[0m  Run the interactive installer in the current project
  \x1b[32mstart\x1b[0m      Start the 1dx monitor using ./1dx.json
  \x1b[32msql\x1b[0m        Execute a SQL query through the local Supabase CLI
  \x1b[32mhelp\x1b[0m       Show this help message
`);
}

switch (command) {
  case "start": {
    const projectRoot = findProjectRoot(process.cwd());
    if (!projectRoot) {
      console.error("1dx could not find a package.json in the current directory or its parents.");
      process.exit(1);
    }
    try {
      const { config } = loadOneDxConfig(projectRoot);
      startMonitor(projectRoot, config);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      console.error(`Failed to load 1dx.json: ${text}`);
      process.exit(1);
    }
    break;
  }

  case "sql":
    if (process.argv.includes("--help") || process.argv.includes("-h")) {
      printSqlHelp();
      break;
    }
    runSqlCommand(process.argv.slice(3));
    break;

  case "help":
  case "--help":
  case "-h":
    printHelp();
    break;

  case undefined:
  default:
    runInstaller(process.cwd());
    break;
}
