import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStore } from "../src/store.js";

async function withEnvironment(values, run) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );

  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withTemporaryRoot(run) {
  const rootDir = await mkdtemp(join(tmpdir(), "insole-mes-postgres-required-"));
  try {
    await run(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("production cannot start without a configured PostgreSQL connection", async () => {
  await withTemporaryRoot(async (rootDir) => {
    await withEnvironment(
      { DATABASE_URL: undefined, REQUIRE_POSTGRES: undefined, NODE_ENV: "production" },
      async () => {
        await assert.rejects(
          () => createStore(rootDir),
          /PostgreSQL is required but DATABASE_URL is not configured/,
        );
      },
    );
  });
});

test("REQUIRE_POSTGRES prevents silent fallback outside production", async () => {
  await withTemporaryRoot(async (rootDir) => {
    await withEnvironment(
      { DATABASE_URL: undefined, REQUIRE_POSTGRES: "true", NODE_ENV: "development" },
      async () => {
        await assert.rejects(
          () => createStore(rootDir),
          /PostgreSQL is required but DATABASE_URL is not configured/,
        );
      },
    );
  });
});

test("local development still falls back to the file store by default", async () => {
  await withTemporaryRoot(async (rootDir) => {
    await withEnvironment(
      { DATABASE_URL: undefined, REQUIRE_POSTGRES: undefined, NODE_ENV: "development" },
      async () => {
        const store = await createStore(rootDir);
        assert.equal(store.kind, "file");
      },
    );
  });
});
