#!/usr/bin/env bun

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { render, Box, Text, useApp, useInput, useStdout } from "ink";
import stream from "stream";
import net from "net";
import { arch, platform } from "os";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { execSync, spawn, spawnSync } from "child_process";
import type { OneDxAction, OneDxConfig, OneDxService } from "./config.ts";

const IS_WIN = platform() === "win32";
const IS_MAC = platform() === "darwin";
const IS_LINUX = !IS_WIN && !IS_MAC;
const ONE_DX_VERSION = (() => {
  try {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return packageJson.version || "unknown";
  } catch {
    return "unknown";
  }
})();

type ServiceStatus = {
  running: boolean;
  pid: string | null;
};

type ActiveCommand = {
  command: string;
  args: string[];
  label: string;
  action?: OneDxAction;
};

type RuntimeOptions = {
  projectRoot: string;
  config: OneDxConfig;
};

type SpawnedTab = {
  safeTitle: string;
  tempFile: string;
  shouldPersistShell: boolean;
  title?: string;
};

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState({
    columns: stdout?.columns || 80,
    rows: stdout?.rows || 24,
  });

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => {
      setSize({ columns: stdout.columns, rows: stdout.rows });
    };
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}

function Spinner({ message, color = "yellow" }: { message: string; color?: string }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setFrame((current) => (current + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(interval);
  }, []);

  return <Text color={color}>{SPINNER_FRAMES[frame]} {message}</Text>;
}

function StatusBadge({ running, stopping = false }: { running: boolean; stopping?: boolean }) {
  if (stopping) {
    return <Text color="yellow" bold>◐ STOPPING</Text>;
  }
  return running ? <Text color="green" bold>● RUNNING</Text> : <Text color="red">○ STOPPED</Text>;
}

function ServiceRow({
  service,
  status,
  stopping = false,
}: {
  service: OneDxService;
  status: ServiceStatus;
  stopping?: boolean;
}) {
  return (
    <Box>
      <Box width={24}>
        <Text color={service.color}>{service.title}</Text>
      </Box>
      <Box width={14}>
        <StatusBadge running={status.running} stopping={stopping} />
      </Box>
      <Box width={10}>
        {service.health?.type === "port" && status.running && !stopping && <Text dimColor>:{service.health.port}</Text>}
      </Box>
      <Box>
        {status.pid && !stopping && <Text dimColor>PID {status.pid}</Text>}
      </Box>
    </Box>
  );
}

