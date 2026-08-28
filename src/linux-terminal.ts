/**
 * How to launch service scripts in a Linux terminal emulator.
 *
 * Konsole `--new-tab` only attaches when "single process" mode is on.
 * DBus `Session.runCommand` / `sendText` / `setProfile` are AccessDenied
 * unless the user enables the security-sensitive DBus API.
 *
 * `Window.loadLayout` is allowed and *adds* a tab to the existing window.
 * The layout's Command is typed into the new session (same as Konsole's
 * own layout loader). Prefer that when 1dx is already inside Konsole.
 * Otherwise open one new window via `--tabs-from-file`.
 */

import { readFileSync } from "fs";
import { execFileSync } from "child_process";

export const LINUX_TERMINALS = [
  "gnome-terminal",
  "konsole",
  "xfce4-terminal",
  "mate-terminal",
  "alacritty",
  "kitty",
  "wezterm",
  "foot",
  "xterm",
] as const;

export type LinuxTerminal = (typeof LINUX_TERMINALS)[number];

export type LinuxTab = {
  title: string;
  tempFile: string;
};

export function linuxLaunchArgs(
  terminal: LinuxTerminal | string,
  title: string,
  tempFile: string,
): { command: string; args: string[] } {
  switch (terminal) {
    case "gnome-terminal":
      return { command: "gnome-terminal", args: ["--tab", "--title", title, "--", tempFile] };
    case "konsole":
      return { command: "konsole", args: ["-p", `tabtitle=${title}`, "-e", tempFile] };
    case "xfce4-terminal":
      return { command: "xfce4-terminal", args: ["--tab", "--title", title, "-e", tempFile] };
    case "mate-terminal":
      return { command: "mate-terminal", args: ["--tab", "--title", title, "-e", tempFile] };
    case "alacritty":
      return { command: "alacritty", args: ["--title", title, "-e", tempFile] };
    case "kitty":
      return { command: "kitty", args: ["--title", title, tempFile] };
    case "wezterm":
      return { command: "wezterm", args: ["start", "--", tempFile] };
    case "foot":
      return { command: "foot", args: ["-T", title, tempFile] };
    case "xterm":
      return { command: "xterm", args: ["-title", title, "-e", tempFile] };
    default:
      return { command: terminal, args: ["-e", tempFile] };
  }
}

export function terminalSupportsBatchTabs(terminal: LinuxTerminal | string) {
  return (
    terminal === "konsole" ||
    terminal === "gnome-terminal" ||
    terminal === "xfce4-terminal" ||
    terminal === "mate-terminal"
  );
}

export function sanitizeKonsoleTabsField(value: string) {
  return value.replace(/;;/g, " ").replace(/[\r\n]+/g, " ").trim();
}

export function buildKonsoleTabsFile(tabs: LinuxTab[], workdir: string) {
  const dir = sanitizeKonsoleTabsField(workdir);
  return tabs
    .map((tab) => {
      const title = sanitizeKonsoleTabsField(tab.title);
      const command = sanitizeKonsoleTabsField(tab.tempFile);
      return `title: ${title} ;; workdir: ${dir} ;; command: ${command}`;
    })
    .join("\n") + "\n";
}

export function linuxBatchLaunchArgs(
  terminal: LinuxTerminal | string,
  tabs: LinuxTab[],
  tabsFile: string,
): { command: string; args: string[] } {
  if (terminal === "konsole") {
    return {
      command: "konsole",
      args: ["--show-tabbar", "--tabs-from-file", tabsFile, "-e", "/bin/true"],
    };
  }

  if (terminal === "gnome-terminal") {
    const args: string[] = [];
    for (const tab of tabs) {
      args.push("--tab", "--title", tab.title, "--", tab.tempFile);
    }
    return { command: "gnome-terminal", args };
  }

  if (terminal === "xfce4-terminal" || terminal === "mate-terminal") {
    const args: string[] = [];
    for (const tab of tabs) {
      args.push("--tab", "--title", tab.title, "-e", tab.tempFile);
    }
    return { command: terminal, args };
  }

  const first = tabs[0];
  return linuxLaunchArgs(terminal, first?.title ?? "1dx", first?.tempFile ?? "/bin/true");
}

export function shouldRunCloseOnFinishInline(isWin: boolean, closeOnFinish: boolean): boolean {
  return !isWin && closeOnFinish;
}

