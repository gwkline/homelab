// CLI: mint a short-lived GitHub App installation token (#70).
//
// Reads the App credentials from the environment (sourced from the
// factory-github-app 1Password item — never pasted into files in this
// repo) and writes the token to `--out FILE` (mode 0600) or, explicitly
// requested, `--stdout`. The token is never printed by default and never
// logged: only its expiry is reported.
//
//   GITHUB_APP_ID=123456 \
//   GITHUB_APP_INSTALLATION_ID=7890 \
//   GITHUB_APP_PRIVATE_KEY_FILE=./app.pem \
//   node mint.ts --permissions contents:read,issues:read --out /tmp/gh-token
//
// Environment:
//   GITHUB_APP_ID                 numeric App ID (required)
//   GITHUB_APP_INSTALLATION_ID    numeric installation ID (required)
//   GITHUB_APP_PRIVATE_KEY_FILE   path to the PEM private key (preferred)
//   GITHUB_APP_PRIVATE_KEY        PEM inline, `\n` escapes allowed
//   GITHUB_API_BASE               override for tests / GHES
// Exit codes: 0 minted · 78 configuration/usage · 1 exchange failure
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { createTokenService } from "./token-service.ts";
import type { PermissionRequest } from "./token-service.ts";

const CONFIG_EXIT = 78;

export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
    this.name = "CliError";
  }
}

/** Normalizes a PEM private key (inline values may carry `\n` escapes). */
export const normalizePrivateKeyPem = (value: string): string =>
  value.includes("\n") ? value : value.replaceAll("\\n", "\n");

/** Parses `--permissions contents:read,issues:read` into a request object. */
export const parsePermissionSpec = (spec: string): PermissionRequest => {
  const request: PermissionRequest = {};
  for (const part of spec
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)) {
    const [name, level] = part.split(":").map((p) => p.trim());
    if (!name || (level !== "read" && level !== "write")) {
      throw new CliError(
        `invalid --permissions entry '${part}' (expected name:read|name:write)`,
        CONFIG_EXIT
      );
    }
    if (name in request) {
      throw new CliError(
        `duplicate --permissions entry '${name}' (GitHub grants one level per permission)`,
        CONFIG_EXIT
      );
    }
    request[name] = level;
  }
  if (Object.keys(request).length === 0) {
    throw new CliError("empty --permissions value", CONFIG_EXIT);
  }
  return request;
};

interface CliArgs {
  outFile?: string;
  stdout: boolean;
  permissions?: PermissionRequest;
}

const parseArgs = (argv: readonly string[]): CliArgs => {
  const args: CliArgs = { stdout: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      const value = argv[i + 1];
      if (!value) {
        throw new CliError("--out requires a file path", CONFIG_EXIT);
      }
      args.outFile = value;
      i += 1;
    } else if (arg === "--stdout") {
      args.stdout = true;
    } else if (arg === "--permissions") {
      const value = argv[i + 1];
      if (!value) {
        throw new CliError(
          "--permissions requires name:read[,name:write...]",
          CONFIG_EXIT
        );
      }
      args.permissions = parsePermissionSpec(value);
      i += 1;
    } else {
      throw new CliError(`unknown argument '${arg}'`, CONFIG_EXIT);
    }
  }
  if (!args.outFile && !args.stdout) {
    throw new CliError(
      "refusing to print the token by default: pass --out FILE (mode 0600) or --stdout",
      CONFIG_EXIT
    );
  }
  return args;
};

const readPrivateKey = (): string => {
  const file = process.env.GITHUB_APP_PRIVATE_KEY_FILE;
  if (file) {
    return readFileSync(file, "utf-8").trim();
  }
  const inline = process.env.GITHUB_APP_PRIVATE_KEY;
  if (inline) {
    return normalizePrivateKeyPem(inline.trim());
  }
  throw new CliError(
    "no private key: set GITHUB_APP_PRIVATE_KEY_FILE (preferred) or GITHUB_APP_PRIVATE_KEY",
    CONFIG_EXIT
  );
};

const mint = async (args: CliArgs): Promise<void> => {
  const appId = process.env.GITHUB_APP_ID ?? "";
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID ?? "";
  if (!appId || !installationId) {
    throw new CliError(
      "GITHUB_APP_ID and GITHUB_APP_INSTALLATION_ID are required",
      CONFIG_EXIT
    );
  }
  const options: Parameters<typeof createTokenService>[1] = {};
  const apiBase = process.env.GITHUB_API_BASE;
  if (apiBase) {
    options.apiBase = apiBase;
  }
  const service = createTokenService(
    {
      appId,
      installationId,
      privateKey: readPrivateKey(),
    },
    options
  );
  const minted = await service.getToken(args.permissions);
  if (args.outFile) {
    writeFileSync(args.outFile, minted.token, { mode: 0o600 });
    chmodSync(args.outFile, 0o600);
    console.log(`expires_at=${minted.expiresAt.toISOString()}`);
    console.log(`written=${args.outFile}`);
  } else {
    console.log(minted.token);
  }
};

const main = async (): Promise<void> => {
  try {
    await mint(parseArgs(process.argv.slice(2)));
  } catch (error) {
    if (error instanceof CliError) {
      console.error(`[mint] ${error.message}`);
      process.exitCode = error.exitCode;
      return;
    }
    console.error(
      "[mint] token exchange failed (HTTP/network error; no details logged)"
    );
    process.exitCode = 1;
  }
};

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main();
}
