import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { configFromEnv } from "../../server/retrieval/config.ts";

const ADMIN = "retrieval-admin-token-1234567890";

test("the search token is optional until its secret is provisioned", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "retrieval-config-"));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const file = path.join(dir, "token");

  const absent = configFromEnv({
    KNOWLEDGE_RETRIEVAL_SEARCH_TOKEN_FILE: file,
    KNOWLEDGE_RETRIEVAL_TOKEN: ADMIN,
  });
  assert.equal(
    absent.searchToken,
    null,
    "a missing file leaves search admin-only"
  );

  await writeFile(file, "retrieval-search-token-0987654321\n");
  const provisioned = configFromEnv({
    KNOWLEDGE_RETRIEVAL_SEARCH_TOKEN_FILE: file,
    KNOWLEDGE_RETRIEVAL_TOKEN: ADMIN,
  });
  assert.equal(provisioned.searchToken, "retrieval-search-token-0987654321");

  await writeFile(file, `${ADMIN}\n`);
  assert.throws(
    () =>
      configFromEnv({
        KNOWLEDGE_RETRIEVAL_SEARCH_TOKEN_FILE: file,
        KNOWLEDGE_RETRIEVAL_TOKEN: ADMIN,
      }),
    /must differ from the admin token/u
  );
});
