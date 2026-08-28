/**
 * How to launch a service script in a Linux terminal emulator.
 *
 * Konsole documents that `-e` "breaks functionality, e.g. --new-tab".
 * 1dx used `konsole --new-tab -e bash script`, which leaves orphan Konsole
 * processes that may never attach a tab — so `supabase start` looks like it
 * never ran. Never combine `--new-tab` with `-e`.
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

export function shouldRunCloseOnFinishInline(isWin: boolean, closeOnFinish: boolean): boolean {
  return !isWin && closeOnFinish;
}
