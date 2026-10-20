import { beforeAll } from "vitest";
import { env } from "cloudflare:test";
// Vite's `?raw` import is resolved at bundle time (in Node), so the SQL text is
// embedded as a string constant in the worker bundle — the Workers runtime itself
// never touches the filesystem, which it can't do anyway (no fs module).
import migrationSql from "../migrations/0001_init.sql?raw";

beforeAll(async () => {
  const sql = migrationSql;
  const statements = sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of statements) {
    await (env as any).DB.prepare(stmt).run();
  }
});