function CommandRunner({
  command,
  args,
  label,
  onDone,
  maxLines = 15,
}: {
  command: string;
  args: string[];
  label: string;
  onDone: (success: boolean, output: string) => void;
  maxLines?: number;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<"running" | "succeeded" | "failed">("running");
  const [frame, setFrame] = useState(0);
  const linesRef = useRef<string[]>([]);

  useEffect(() => {
    if (status !== "running") return;
    const interval = setInterval(() => {
      setFrame((current) => (current + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(interval);
  }, [status]);

  useEffect(() => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    const appendData = (data: Buffer) => {
      const raw = data.toString();
      const chunks = raw.split(/\r?\n|\r/);
      for (const chunk of chunks) {
        const clean = chunk.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").trim();
        if (!clean) continue;
        if (raw.includes("\r") && !raw.includes("\n") && linesRef.current.length > 0) {
          linesRef.current[linesRef.current.length - 1] = clean;
        } else {
          linesRef.current.push(clean);
        }
      }
      linesRef.current = linesRef.current.slice(-maxLines);
      setLines([...linesRef.current]);
    };

    child.stdout?.on("data", appendData);
    child.stderr?.on("data", appendData);

    child.on("close", (code) => {
      setStatus(code === 0 ? "succeeded" : "failed");
      onDone(code === 0, linesRef.current.join("\n"));
    });

    child.on("error", (error) => {
      linesRef.current = [...linesRef.current, error.message];
      setLines([...linesRef.current]);
      setStatus("failed");
      onDone(false, error.message);
    });

    return () => {
      try {
        child.kill();
      } catch {
        // ignore
      }
    };
  }, [command, args, maxLines, onDone]);

  const statusIcon = status === "running"
    ? <Text dimColor>{SPINNER_FRAMES[frame]}</Text>
    : status === "succeeded"
      ? <Text color="green">✓</Text>
      : <Text color="red">✗</Text>;

  return (
    <Box flexDirection="column">
      <Text>{statusIcon} {label}</Text>
      <Text dimColor>  $ {command} {args.join(" ")}</Text>
      {lines.length > 0 && (
        <Box flexDirection="column" marginLeft={2} marginTop={1}>
          {lines.map((line, index) => (
            <Text key={`${index}-${line}`} dimColor>{line}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

function isBunInstalled() {
  try {
    execSync(IS_WIN ? "where bun" : "which bun", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function isNpmAvailable() {
  try {
    execSync(IS_WIN ? "where npm" : "which npm", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function getBunInstallCommand() {
  return IS_WIN ? `powershell -c "irm bun.sh/install.ps1|iex"` : `curl -fsSL https://bun.com/install | bash`;
}

function installBun() {
  try {
    execSync(getBunInstallCommand(), {
      stdio: "inherit",
      shell: IS_WIN ? "cmd.exe" : "/bin/bash",
      timeout: 60000,
    });
    return true;
  } catch {
    return false;
  }
}

function isDockerInstalled() {
  try {
    execSync(IS_WIN ? "where docker" : "which docker", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function getDockerDownloadUrl() {
  if (IS_WIN) {
    return arch() === "arm64"
      ? "https://desktop.docker.com/win/main/arm64/Docker%20Desktop%20Installer.exe?utm_source=docker&utm_medium=webreferral&utm_campaign=dd-smartbutton&utm_location=module"
      : "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe?utm_source=docker&utm_medium=webreferral&utm_campaign=dd-smartbutton&utm_location=module";
  }
  if (IS_MAC) {
    return "https://desktop.docker.com/mac/main/arm64/Docker.dmg?utm_source=docker&utm_medium=webreferral&utm_campaign=dd-smartbutton&utm_location=module";
  }
  return "https://docs.docker.com/desktop/linux/install/";
}

let dockerStatusCache = { running: false, checkedAt: 0 };

function isDockerRunning(bypassCache = false) {
  const now = Date.now();
  if (!bypassCache && now - dockerStatusCache.checkedAt < 10000) {
    return dockerStatusCache.running;
  }

  let running = false;
  try {
    execSync("docker version --format '{{.Server.Version}}'", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5000,
    });
    running = true;
  } catch {
    // ignore
  }

  dockerStatusCache = { running, checkedAt: now };
  return running;
}

function findDockerDesktopPath() {
  if (IS_WIN) {
    const candidates = [
      `${process.env.ProgramFiles}\\Docker\\Docker\\Docker Desktop.exe`,
      `${process.env["ProgramFiles(x86)"]}\\Docker\\Docker\\Docker Desktop.exe`,
      `${process.env.LOCALAPPDATA}\\Docker\\Docker Desktop.exe`,
    ];
    return candidates.find((candidate) => existsSync(candidate)) || null;
  }
  if (IS_MAC && existsSync("/Applications/Docker.app")) {
    return "/Applications/Docker.app";
  }
  return null;
}

function startDockerDesktop() {
  if (IS_MAC) {
    try {
      spawn("open", ["-a", "Docker"], { detached: true, stdio: "ignore" }).unref();
      return true;
    } catch {
      return false;
    }
  }

  if (IS_LINUX) {
    try {
      execSync("systemctl start docker", { stdio: "pipe", timeout: 10000 });
      return true;
    } catch {
      // ignore
    }
    try {
      spawn("systemctl", ["--user", "start", "docker-desktop"], { detached: true, stdio: "ignore" }).unref();
      return true;
    } catch {
      return false;
    }
  }

  const exePath = findDockerDesktopPath();
  if (exePath) {
    try {
      spawn(exePath, [], { detached: true, stdio: "ignore" }).unref();
      return true;
    } catch {
      // ignore
    }
  }

  try {
    spawn("cmd", ["/c", "start", "", "Docker Desktop"], { detached: true, stdio: "ignore", shell: true }).unref();
    return true;
  } catch {
    return false;
  }
}

function areDepsOutdated(projectRoot: string) {
  const nodeModules = join(projectRoot, "node_modules");
  const lockfile = join(projectRoot, "bun.lock");
  const lockfileLegacy = join(projectRoot, "bun.lockb");

  if (!existsSync(nodeModules)) return "missing";

  const lockPath = existsSync(lockfile) ? lockfile : existsSync(lockfileLegacy) ? lockfileLegacy : null;
  if (!lockPath) return false;

  try {
    const lockTime = statSync(lockPath).mtimeMs;
    const nodeTime = statSync(nodeModules).mtimeMs;
    const pkgPath = join(projectRoot, "package.json");
    const packageTime = existsSync(pkgPath) ? statSync(pkgPath).mtimeMs : 0;
    if (lockTime > nodeTime || packageTime > nodeTime) return "outdated";
  } catch {
    return false;
  }

  return false;
}

function openUrl(url: string) {
  try {
    if (IS_WIN) {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", shell: true }).unref();
    } else if (IS_MAC) {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

async function isUrlReady(url: string, timeoutMs = 2000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForUrlReady(urls: string[], maxWaitMs = 30000, pollIntervalMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < maxWaitMs) {
    for (const url of urls) {
      if (await isUrlReady(url)) return true;
    }
    await sleep(pollIntervalMs);
  }
  return false;
}

function getProjectTempDir(projectRoot: string) {
  return join(projectRoot, ".1dx");
}

function getExitFlagPath(projectRoot: string) {
  return join(getProjectTempDir(projectRoot), "exit.flag");
}

function getExitPipeName(projectRoot: string) {
  let hash = 0;
  for (let i = 0; i < projectRoot.length; i++) {
    hash = ((hash << 5) - hash + projectRoot.charCodeAt(i)) | 0;
  }
  return `1dx-exit-${(hash >>> 0).toString(36)}`;
}

let exitPipeServer: net.Server | null = null;
const exitPipeClients = new Set<net.Socket>();

function setupExitPipe(projectRoot: string) {
  if (!IS_WIN) return;
  const pipePath = `\\\\.\\pipe\\${getExitPipeName(projectRoot)}`;
  exitPipeServer = net.createServer((socket) => {
    socket.unref();
    exitPipeClients.add(socket);
    socket.on("close", () => exitPipeClients.delete(socket));
    socket.on("error", () => exitPipeClients.delete(socket));
  });
  exitPipeServer.on("error", () => {});
  exitPipeServer.unref();
  exitPipeServer.listen(pipePath);
}

function signalExitPipe() {
  for (const client of exitPipeClients) {
    try { client.destroy(); } catch {}
  }
  exitPipeClients.clear();
  try { exitPipeServer?.close(); } catch {}
  exitPipeServer = null;
}

function ensureRuntimeDirs(projectRoot: string) {
  mkdirSync(getProjectTempDir(projectRoot), { recursive: true });
}

function hasWindowsTerminal() {
  if (!IS_WIN) return false;
  try {
    execSync("where wt", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const USE_WINDOWS_TERMINAL = hasWindowsTerminal();
let savedWindowHandle: string | null = null;

function saveForegroundWindow() {
  if (!IS_WIN) return null;
  try {
    const script = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class FgWin{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();}';[FgWin]::GetForegroundWindow().ToInt64()`;
    const handle = execSync(`powershell -NoProfile -Command "${script}"`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return handle && handle !== "0" ? handle : null;
  } catch {
    return null;
  }
}

function restoreForegroundWindow(handle: string | null) {
  if (!IS_WIN || !handle) return;
  try {
    const script = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class FgWin{[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int c);}';[FgWin]::ShowWindow([IntPtr]::new(${handle}),9);[FgWin]::SetForegroundWindow([IntPtr]::new(${handle}))`;
    execSync(`powershell -NoProfile -Command "${script}"`, { stdio: "pipe" });
  } catch {
    // ignore
  }
}

function findLinuxTerminal() {
  const terminals = ["gnome-terminal", "konsole", "xfce4-terminal", "mate-terminal", "xterm"];
  for (const terminal of terminals) {
    try {
      execSync(`which ${terminal}`, { stdio: "pipe" });
      return terminal;
    } catch {
      // ignore
    }
  }
  return null;
}

function createTerminalScript(projectRoot: string, id: string, title: string, command: string, manualCommand?: string) {
  ensureRuntimeDirs(projectRoot);
  const displayCommand = manualCommand || command;
  const exitFlag = getExitFlagPath(projectRoot);
  const tempDir = getProjectTempDir(projectRoot);

  if (IS_WIN) {
    const isInteractive = command === "cmd" || command === "powershell";
    const executionBlock = isInteractive
      ? `cls\necho.\necho ============================================================\necho   ${title}\necho ============================================================\necho Manual command: ${displayCommand}\necho.\ncmd /k`
      : `echo.\necho ============================================================\necho   ${title}\necho ============================================================\necho Manual command: ${displayCommand}\necho.\n${command}\necho.\nif exist "${exitFlag}" exit /b 0\necho Process exited. Waiting for monitor shutdown...\npowershell -NoProfile -Command "try{$c=[IO.Pipes.NamedPipeClientStream]::new('.','${getExitPipeName(projectRoot)}','In');$c.Connect(60000);$c.ReadByte()|Out-Null;$c.Close()}catch{}"\nexit /b 0`;
    const scriptContent = `@echo off\ntitle ${title}\ncd /d "${projectRoot}"\n${executionBlock}\n`;
    const tempFile = join(tempDir, `.temp-${id}.bat`);
    writeFileSync(tempFile, scriptContent);
    return tempFile;
  }

  const isInteractive = command === "bash";
  const executionBlock = isInteractive
    ? `clear\necho ""\necho "============================================================"\necho "  ${title}"\necho "============================================================"\necho "Manual command: ${displayCommand}"\necho ""\nexec bash`
    : `echo ""\necho "============================================================"\necho "  ${title}"\necho "============================================================"\necho "Manual command: ${displayCommand}"\necho ""\n${command}\necho ""\nif [ -f "${exitFlag}" ]; then exit 0; fi\necho "Process exited. Waiting for monitor shutdown..."\nwhile true; do sleep 2; if [ -f "${exitFlag}" ]; then exit 0; fi; done`;
  const scriptContent = `#!/usr/bin/env bash\ncd "${projectRoot}"\n${executionBlock}\n`;
  const tempFile = join(tempDir, `.temp-${id}.sh`);
  writeFileSync(tempFile, scriptContent);
  chmodSync(tempFile, 0o755);
  return tempFile;
}

const terminalQueue: SpawnedTab[] = [];

function spawnTerminal(projectRoot: string, id: string, title: string, command: string, manualCommand?: string) {
  const tempFile = createTerminalScript(projectRoot, id, title, command, manualCommand);
  const safeTitle = id.charAt(0).toUpperCase() + id.slice(1);
  const shouldPersistShell = command === "cmd" || command === "powershell" || command === "bash";

  if (IS_WIN) {
    if (USE_WINDOWS_TERMINAL) {
      terminalQueue.push({ safeTitle, tempFile, shouldPersistShell });
      return;
    }

    const windowHandle = saveForegroundWindow();
    spawn("cmd", ["/c", "start", "/min", `"${title}"`, "cmd", shouldPersistShell ? "/k" : "/c", tempFile], {
      detached: true,
      stdio: "ignore",
      shell: true,
      cwd: projectRoot,
    });
    if (windowHandle) {
      setTimeout(() => restoreForegroundWindow(windowHandle), 200);
    }
    return;
  }

  if (IS_MAC) {
    terminalQueue.push({ safeTitle, tempFile, shouldPersistShell, title });
    return;
  }

  const terminal = findLinuxTerminal();
  if (terminal) {
    const argsByTerminal: Record<string, string[]> = {
      "gnome-terminal": ["--tab", "--title", safeTitle, "--", "bash", tempFile],
      "konsole": ["--new-tab", "-e", "bash", tempFile],
      "xfce4-terminal": ["--tab", "--title", safeTitle, "-e", `bash ${tempFile}`],
      "mate-terminal": ["--tab", "--title", safeTitle, "-e", `bash ${tempFile}`],
      "xterm": ["-title", safeTitle, "-e", "bash", tempFile],
    };
    spawn(terminal, argsByTerminal[terminal] || ["-e", "bash", tempFile], {
      detached: true,
      stdio: "ignore",
      cwd: projectRoot,
    }).unref();
    return;
  }

  spawn("bash", [tempFile], { detached: true, stdio: "ignore", cwd: projectRoot }).unref();
}

function flushTerminalQueue(projectRoot: string) {
  if (terminalQueue.length === 0) return;

  if (IS_WIN && USE_WINDOWS_TERMINAL) {
    savedWindowHandle = saveForegroundWindow();
    const args = ["-w", "0"];
    terminalQueue.forEach((term, index) => {
      if (index > 0) args.push(";");
      args.push("nt", "--title", term.safeTitle, "-d", projectRoot, "cmd", term.shouldPersistShell ? "/k" : "/c", term.tempFile);
    });
    const tabsCreated = terminalQueue.length;
    spawn("wt", args, { detached: true, stdio: "ignore", shell: false, cwd: projectRoot });
    terminalQueue.length = 0;

    if (savedWindowHandle) {
      setTimeout(() => {
        restoreForegroundWindow(savedWindowHandle);
        setTimeout(() => {
          restoreForegroundWindow(savedWindowHandle);
          try {
            const keys = "^+{TAB}".repeat(tabsCreated);
            const script = `$wshell = New-Object -ComObject wscript.shell; Start-Sleep -Milliseconds 100; $wshell.SendKeys('${keys}')`;
            spawn("powershell", ["-NoProfile", "-Command", script], { detached: true, stdio: "ignore" });
          } catch {
            // ignore
          }
        }, 500);
      }, 300);
    }
    return;
  }

  if (IS_MAC) {
    const tabCommands = terminalQueue.map((term, index) => {
      const escaped = term.tempFile.replace(/'/g, "'\\''");
      if (index === 0) return `do script "bash '${escaped}'" in window 1`;
      return `
        tell application "System Events" to keystroke "t" using command down
        delay 0.3
        do script "bash '${escaped}'" in selected tab of window 1`;
    }).join("\n        ");

    const appleScript = `
      tell application "Terminal"
        activate
        set currentTab to selected tab of window 1
        ${tabCommands}
        set selected tab of window 1 to currentTab
      end tell`;

    try {
      execSync(`osascript -e '${appleScript.replace(/'/g, "'\\''")}'`, { stdio: "pipe" });
    } catch {
      for (const term of terminalQueue) {
        spawn("open", ["-a", "Terminal", term.tempFile], { detached: true, stdio: "ignore" }).unref();
      }
    }
    terminalQueue.length = 0;
    return;
  }

  terminalQueue.length = 0;
}

function isPortInUse(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", (error: NodeJS.ErrnoException) => resolve(error.code === "EADDRINUSE"));
    server.once("listening", () => {
      server.close();
      resolve(false);
    });
    server.listen(port);
  });
}

function getProcessOnPort(port: number) {
  try {
    if (IS_WIN) {
      const output = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const parts = output.trim().split("\n")[0]?.trim().split(/\s+/);
      return parts?.[parts.length - 1] || null;
    }

    const output = execSync(`lsof -i :${port} -t -sTCP:LISTEN`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output.trim().split("\n")[0] || null;
  } catch {
    return null;
  }
}

function getProcessByName(name: string) {
  try {
    if (IS_WIN) {
      const output = execSync(`tasklist /FI "IMAGENAME eq ${name}*" /FO CSV /NH`, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const lines = output.trim().split("\n").filter((line) => line.toLowerCase().includes(name.toLowerCase()));
      if (lines.length > 0) {
        const match = lines[0].match(/"[^"]+","(\d+)"/);
        if (match) return { running: true, pid: match[1] };
      }
      return { running: false, pid: null };
    }

    const output = execSync(`pgrep -f "${name}"`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pid = output.trim().split("\n")[0];
    return pid ? { running: true, pid } : { running: false, pid: null };
  } catch {
    return { running: false, pid: null };
  }
}

function killPid(pid: string | number) {
  try {
    if (IS_WIN) {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: "pipe" });
    } else {
      execSync(`kill -9 ${pid}`, { stdio: "pipe" });
    }
    return true;
  } catch {
    return false;
  }
}

async function killPort(port: number) {
  const pid = getProcessOnPort(port);
  if (!pid) return false;
  if (!killPid(pid)) return false;
  await sleep(1000);
  return true;
}

function areStatusesEqual(left: Record<string, ServiceStatus>, right: Record<string, ServiceStatus>) {
  const ids = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const id of ids) {
    if (left[id]?.running !== right[id]?.running || left[id]?.pid !== right[id]?.pid) {
      return false;
    }
  }
  return true;
}

async function getServiceStatus(service: OneDxService): Promise<ServiceStatus> {
  if (service.health?.type === "ambient" && service.health.check === "docker") {
    return { running: isDockerRunning(), pid: null };
  }

  if (service.health?.type === "port") {
    const running = await isPortInUse(service.health.port);
    return {
      running,
      pid: running ? getProcessOnPort(service.health.port) : null,
    };
  }

  if (service.health?.type === "process") {
    return getProcessByName(service.health.name);
  }

  return { running: false, pid: null };
}

function getSupabaseMigrationOrderingGuard(output: string) {
  const guardLine = "Found local migration files to be inserted before the last migration on remote database.";
  if (!output.includes(guardLine) || !output.includes("--include-all")) return null;

  const migrations = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("supabase\\migrations\\") || line.startsWith("supabase/migrations/"));

  return { migrations };
}

function SyncStdout({ originalStdout }: { originalStdout: NodeJS.WriteStream }) {
  return class extends stream.Writable {
    originalStdout = originalStdout;
    columns = originalStdout.columns;
    rows = originalStdout.rows;

    constructor() {
      super();
      originalStdout.on("resize", () => {
        this.columns = originalStdout.columns;
        this.rows = originalStdout.rows;
        this.emit("resize");
      });
    }

    override _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      this.originalStdout.write("\x1b[?2026h");
      this.originalStdout.write(chunk, encoding);
      this.originalStdout.write("\x1b[?2026l", callback);
    }
  };
}

function getManagedServices(services: OneDxService[]) {
  return services.filter((service) => !service.ambient);
}

function collectCleanupTargets(services: OneDxService[]) {
  const managed = getManagedServices(services);
  return {
    services: managed,
    ports: [...new Set(managed.flatMap((s) => s.cleanup?.ports || []))],
    processNames: [...new Set(managed.flatMap((s) => s.cleanup?.processNames || []))],
    commandNeedles: [...new Set(managed.flatMap((s) => s.cleanup?.commandLineContains || []))],
  };
}

function stopServicesWindows(projectRoot: string, targets: ReturnType<typeof collectCleanupTargets>, includeManagedTerminalShells: boolean) {
  const { ports, processNames, commandNeedles } = targets;
  const pids = new Set<string>();

  for (const port of ports) {
    const pid = getProcessOnPort(port);
    if (pid) pids.add(pid);
  }
  for (const name of processNames) {
    const proc = getProcessByName(name);
    if (proc.pid) pids.add(proc.pid);
  }

  if (pids.size > 0) {
    const pidArgs = [...pids].flatMap((pid) => ["/PID", pid]);
    try { execSync(`taskkill /F /T ${pidArgs.join(" ")}`, { stdio: "ignore" }); } catch {}
  }

  const needsCim = commandNeedles.length > 0 || includeManagedTerminalShells;
  if (!needsCim) return;

  const tempDir = getProjectTempDir(projectRoot);
  const escapeSingle = (v: string) => v.replace(/'/g, "''");
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$self = ${process.pid}
$targetPids = New-Object 'System.Collections.Generic.HashSet[int]'
$procs = Get-CimInstance Win32_Process
foreach ($p in $procs) {
  if (-not $p.CommandLine) { continue }
  ${commandNeedles.map((n) => `if ($p.CommandLine -like '*${escapeSingle(n)}*') { [void]$targetPids.Add([int]$p.ProcessId) }`).join("\n  ")}
  ${includeManagedTerminalShells ? `if ($p.ProcessId -ne $self -and $p.CommandLine -like '*${escapeSingle(tempDir)}*' -and $p.CommandLine -like '*.temp-*') { [void]$targetPids.Add([int]$p.ProcessId) }` : ""}
}
[void]$targetPids.Remove($self)
if ($targetPids.Count -gt 0) {
  $a = @('/F','/T'); foreach ($id in $targetPids) { $a += '/PID'; $a += "$id" }
  & taskkill @a 2>&1 | Out-Null
}`;

  const encoded = Buffer.from(script, "utf16le").toString("base64");
  spawnSync("powershell", ["-NoProfile", "-EncodedCommand", encoded], { stdio: "ignore", timeout: 15000 });
}

function stopServicesUnix(projectRoot: string, targets: ReturnType<typeof collectCleanupTargets>, includeManagedTerminalShells: boolean) {
  const { ports, processNames, commandNeedles } = targets;
  const pids = new Set<string>();

  for (const port of ports) {
    const pid = getProcessOnPort(port);
    if (pid) pids.add(pid);
  }
  for (const name of processNames) {
    const proc = getProcessByName(name);
    if (proc.pid) pids.add(proc.pid);
  }
  for (const pid of pids) {
    killPid(pid);
  }

  const allNeedles = [...commandNeedles];
  if (includeManagedTerminalShells) allNeedles.push(getProjectTempDir(projectRoot));
  for (const needle of allNeedles) {
    try { execSync(`pkill -f "${needle.replace(/"/g, '\\"')}"`, { stdio: "ignore" }); } catch {}
  }
}

function stopServices(projectRoot: string, services: OneDxService[], options?: { includeManagedTerminalShells?: boolean }) {
  const targets = collectCleanupTargets(services);
  if (targets.services.length === 0 && !options?.includeManagedTerminalShells) return;

  const includeShells = options?.includeManagedTerminalShells ?? false;
  if (IS_WIN) {
    stopServicesWindows(projectRoot, targets, includeShells);
  } else {
    stopServicesUnix(projectRoot, targets, includeShells);
  }
}

function cleanupRuntime(projectRoot: string, config: OneDxConfig) {
  ensureRuntimeDirs(projectRoot);
  try {
    writeFileSync(getExitFlagPath(projectRoot), "1");
  } catch {}

  signalExitPipe();
  stopServices(projectRoot, config.services, { includeManagedTerminalShells: true });

  process.stdout.write("\x1b[?25h");
  process.stdout.write("\x1b[?2026l");
  process.stdin.setRawMode?.(false);
  clearMainTerminal();
  console.log(`\x1b[36m${config.project.name} Dev Monitor stopped.\x1b[0m\nTerminals and configured services have been closed.\n`);

  try { unlinkSync(getExitFlagPath(projectRoot)); } catch {}
  try { rmSync(getProjectTempDir(projectRoot), { recursive: true, force: true }); } catch {}
}

function clearMainTerminal() {
  try {
    if (IS_WIN) {
      spawnSync("cmd", ["/c", "cls"], { stdio: "inherit" });
    } else {
      spawnSync("clear", [], { stdio: "inherit" });
    }
  } catch {
    process.stdout.write("\x1b[2J\x1b[H");
  }
}

function resolveStartupCommand(service: OneDxService, running: boolean) {
  if (!service.start) {
    return null;
  }

  // Some services, like Supabase edge functions, still need a terminal even when
  // their main health check is already passing. In that case we switch to the
  // lighter manual command instead of rerunning the full bootstrap command.
  if (running && service.startPolicy === "always-on-startup" && service.start.manualCommand) {
    return {
      command: service.start.manualCommand,
      manualCommand: service.start.manualCommand,
    };
  }

  return {
    command: service.start.shellCommand,
    manualCommand: service.start.manualCommand,
  };
}

function Startup({ projectRoot, config, onComplete }: { projectRoot: string; config: OneDxConfig; onComplete: () => void }) {
  const [, setStep] = useState(0);
  const [logs, setLogs] = useState<Array<{ color: string; text: string }>>([]);
  const [showSpinner, setShowSpinner] = useState(false);
  const [spinnerMessage, setSpinnerMessage] = useState("");
  const [failed, setFailed] = useState(false);

  const addLog = (color: string, text: string) => setLogs((current) => [...current, { color, text }]);

  useEffect(() => {
    (async () => {
      ensureRuntimeDirs(projectRoot);
      try {
        unlinkSync(getExitFlagPath(projectRoot));
      } catch {
        // ignore
      }

      addLog("cyan", `Starting ${config.project.name} development environment...\n`);

      addLog("yellow", "Checking Bun...");
      if (!isBunInstalled()) {
        addLog("red", "Bun is not installed\n");
        addLog("white", "Install Bun:");
        addLog("cyan", `  ${getBunInstallCommand()}`);
        if (isNpmAvailable()) addLog("cyan", "  npm install -g bun");
        addLog("white", "");
        addLog("yellow", "Attempting to install Bun automatically...");
        if (!installBun()) {
          addLog("red", "Auto-install failed. Please install Bun manually.");
          setFailed(true);
          return;
        }
        addLog("green", "Bun installed successfully");
      }
      addLog("green", "Bun is available");

      if (config.startup?.autoInstallDependencies) {
        addLog("yellow", "Checking local packages...");
        const depsStatus = areDepsOutdated(projectRoot);
        if (depsStatus === "missing" || depsStatus === "outdated") {
          const installCommand = config.project.dependencyInstallCommand || ["bun", "install"];
          addLog("yellow", depsStatus === "missing" ? "node_modules not found, installing dependencies..." : "Lockfile or package.json is newer than node_modules, updating...");
          setShowSpinner(true);
          setSpinnerMessage(`Running ${installCommand.join(" ")}...`);
          const [command, ...args] = installCommand;
          const result = spawnSync(command, args, {
            cwd: projectRoot,
            encoding: "utf8",
            shell: true,
            stdio: ["inherit", "pipe", "pipe"],
          });
          setShowSpinner(false);
          if (result.status !== 0) {
            const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
            addLog("red", `${installCommand.join(" ")} failed`);
            if (output) addLog("red", `  ${output.split("\n")[0]}`);
            setFailed(true);
            return;
          }
          addLog("green", "Dependencies are ready");
        } else {
          addLog("green", "Dependencies are up to date");
        }
      }

      const needsDocker = config.services.some((service) => service.health?.type === "ambient" && service.health.check === "docker");
      if (needsDocker) {
        addLog("yellow", "Checking Docker...");
        if (!isDockerInstalled()) {
          addLog("red", "Docker is not installed or not on PATH");
          addLog("cyan", `  ${getDockerDownloadUrl()}`);
          setFailed(true);
          return;
        }
        addLog("green", "Docker CLI found");
        if (!isDockerRunning()) {
          addLog("yellow", "Docker engine not running, attempting to start Docker Desktop...");
          if (!startDockerDesktop()) {
            addLog("red", "Failed to start Docker Desktop");
            setFailed(true);
            return;
          }
          setShowSpinner(true);
          setSpinnerMessage("Waiting for Docker engine to start...");
          let waited = 0;
          let ready = false;
          while (waited < 60000) {
            await sleep(2000);
            waited += 2000;
            setSpinnerMessage(`Waiting for Docker engine to start... (${Math.floor(waited / 1000)}s / 60s)`);
            if (isDockerRunning(true)) {
              ready = true;
              break;
            }
          }
          setShowSpinner(false);
          if (!ready) {
            addLog("red", "Docker engine did not become ready in time");
            setFailed(true);
            return;
          }
        }
        addLog("green", "Docker engine is running");
      }

      setStep(1);
      const statuses: Record<string, ServiceStatus> = {};
      for (const service of config.services) {
        statuses[service.id] = await getServiceStatus(service);
      }

      addLog("cyan", "\nSpawning terminals...\n");
      for (const service of config.services) {
        if (!service.start) continue;
        const running = statuses[service.id]?.running;
        const shouldStart = service.startPolicy === "always-on-startup" || !running;
        if (!shouldStart) continue;

        const startupCommand = resolveStartupCommand(service, running);
        if (!startupCommand) continue;

        spawnTerminal(
          projectRoot,
          service.id,
          service.title,
          startupCommand.command,
          startupCommand.manualCommand,
        );
        addLog(service.color || "white", `Queued: ${service.title}`);
      }

      flushTerminalQueue(projectRoot);
      addLog("cyan", "Spawned all terminals");

      if (config.startup?.autoOpenFrontend && config.project.frontendUrl) {
        addLog("yellow", `Waiting for frontend to be ready at ${config.project.frontendUrl}...`);
        setShowSpinner(true);
        setSpinnerMessage("Waiting for frontend dev server...");
        const ready = await waitForUrlReady([
          config.project.frontendUrl,
          config.project.frontendUrl.replace("localhost", "127.0.0.1"),
        ], 30000, 1000);
        setShowSpinner(false);
        if (ready) {
          if (openUrl(config.project.frontendUrl)) {
            addLog("green", `Opened frontend in browser (${config.project.frontendUrl})`);
          } else {
            addLog("yellow", `Frontend ready. Open manually: ${config.project.frontendUrl}`);
          }
        } else {
          addLog("yellow", `Frontend did not become ready in time. Open manually when ready: ${config.project.frontendUrl}`);
        }
      }

      addLog("cyan", "\nEntering monitor mode...\n");
      setStep(2);
      await sleep(1500);
      onComplete();
    })();
  }, [config, onComplete, projectRoot]);

  return (
    <Box flexDirection="column" padding={1}>
      {logs.map((log, index) => (
        <Text key={`${index}-${log.text}`} color={log.color}>{log.text}</Text>
      ))}
      {showSpinner && <Spinner message={spinnerMessage} />}
      {failed && (
        <Box marginTop={1}>
          <Text color="red" bold>Startup aborted. Fix the issue above and try again.</Text>
        </Box>
      )}
    </Box>
  );
}

function Monitor({ projectRoot, config, onExit }: { projectRoot: string; config: OneDxConfig; onExit: () => void }) {
  useApp();
  const { rows } = useTerminalSize();
  const [statuses, setStatuses] = useState<Record<string, ServiceStatus>>({});
  const [lastUpdate, setLastUpdate] = useState(new Date());
  const [message, setMessage] = useState<string | null>(null);
  const [waitingForKey, setWaitingForKey] = useState(false);
  const [recoveryPrompt, setRecoveryPrompt] = useState<{ migrations: string[]; retryAction: OneDxAction["recovery"]["retry"] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [stoppingServiceIds, setStoppingServiceIds] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeCommand, setActiveCommand] = useState<ActiveCommand | null>(null);

  const busyRef = useRef(false);
  const refreshingRef = useRef(false);
  const activeCommandRef = useRef<ActiveCommand | null>(null);
  const statusesRef = useRef<Record<string, ServiceStatus>>({});
  const [commandKey, setCommandKey] = useState(0);

  const managedServices = useMemo(
    () => getManagedServices(config.services),
    [config.services],
  );
  const deadServices = managedServices.filter((service) => !statuses[service.id]?.running);

  const menuItems = useMemo(() => {
    return config.actions.map((action) => {
      if (action.builtIn === "start-dead") {
        return {
          ...action,
          label: deadServices.length > 0 ? `Start dead services (${deadServices.map((service) => service.id).join(", ")})` : "All services running ✓",
          value: deadServices.length > 0 ? action.id : "noop",
        };
      }
      return { ...action, value: action.id };
    });
  }, [config.actions, deadServices]);

  useEffect(() => {
    if (selectedIndex >= menuItems.length) {
      setSelectedIndex(menuItems.length - 1);
    }
  }, [menuItems.length, selectedIndex]);

  const refreshStatuses = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      const nextStatuses: Record<string, ServiceStatus> = {};
      for (const service of config.services) {
        nextStatuses[service.id] = await getServiceStatus(service);
      }
      if (!areStatusesEqual(statusesRef.current, nextStatuses)) {
        statusesRef.current = nextStatuses;
        setStatuses(nextStatuses);
      }
      setLastUpdate(new Date());
    } finally {
      refreshingRef.current = false;
    }
  }, [config.services]);

  useEffect(() => {
    refreshStatuses();
    const interval = setInterval(refreshStatuses, 1000);
    return () => clearInterval(interval);
  }, [refreshStatuses]);

  const dismissTransientMessage = useCallback((delayMs = 2000, releaseBusyImmediately = false) => {
    if (releaseBusyImmediately) {
      setBusy(false);
      busyRef.current = false;
    }

    setTimeout(() => {
      setMessage(null);
      setStoppingServiceIds([]);
      if (!releaseBusyImmediately) {
        setBusy(false);
        busyRef.current = false;
      }
    }, delayMs);
  }, []);

  const handleAction = useCallback(async (value: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);

    const action = menuItems.find((item) => item.value === value || item.id === value);
    if (!action || value === "noop") {
      setBusy(false);
      busyRef.current = false;
      return;
    }

    if (action.mode === "external" && action.command) {
      process.stdout.write("\x1b[?25h\x1b[?2026l\x1b[2J\x1b[H");
      try {
        spawnSync(action.command, action.args || [], { cwd: projectRoot, stdio: "inherit", shell: true });
        console.log(`\n\x1b[32m✓ ${action.label} completed. Press any key to return...\x1b[0m`);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        console.log(`\n\x1b[31m✗ ${action.label} failed: ${text}. Press any key to return...\x1b[0m`);
      }
      setWaitingForKey(true);
      return;
    }

    if (action.mode === "inline" && action.command) {
      const command = {
        command: action.command,
        args: action.args || [],
        label: action.label,
        action,
      };
      activeCommandRef.current = command;
      setActiveCommand(command);
      return;
    }

    switch (action.builtIn) {
      case "stop-services":
        setMessage("Stopping all services...");
        const servicesToStop = managedServices.filter((service) => statusesRef.current[service.id]?.running);
        setStoppingServiceIds(servicesToStop.map((service) => service.id));
        stopServices(projectRoot, servicesToStop);
        await refreshStatuses();
        setStoppingServiceIds([]);
        setMessage("✓ Stop commands sent");
        dismissTransientMessage(2000, true);
        return;
      case "start-dead":
        if (deadServices.length === 0) {
          setBusy(false);
          busyRef.current = false;
          return;
        }
        setMessage("Starting dead services...");
        for (const service of deadServices) {
          if (!service.start) continue;
          spawnTerminal(projectRoot, service.id, service.title, service.start.shellCommand, service.start.manualCommand);
        }
        flushTerminalQueue(projectRoot);
        setMessage(`✓ Started: ${deadServices.map((service) => service.id).join(", ")}`);
        setTimeout(() => {
          setMessage(null);
          refreshStatuses();
        }, 2000);
        setBusy(false);
        busyRef.current = false;
        return;
      case "open-url":
        if (!action.url) {
          setMessage("No URL configured");
        } else if (openUrl(action.url)) {
          setMessage(`✓ Opened ${action.label} (${action.url})`);
        } else {
          setMessage(`Open manually: ${action.url}`);
        }
        dismissTransientMessage(2000, true);
        return;
      case "open-frontend":
        if (!config.project.frontendUrl) {
          setMessage("No frontend URL configured");
          dismissTransientMessage(2000, true);
          return;
        }
        const ready = await waitForUrlReady([
          config.project.frontendUrl,
          config.project.frontendUrl.replace("localhost", "127.0.0.1"),
        ], 5000, 500);
        if (!ready) {
          setMessage(`Frontend is still starting. Try again in a moment (${config.project.frontendUrl})`);
        } else if (openUrl(config.project.frontendUrl)) {
          setMessage(`✓ Opened frontend (${config.project.frontendUrl})`);
        } else {
          setMessage(`Open manually: ${config.project.frontendUrl}`);
        }
        dismissTransientMessage(2000, true);
        return;
      case "new-terminal":
        spawnTerminal(projectRoot, `custom-term-${Date.now()}`, `${config.project.name} Terminal`, IS_WIN ? "cmd" : "bash", "Interactive shell");
        flushTerminalQueue(projectRoot);
        setMessage("✓ Opened new terminal tab");
        dismissTransientMessage(2000, true);
        return;
      case "refresh":
        await refreshStatuses();
        setBusy(false);
        busyRef.current = false;
        return;
      case "exit":
        onExit();
        return;
      default:
        setBusy(false);
        busyRef.current = false;
    }
  }, [deadServices, dismissTransientMessage, managedServices, menuItems, onExit, projectRoot, refreshStatuses]);

  const retryRecovery = useCallback(() => {
    if (!recoveryPrompt) return;
    const retryAction: ActiveCommand = {
      command: recoveryPrompt.retryAction.command,
      args: recoveryPrompt.retryAction.args || [],
      label: recoveryPrompt.retryAction.label,
    };
    busyRef.current = true;
    setBusy(true);
    setRecoveryPrompt(null);
    setWaitingForKey(false);
    setMessage(null);
    activeCommandRef.current = retryAction;
    setCommandKey((value) => value + 1);
    setActiveCommand(retryAction);
  }, [recoveryPrompt]);

  const onCommandDone = useCallback((success: boolean, output: string) => {
    const currentAction = activeCommandRef.current?.action;
    if (!currentAction) {
      setTimeout(() => {
        activeCommandRef.current = null;
        setActiveCommand(null);
        setMessage(null);
        setBusy(false);
        busyRef.current = false;
      }, 500);
      return;
    }

    if (success) {
      setRecoveryPrompt(null);
      if (currentAction.onSuccess) {
        const nextCommand: ActiveCommand = {
          command: currentAction.onSuccess.command,
          args: currentAction.onSuccess.args || [],
          label: currentAction.onSuccess.label,
        };
        activeCommandRef.current = nextCommand;
        setCommandKey((value) => value + 1);
        setActiveCommand(nextCommand);
        return;
      }

      setTimeout(() => {
        activeCommandRef.current = null;
        setActiveCommand(null);
        setMessage(null);
        setBusy(false);
        busyRef.current = false;
      }, 500);
      return;
    }

    if (currentAction.recovery?.kind === "supabaseMigrationOrderingGuard") {
      const prompt = getSupabaseMigrationOrderingGuard(output);
      if (prompt) {
        setRecoveryPrompt({ migrations: prompt.migrations, retryAction: currentAction.recovery.retry });
        setWaitingForKey(false);
        setMessage(null);
        return;
      }
    }

    setRecoveryPrompt(null);
    setMessage("Command failed - press any key to continue");
    setWaitingForKey(true);
  }, []);

  const dismissWaitingState = useCallback(() => {
    process.stdout.write("\x1b[?2026h\x1b[?25l");
    activeCommandRef.current = null;
    setActiveCommand(null);
    setRecoveryPrompt(null);
    setMessage(null);
    setWaitingForKey(false);
    setBusy(false);
    busyRef.current = false;
  }, []);

  useInput(
    useCallback((input, key) => {
      if (recoveryPrompt) {
        const inputLower = input.toLowerCase();
        if (key.return || inputLower === "a") {
          retryRecovery();
          return;
        }
        if (key.escape || inputLower === "c" || inputLower === "q") {
          dismissWaitingState();
          return;
        }
        return;
      }

      if (waitingForKey) {
        dismissWaitingState();
        return;
      }

      if (busyRef.current) return;

      if (input) {
        const inputLower = input.toLowerCase();
        const matchedItem = menuItems.find((item) => item.shortcut === inputLower);
        if (matchedItem) {
          handleAction(matchedItem.value);
          return;
        }
      }

      if (key.upArrow) {
        setSelectedIndex((index) => (index > 0 ? index - 1 : index));
        return;
      }

      if (key.downArrow) {
        setSelectedIndex((index) => (index < menuItems.length - 1 ? index + 1 : index));
        return;
      }

      if (key.return) {
        handleAction(menuItems[selectedIndex].value);
      }
    }, [dismissWaitingState, handleAction, menuItems, recoveryPrompt, retryRecovery, selectedIndex, waitingForKey]),
    { isActive: !busy || waitingForKey || recoveryPrompt !== null },
  );

  if (waitingForKey && busyRef.current) {
    return null;
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingTop={1} height={rows ? rows - 1 : undefined} overflow="hidden">
      <Box marginBottom={1}>
        <Text bold color="cyan">{config.project.name} / 1dx {ONE_DX_VERSION}</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor>{"─".repeat(55)}</Text>
        {config.services.map((service) => (
          <ServiceRow
            key={service.id}
            service={service}
            status={statuses[service.id] || { running: false, pid: null }}
            stopping={stoppingServiceIds.includes(service.id)}
          />
        ))}
        <Text dimColor>{"─".repeat(55)}</Text>
        <Text dimColor>Updated: {lastUpdate.toLocaleTimeString()}</Text>
      </Box>

      {activeCommand ? (
        <Box flexDirection="column" marginTop={1}>
          <CommandRunner
            key={commandKey}
            command={activeCommand.command}
            args={activeCommand.args}
            label={activeCommand.label}
            onDone={onCommandDone}
            maxLines={Math.max(5, rows - 18)}
          />
          {recoveryPrompt ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color="yellow">Command was blocked by out-of-order migration guard. Retry with the relaxed mode?</Text>
              {recoveryPrompt.migrations.map((migration) => (
                <Text key={migration} dimColor>  {migration}</Text>
              ))}
              <Text dimColor>Enter or a = retry, Esc or c = cancel</Text>
            </Box>
          ) : waitingForKey && (
            <Box marginTop={1}>
              <Text color="yellow">{message}</Text>
            </Box>
          )}
        </Box>
      ) : message ? (
        <Box marginTop={1}>
          <Text color="yellow">{message}</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Actions (↑↓ Enter, or keys):</Text>
          {menuItems.map((item, index) => (
            <Text key={item.id} color={index === selectedIndex ? "cyan" : undefined}>
              {index === selectedIndex ? "❯ " : "  "}{item.shortcut}. {item.label}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

function ExitScreen({ projectRoot, config }: RuntimeOptions) {
  useEffect(() => {
    const timer = setTimeout(() => {
      cleanupRuntime(projectRoot, config);
      process.exit(0);
    }, 0);
    return () => clearTimeout(timer);
  }, [projectRoot, config]);

  return (
    <Box flexDirection="column" padding={1}>
      <Spinner message={`Closing ${config.project.name} services...`} />
    </Box>
  );
}

function App({ projectRoot, config }: RuntimeOptions) {
  const [mode, setMode] = useState<"startup" | "monitor" | "exiting">("startup");

  if (mode === "startup") {
    return <Startup projectRoot={projectRoot} config={config} onComplete={() => setMode("monitor")} />;
  }

  if (mode === "exiting") {
    return <ExitScreen projectRoot={projectRoot} config={config} />;
  }

  return <Monitor projectRoot={projectRoot} config={config} onExit={() => setMode("exiting")} />;
}

export function startMonitor(projectRoot: string, config: OneDxConfig) {
  ensureRuntimeDirs(projectRoot);
  setupExitPipe(projectRoot);
  const WritableSyncStdout = SyncStdout({ originalStdout: process.stdout });
  clearMainTerminal();

  process.on("exit", () => {
    process.stdout.write("\x1b[?25h");
    process.stdout.write("\x1b[?2026l");
    process.stdin.setRawMode?.(false);
  });

  process.on("SIGINT", () => {
    cleanupRuntime(projectRoot, config);
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    cleanupRuntime(projectRoot, config);
    process.exit(0);
  });

  render(<App projectRoot={projectRoot} config={config} />, {
    stdout: new WritableSyncStdout() as any,
  });
}