export function quoteForShell(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function konsoleExecCommand(scriptPath: string) {
  return `exec ${quoteForShell(scriptPath)}`;
}

export function buildKonsoleLayoutFile(command: string, workdir: string) {
  return `${JSON.stringify({
    Orientation: "Horizontal",
    Widgets: [
      {
        SessionRestoreId: 0,
        Command: command,
        WorkingDirectory: workdir,
      },
    ],
  }, null, 2)}\n`;
}

export type KonsoleDbusTarget = {
  service: string;
  windowPath: string;
};

function commandExists(bin: string) {
  try {
    execFileSync("which", [bin], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function findQdbus() {
  for (const bin of ["qdbus6", "qdbus-qt6", "qdbus"]) {
    if (commandExists(bin)) return bin;
  }
  return null;
}

function readProcStatus(pid: number) {
  try {
    const text = readFileSync(`/proc/${pid}/status`, "utf8");
    const name = text.match(/^Name:\s*(.+)$/m)?.[1]?.trim() ?? "";
    const ppid = Number.parseInt(text.match(/^PPid:\s*(\d+)/m)?.[1] ?? "", 10);
    if (!name || !Number.isFinite(ppid)) return null;
    return { name, ppid };
  } catch {
    return null;
  }
}

export function findKonsoleAncestorPid(startPid = process.ppid) {
  let pid = startPid;
  for (let i = 0; i < 24; i++) {
    if (!pid || pid <= 1) return null;
    const status = readProcStatus(pid);
    if (!status) return null;
    if (status.name === "konsole") return pid;
    pid = status.ppid;
  }
  return null;
}

export function resolveKonsoleDbusTarget(
  env: NodeJS.ProcessEnv = process.env,
): KonsoleDbusTarget | null {
  const service = env.KONSOLE_DBUS_SERVICE;
  const window = env.KONSOLE_DBUS_WINDOW;
  if (service && window) {
    return { service, windowPath: `/Windows/${window}` };
  }

  const pid = findKonsoleAncestorPid();
  if (pid === null) return null;
  return { service: `org.kde.konsole-${pid}`, windowPath: "/Windows/1" };
}

function qdbusCall(qdbus: string, args: string[]) {
  return execFileSync(qdbus, args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function parseSessionList(raw: string) {
  return raw
    .split(/\s+/)
    .map((id) => Number.parseInt(id, 10))
    .filter((id) => Number.isFinite(id) && id > 0);
}

export function tryAttachKonsoleTabs(
  tabs: LinuxTab[],
  workdir: string,
  layoutFile: string,
  writeFile: (path: string, contents: string) => void,
  options?: { restoreFocus?: boolean; env?: NodeJS.ProcessEnv },
) {
  const target = resolveKonsoleDbusTarget(options?.env);
  if (!target) return false;

  const qdbus = findQdbus();
  if (!qdbus) return false;

  let original = "";
  let known: number[];
  try {
    original = qdbusCall(qdbus, [target.service, target.windowPath, "org.kde.konsole.Window.currentSession"]);
    known = parseSessionList(
      qdbusCall(qdbus, [target.service, target.windowPath, "org.kde.konsole.Window.sessionList"]),
    );
  } catch {
    return false;
  }

  const knownSet = new Set(known);
  let created = 0;

  for (const tab of tabs) {
    writeFile(layoutFile, buildKonsoleLayoutFile(konsoleExecCommand(tab.tempFile), workdir));
    try {
      qdbusCall(qdbus, [target.service, target.windowPath, "org.kde.konsole.Window.loadLayout", layoutFile]);
    } catch {
      break;
    }

    const deadline = Date.now() + 1500;
    let added: number[] = [];
    while (Date.now() < deadline) {
      try {
        const now = parseSessionList(
          qdbusCall(qdbus, [target.service, target.windowPath, "org.kde.konsole.Window.sessionList"]),
        );
        added = now.filter((id) => !knownSet.has(id));
        if (added.length > 0) break;
      } catch {
        // Session list may briefly disappear while the tab is inserted.
      }
      Bun.sleepSync(40);
    }

    if (added.length === 0) break;
    for (const id of added) {
      knownSet.add(id);
      try {
        qdbusCall(qdbus, [target.service, `/Sessions/${id}`, "org.kde.konsole.Session.setTabTitleFormat", "0", tab.title]);
        qdbusCall(qdbus, [target.service, `/Sessions/${id}`, "org.kde.konsole.Session.setTitle", "0", tab.title]);
      } catch {
        // Title is cosmetic; the tab still launched.
      }
    }
    created += 1;
  }

  if (created === 0) return false;

  if (options?.restoreFocus !== false && original) {
    try {
      qdbusCall(qdbus, [target.service, target.windowPath, "org.kde.konsole.Window.setCurrentSession", original]);
    } catch {
      // Tabs were created even if we cannot hop back to the dashboard.
    }
  }

  return created === tabs.length;
}
