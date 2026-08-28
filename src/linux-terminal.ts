/**
 * How to launch service scripts in a Linux terminal emulator.
 *
 * Konsole `--new-tab` only attaches to an existing window when
 * "Run all Konsole windows in a single process" is on (off by default).
 * Combining `--new-tab` with `-e` is also documented as broken.
 * DBus `runCommand` / `sendText` are AccessDenied unless the user enables
 * "security sensitive DBus API".
 *
 * So we never spawn one Konsole per service. Tab-capable emulators get a
 * single process: Konsole via `--tabs-from-file`, GNOME/XFCE/MATE via
 * repeated `--tab`. Konsole always also opens a default session; `-e true`
 * makes that extra tab exit immediately.
 */

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
