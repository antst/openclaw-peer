import assert from "node:assert/strict";
import test from "node:test";
import { SERVICE_PREFIX, isServiceNotice } from "../src/report.js";

test("isServiceNotice recognizes only bodies starting with the literal service prefix", () => {
  assert.equal(isServiceNotice(`${SERVICE_PREFIX} old notice`), true);
  assert.equal(isServiceNotice(SERVICE_PREFIX), true);
  assert.equal(isServiceNotice("ordinary text"), false);
  assert.equal(isServiceNotice(`some text ${SERVICE_PREFIX} mid-body`), false);
  assert.equal(isServiceNotice(null), false);
});
