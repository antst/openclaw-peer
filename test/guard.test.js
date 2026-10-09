import assert from "node:assert/strict";
import test from "node:test";
import { PairGuard } from "../src/guard.js";

function clockAt(startMs) {
  let now = startMs;
  return { get: () => now, advance: (ms) => { now += ms; } };
}

test("20 admitted, 21st refused, refused through cooldown, admitted after", () => {
  const clock = clockAt(0);
  const guard = new PairGuard({ maxEventsPerWindow: 20, windowSeconds: 60, cooldownSeconds: 60, now: clock.get });
  for (let i = 0; i < 20; i++) {
    assert.equal(guard.admit("openclaw-advisor", "other@host"), true, `event ${i} should be admitted`);
  }
  assert.equal(guard.admit("openclaw-advisor", "other@host"), false, "21st event should be refused");

  clock.advance(30_000);
  assert.equal(guard.admit("openclaw-advisor", "other@host"), false, "still within cooldown");

  clock.advance(31_000); // total 61s, past the 60s cooldown
  assert.equal(guard.admit("openclaw-advisor", "other@host"), true, "admitted again after cooldown");
});

test("both directions share one budget", () => {
  const clock = clockAt(0);
  const guard = new PairGuard({ maxEventsPerWindow: 2, windowSeconds: 60, cooldownSeconds: 60, now: clock.get });
  assert.equal(guard.admit("openclaw-advisor", "other@host"), true);
  assert.equal(guard.record("openclaw-advisor", "other@host"), true);
  assert.equal(guard.admit("openclaw-advisor", "other@host"), false);
});

test("blocked does not count as an event", () => {
  const clock = clockAt(0);
  const guard = new PairGuard({ maxEventsPerWindow: 1, windowSeconds: 60, cooldownSeconds: 60, now: clock.get });
  assert.equal(guard.record("openclaw-advisor", "other@host"), true);
  assert.equal(guard.record("openclaw-advisor", "other@host"), false); // 2nd exceeds budget of 1, starts cooldown
  assert.equal(guard.blocked("openclaw-advisor", "other@host"), true);
  assert.equal(guard.blocked("openclaw-advisor", "other@host"), true);
  clock.advance(61_000);
  assert.equal(guard.blocked("openclaw-advisor", "other@host"), false);
  assert.equal(guard.record("openclaw-advisor", "other@host"), true);
});

test("fromConfig reads channels.defaults.botLoopProtection", () => {
  const guard = PairGuard.fromConfig({ channels: { defaults: { botLoopProtection: { maxEventsPerWindow: 3, windowSeconds: 10, cooldownSeconds: 5 } } } });
  assert.equal(guard.maxEventsPerWindow, 3);
  assert.equal(guard.windowMs, 10_000);
  assert.equal(guard.cooldownMs, 5_000);
  assert.equal(guard.enabled, true);
});

test("fromConfig honors enabled:false: always admits", () => {
  const guard = PairGuard.fromConfig({ channels: { defaults: { botLoopProtection: { enabled: false, maxEventsPerWindow: 1 } } } });
  assert.equal(guard.admit("openclaw-advisor", "other@host"), true);
  assert.equal(guard.admit("openclaw-advisor", "other@host"), true);
  assert.equal(guard.admit("openclaw-advisor", "other@host"), true);
  assert.equal(guard.blocked("openclaw-advisor", "other@host"), false);
});
