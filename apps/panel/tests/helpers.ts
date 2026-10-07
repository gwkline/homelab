import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { RequestListener, Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");

// Callers the fixture PANEL_AUTH_DIR knows, mirroring Secret panel-auth.
const TOKENS = {
  hermes: "hermes-token",
  t3code: "t3code-token",
  tester: "tester-token",
} as const;
export const ALLOWED_LOGIN = "operator@example.com";

export type Caller = keyof typeof TOKENS;

export const writeAuthDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "panel-auth-"));
  writeFileSync(
    path.join(dir, "tokens"),
    Object.entries(TOKENS)
      .map(([name, token]) => `${name}=${token}`)
      .join("\n")
  );
  writeFileSync(path.join(dir, "users"), `operator=${ALLOWED_LOGIN}\n`);
  return dir;
};

// Headers for a mutating request from a machine caller.
export const jsonAs = (caller: Caller = "tester"): Record<string, string> => ({
  authorization: `Bearer ${TOKENS[caller]}`,
  "content-type": "application/json",
});

const urlOf = (server: Server): string =>
  `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// A mock upstream on a free loopback port; resolves to its base URL.
export const listen = async (
  handler: RequestListener
): Promise<{ server: Server; url: string }> => {
  const server = createHttpServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, url: urlOf(server) };
};

export const freePort = async (): Promise<number> => {
  const probe = createNetServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  probe.close();
  await once(probe, "close");
  return port;
};

export interface Panel {
  base: string;
  child: ChildProcessWithoutNullStreams;
  // Parsed JSON log lines, in order.
  lines: Record<string, unknown>[];
  stop: () => void;
}

// Runs the built server (dist/index.js, so `npm test` builds first) from a
// scratch PANEL_ROOT holding the built SPA shell, and resolves once it
// listens. Upstreams default to a closed port; credentials to the fixture.
export const startPanel = async (
  env: Record<string, string> = {}
): Promise<Panel> => {
  const stage = mkdtempSync(path.join(tmpdir(), "panel-"));
  mkdirSync(path.join(stage, "web", "dist"), { recursive: true });
  copyFileSync(
    path.join(root, "dist", "index.js"),
    path.join(stage, "index.js")
  );
  copyFileSync(
    path.join(root, "web", "dist", "index.html"),
    path.join(stage, "web", "dist", "index.html")
  );
  const port = env.PORT ?? String(await freePort());
  const child = spawn(process.execPath, [path.join(stage, "index.js")], {
    env: {
      ...process.env,
      PANEL_AUTH_DIR: writeAuthDir(),
      PANEL_K8S_BASE: "http://127.0.0.1:1",
      PANEL_ROOT: stage,
      PORT: port,
      ...env,
    },
    stdio: "pipe",
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  const lines: Record<string, unknown>[] = [];
  let partial = "";
  const listening = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("panel did not start")),
      5000
    );
    child.on("exit", (code) => reject(new Error(`panel exited (${code})`)));
    child.stdout.on("data", (d: Buffer) => {
      const parts = (partial + d.toString()).split("\n");
      partial = parts.pop() ?? "";
      for (const part of parts) {
        const line = JSON.parse(part) as Record<string, unknown>;
        lines.push(line);
        if (String(line.msg).startsWith("listening")) {
          clearTimeout(timer);
          resolve();
        }
      }
    });
  });
  await listening;
  return {
    base: `http://127.0.0.1:${port}`,
    child,
    lines,
    stop: () => child.kill(),
  };
};
