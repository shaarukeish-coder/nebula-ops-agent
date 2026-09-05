import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

process.env.DB_PATH = "./data/test-idempotency.db";
fs.rmSync(process.env.DB_PATH, { force: true });

const { claimOnce } = await import("../src/telegram/idempotency.js");

test("claimOnce accepts a key exactly once", () => {
  assert.equal(claimOnce("chat1:100"), true);
  assert.equal(claimOnce("chat1:100"), false);
  assert.equal(claimOnce("chat1:101"), true);
});
