import { Writable, PassThrough } from "node:stream";
import { render } from "ink";
import type { ReactNode } from "react";

export async function waitFor(check: () => boolean, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for terminal state");
    await Bun.sleep(10);
  }
}

export function testTerminal(node: ReactNode, rows = 24, columns = 80) {
  let frame = "";
  const stdout = Object.assign(new Writable({
    write(chunk, _encoding, done) { frame = chunk.toString(); done(); },
  }), { isTTY: true, columns, rows });
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(value: boolean) { this.isRaw = value; return this; },
  });
  const app = render(node, { stdout, stdin, stderr: stdout, interactive: true, debug: true, patchConsole: false });
  return {
    ...app,
    stdin,
    frame: () => frame,
    resize(rows: number, columns = stdout.columns) {
      stdout.rows = rows;
      stdout.columns = columns;
      stdout.emit("resize");
    },
    async close() {
      app.unmount();
      await app.waitUntilExit();
      stdin.destroy();
      stdout.destroy();
    },
  };
}
