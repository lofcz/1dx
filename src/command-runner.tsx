import React, { useEffect, useEffectEvent, useMemo, useState } from "react";
import { Box, Text, useAnimation } from "ink";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

const MAX_OUTPUT_CHARS = 1024 * 1024;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function commandOutputLines(output: string) {
  const lines = stripVTControlCharacters(output).replace(/\r\n/g, "\n")
    .split("\n").map((line) => line.split("\r").at(-1)!);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function terminateCommand(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
    return;
  }
  // The shell owns a separate process group, including the command it launched.
  try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill(); }
}

export function CommandRunner({ command, args, label, cwd, onDone, maxLines = 15 }: {
  command: string;
  args: string[];
  label: string;
  cwd: string;
  onDone: (success: boolean, output: string) => void;
  maxLines?: number;
}) {
  const [output, setOutput] = useState("");
  const [status, setStatus] = useState<"running" | "succeeded" | "failed">("running");
  const { frame } = useAnimation({ interval: 80, isActive: status === "running" });
  const complete = useEffectEvent(onDone);
  const argsKey = JSON.stringify(args);

  useEffect(() => {
    let captured = "";
    let settled = false;
    setOutput("");
    setStatus("running");
    const append = (data: string) => {
      captured = (captured + data).slice(-MAX_OUTPUT_CHARS);
      setOutput(captured);
    };
    const finish = (success: boolean) => {
      if (settled) return;
      settled = true;
      setStatus(success ? "succeeded" : "failed");
      complete(success, commandOutputLines(captured).join("\n"));
    };
    const child = spawn(command, JSON.parse(argsKey), {
      cwd,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    // Decode across chunks so split UTF-8 characters and lines stay intact.
    child.stdout?.setEncoding("utf8").on("data", append);
    child.stderr?.setEncoding("utf8").on("data", append);
    child.once("close", (code) => finish(code === 0));
    child.once("error", (error) => {
      append(`\n${error.message}\n`);
      finish(false);
    });
    return () => {
      settled = true;
      child.stdout?.off("data", append);
      child.stderr?.off("data", append);
      terminateCommand(child);
    };
  }, [command, argsKey, cwd]);

  const lines = useMemo(() => commandOutputLines(output).slice(-Math.max(1, maxLines)), [output, maxLines]);
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text color={status === "running" ? undefined : status === "succeeded" ? "green" : "red"}>
        {status === "running" ? SPINNER_FRAMES[frame % SPINNER_FRAMES.length] : status === "succeeded" ? "✓" : "✗"} {label}
      </Text>
      <Text dimColor>  $ {command} {args.join(" ")}</Text>
      {lines.length > 0 && (
        <Box flexDirection="column" marginLeft={2} marginTop={1}>
          {lines.map((line, index) => <Text key={index} dimColor>{line || " "}</Text>)}
        </Box>
      )}
    </Box>
  );
}
