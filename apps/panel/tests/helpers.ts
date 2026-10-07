import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
