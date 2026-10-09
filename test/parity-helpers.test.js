import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { createParity } from "./parity/helpers.js";

test("createParity restores state after setup throws", async () => {
  const previous = process.env.OPENCLAW_STATE_DIR;
  let stateDir;
  const failure = new Error("forced daemon setup failure");

  await assert.rejects(
    createParity({
      scripted: {
        methods: {
          get forceFailure() {
            stateDir = process.env.OPENCLAW_STATE_DIR;
            throw failure;
          },
        },
      },
    }),
    (error) => error === failure,
  );

  assert.ok(stateDir, "setup reached the isolated state directory");
  assert.equal(process.env.OPENCLAW_STATE_DIR, previous);
  assert.equal(existsSync(stateDir), false);
});
