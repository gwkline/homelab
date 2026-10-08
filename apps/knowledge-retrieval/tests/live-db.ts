import { randomUUID } from "node:crypto";

export const hasLiveDb = Boolean(process.env["DATABASE_URL"]);

/** Runs `fn` against a new, empty database that is dropped afterwards. */
export const withFreshDatabase = async (
  fn: (url: string) => Promise<void>
): Promise<void> => {
  const { default: pg } = await import("pg");
  const admin = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });
  const name = `knowledge_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  try {
    const url = new URL(process.env["DATABASE_URL"] ?? "");
    url.pathname = `/${name}`;
    await fn(url.toString());
  } finally {
    await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
    await admin.end();
  }
};
