#!/usr/bin/env bun

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";
import { existsSync, writeFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";
import {
  detectGenericPreset,
  detectSciobotPreset,
  findProjectRoot,
  inferProjectName,
  isOneDxInstalled,
  loadOneDxConfig,
  readPackageJson,
  type OneDxConfig,
} from "./config.ts";
import { startMonitor } from "./monitor.tsx";

type InstallChoice = "detected" | "generic";
type ExistingProjectChoice = "start" | "reconfigure" | "quit";

function updatePackageJson(projectRoot: string) {
  const path = join(projectRoot, "package.json");
  const pkg = readPackageJson(projectRoot);
  pkg.scripts = pkg.scripts || {};
  pkg.scripts["dx"] = "1dxway start";
  pkg.scripts["dx:start"] = "1dxway start";
  pkg.scripts["dx:install"] = "bunx 1dxway";
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

function writeWrappers(projectRoot: string) {
  const bat = `@echo off
cd /d "%~dp0"
where bun >nul 2>nul
if %errorlevel% neq 0 (
    where npm >nul 2>nul
    if %errorlevel% neq 0 (
        echo Neither Bun nor npm found.
        echo.
        echo Install Node.js from: https://nodejs.org/en/download/current
        exit /b 1
    )
    echo Bun not found, installing via npm...
    call npm install -g bun
    if %errorlevel% neq 0 (
        echo Failed to install Bun. Install it manually: https://bun.sh
        exit /b 1
    )
)
bunx 1dxway start %*
`;

  const sh = `#!/usr/bin/env bash
cd "$(dirname "$0")"

if ! command -v bun >/dev/null 2>&1; then
    if ! command -v npm >/dev/null 2>&1; then
        echo "Neither Bun nor npm found."
        echo
        echo "Install Node.js from: https://nodejs.org/en/download/current"
        exit 1
    fi
    echo "Bun not found, installing via npm..."
    npm install -g bun
    if [ $? -ne 0 ]; then
        echo "Failed to install Bun. Install it manually: https://bun.sh"
        exit 1
    fi
fi

bunx 1dxway start "$@"
`;

  writeFileSync(join(projectRoot, "dev.bat"), bat);
  writeFileSync(join(projectRoot, "dev.sh"), sh);
}

function writeConfig(projectRoot: string, config: OneDxConfig) {
  writeFileSync(join(projectRoot, "1dx.json"), `${JSON.stringify(config, null, 2)}\n`);
}

function addDevDependency(projectRoot: string) {
  const pkg = readPackageJson(projectRoot);
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (deps["1dxway"]) {
    return { ok: true, output: "1dxway already installed in package.json" };
  }

  const result = spawnSync("bun", ["add", "-d", "1dxway@latest"], {
    cwd: projectRoot,
    shell: true,
    encoding: "utf8",
  });

  return {
    ok: result.status === 0,
    output: `${result.stdout || ""}\n${result.stderr || ""}`.trim(),
  };
}

function detectBestPreset(projectRoot: string) {
  const pkg = readPackageJson(projectRoot);
  const hasSupabase = existsSync(join(projectRoot, "supabase", "config.toml"));
  const hasVite = existsSync(join(projectRoot, "vite.config.ts")) || Boolean(pkg.scripts?.dev);
  const hasI18n = Boolean(pkg.scripts?.i18n);

  if (hasSupabase || hasI18n || hasVite) {
    return "detected" as const;
  }
  return "generic" as const;
}

function InstallerApp({ projectRoot }: { projectRoot: string }) {
  const { exit } = useApp();
  const alreadyConfigured = existsSync(join(projectRoot, "1dx.json"));
  const [step, setStep] = useState<"welcome" | "configured" | "installing" | "done">(alreadyConfigured ? "configured" : "welcome");
  const [selectedChoice, setSelectedChoice] = useState<InstallChoice>(detectBestPreset(projectRoot));
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const projectName = inferProjectName(projectRoot);
  const alreadyInstalled = isOneDxInstalled(projectRoot);

  const choices = useMemo(
    () => [
      {
        id: "detected" as const,
        title: "Detected starter",
        description: "Use stack detection to generate a ready-to-run config for this project.",
      },
      {
        id: "generic" as const,
        title: "Generic starter",
        description: "Write a smaller generic config you can customize manually.",
      },
    ],
    [],
  );

  const configuredChoices = useMemo(
    () => [
      {
        id: "start" as const,
        title: "Start project",
        description: "Launch the configured 1dx monitor now.",
      },
      {
        id: "reconfigure" as const,
        title: "Reconfigure project",
        description: "Regenerate config, wrappers, and scripts.",
      },
      {
        id: "quit" as const,
        title: "Quit",
        description: "Exit without changing anything.",
      },
    ],
    [],
  );

  const appendLog = useCallback((line: string) => {
    setLogs((current) => [...current, line]);
  }, []);

  useEffect(() => {
    if (step !== "installing") return;

    const run = async () => {
      try {
        appendLog(`Project root: ${projectRoot}`);
        appendLog(alreadyConfigured ? "Existing 1dx configuration detected. Repairing files..." : "Installing 1dx into this project...");

        const config = selectedChoice === "detected"
          ? detectSciobotPreset(projectRoot)
          : detectGenericPreset(projectRoot);

        appendLog(`Selected starter: ${selectedChoice === "detected" ? "Detected" : "Generic"}`);
        writeConfig(projectRoot, config);
        appendLog("Wrote 1dx.json");

        const installResult = addDevDependency(projectRoot);
        if (!installResult.ok) {
          throw new Error(installResult.output || "Failed to add 1dxway dev dependency");
        }
        appendLog("Ensured 1dxway is installed as a dev dependency");

        updatePackageJson(projectRoot);
        appendLog("Updated package.json scripts");

        writeWrappers(projectRoot);
        appendLog("Wrote dev.bat and dev.sh wrappers");

        setStep("done");
      } catch (installError) {
        setError(installError instanceof Error ? installError.message : String(installError));
        setStep("done");
      }
    };

    void run();
  }, [alreadyConfigured, alreadyInstalled, appendLog, projectRoot, selectedChoice, step]);

  useInput((input, key) => {
    if (step === "configured") {
      if (key.upArrow) {
        setSelectedIndex((current) => (current > 0 ? current - 1 : current));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((current) => (current < configuredChoices.length - 1 ? current + 1 : current));
        return;
      }
      if (key.return) {
        const choice: ExistingProjectChoice = configuredChoices[selectedIndex]?.id || "start";
        if (choice === "start") {
          exit();
          setTimeout(() => {
            const { config } = loadOneDxConfig(projectRoot);
            startMonitor(projectRoot, config);
          }, 0);
          return;
        }
        if (choice === "reconfigure") {
          setSelectedIndex(0);
          setStep("welcome");
          return;
        }
        exit();
        return;
      }
      if (input.toLowerCase() === "q" || key.escape) {
        exit();
      }
      return;
    }

    if (step === "welcome") {
      if (key.upArrow) {
        setSelectedIndex((current) => (current > 0 ? current - 1 : current));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((current) => (current < choices.length - 1 ? current + 1 : current));
        return;
      }
      if (key.return) {
        setSelectedChoice(choices[selectedIndex]?.id || "detected");
        setStep("installing");
        return;
      }
      if (input.toLowerCase() === "q" || key.escape) {
        exit();
      }
      return;
    }

    if (step === "done" && (key.return || input.toLowerCase() === "q")) {
      exit();
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">1dx Installer</Text>
      <Text dimColor>Project: {projectName}</Text>
      <Text dimColor>Root: {projectRoot}</Text>
      <Text>{alreadyConfigured ? "This project is already configured for 1dx." : "This wizard will bootstrap 1dx in the current project."}</Text>
      <Text> </Text>

      {step === "configured" && (
        <Box flexDirection="column">
          <Text bold>What would you like to do?</Text>
          {configuredChoices.map((choice, index) => (
            <Text key={choice.id} color={selectedIndex === index ? "cyan" : undefined}>
              {selectedIndex === index ? "❯ " : "  "}{choice.title} - {choice.description}
            </Text>
          ))}
          <Text> </Text>
          <Text dimColor>Enter = continue, q = quit</Text>
        </Box>
      )}

      {step === "welcome" && (
        <Box flexDirection="column">
          <Text bold>Choose a starter:</Text>
          {choices.map((choice, index) => (
            <Text key={choice.id} color={selectedIndex === index ? "cyan" : undefined}>
              {selectedIndex === index ? "❯ " : "  "}{choice.title} - {choice.description}
            </Text>
          ))}
          <Text> </Text>
          <Text dimColor>Enter = continue, q = quit</Text>
        </Box>
      )}

      {step === "installing" && (
        <Box flexDirection="column">
          <Text color="yellow">Installing...</Text>
          {logs.map((line, index) => (
            <Text key={`${index}-${line}`} dimColor>{line}</Text>
          ))}
        </Box>
      )}

      {step === "done" && (
        <Box flexDirection="column">
          {error ? <Text color="red">Installation failed: {error}</Text> : <Text color="green">1dx is ready.</Text>}
          {logs.map((line, index) => (
            <Text key={`${index}-${line}`} dimColor>{line}</Text>
          ))}
          {!error && (
            <>
              <Text> </Text>
              <Text>Next steps:</Text>
              <Text dimColor>  - Run `bunx 1dxway start` or use `dev.bat` / `dev.sh`</Text>
              <Text dimColor>  - Edit `1dx.json` to customize services and actions</Text>
            </>
          )}
          <Text> </Text>
          <Text dimColor>Press Enter or q to exit.</Text>
        </Box>
      )}
    </Box>
  );
}

export function runInstaller(startDir = process.cwd()) {
  const projectRoot = findProjectRoot(startDir);
  if (!projectRoot) {
    console.error("1dx could not find a package.json in the current directory or its parents.");
    process.exit(1);
  }

  render(<InstallerApp projectRoot={projectRoot} />);
}
