import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildPickQuestions,
  buildMultiQuestions,
  interpretPick,
  interpretMulti,
} from "../lib/answer-policy.mjs";

const opts = [{ label: "A", description: "a" }, { label: "B", description: "b" }];
const T = 0.8;

test("lib/answer-policy.mjs is a pure module: no process., fetch, or logEvent references", () => {
  const src = readFileSync("lib/answer-policy.mjs", "utf8");
  assert.doesNotMatch(src, /process\./);
  assert.doesNotMatch(src, /\bfetch\(/);
  assert.doesNotMatch(src, /\blogEvent\b/);
});

test("buildPickQuestions/buildMultiQuestions: grounded question only added in full autonomy", () => {
  assert.ok(!("grounded" in buildPickQuestions(opts, { autonomy: "safe" })));
  assert.ok("grounded" in buildPickQuestions(opts, { autonomy: "full" }));
  assert.ok(!("grounded" in buildMultiQuestions("Q?", opts, { autonomy: "safe" })));
  assert.ok("grounded" in buildMultiQuestions("Q?", opts, { autonomy: "full" }));
});

test("interpretPick: destructive always defers, regardless of autonomy or confidence", () => {
  const answers = { pick: { choice: "o0", probabilities: { o0: 0.99 } }, personal: { probability: 0.1 }, destructive: { probability: 0.7 } };
  for (const autonomy of ["safe", "full"]) {
    assert.deepEqual(interpretPick(answers, opts, { autonomy, threshold: T }), { outcome: "destructive" });
  }
});

test("interpretPick: safe mode defers any personal question, even with high confidence", () => {
  const answers = { pick: { choice: "o0", probabilities: { o0: 0.99 } }, personal: { probability: 0.9 }, destructive: { probability: 0.1 } };
  assert.deepEqual(interpretPick(answers, opts, { autonomy: "safe", threshold: T }), { outcome: "personal" });
});

test("interpretPick: full mode, personal + grounded + confident → answered", () => {
  const answers = {
    pick: { choice: "o0", probabilities: { o0: 0.95 } },
    personal: { probability: 0.9 },
    destructive: { probability: 0.1 },
    grounded: { probability: 0.9 },
  };
  const result = interpretPick(answers, opts, { autonomy: "full", threshold: T });
  assert.equal(result.outcome, "answered");
  assert.equal(result.label, "A");
  assert.equal(result.confidence, 0.95);
});

test("interpretPick: full mode, personal but ungrounded (generic prior, no real evidence) → defers", () => {
  const answers = {
    pick: { choice: "o0", probabilities: { o0: 0.95 } },
    personal: { probability: 0.9 },
    destructive: { probability: 0.1 },
    grounded: { probability: 0.2 },
  };
  const result = interpretPick(answers, opts, { autonomy: "full", threshold: T });
  assert.equal(result.outcome, "ungrounded_personal");
});

test("interpretPick: full mode, personal + grounded but low pick confidence → still defers", () => {
  const answers = {
    pick: { choice: "o0", probabilities: { o0: 0.5 } },
    personal: { probability: 0.9 },
    destructive: { probability: 0.1 },
    grounded: { probability: 0.95 },
  };
  const result = interpretPick(answers, opts, { autonomy: "full", threshold: T });
  assert.equal(result.outcome, "ungrounded_personal");
});

test("interpretPick: non-personal question below threshold → low_confidence, at/above threshold → answered", () => {
  const low = { pick: { choice: "o0", probabilities: { o0: 0.5 } }, personal: { probability: 0.1 }, destructive: { probability: 0.1 } };
  assert.equal(interpretPick(low, opts, { autonomy: "full", threshold: T }).outcome, "low_confidence");

  const high = { pick: { choice: "o1", probabilities: { o1: 0.9 } }, personal: { probability: 0.1 }, destructive: { probability: 0.1 } };
  const result = interpretPick(high, opts, { autonomy: "full", threshold: T });
  assert.equal(result.outcome, "answered");
  assert.equal(result.label, "B");
});

test("interpretMulti: destructive always defers", () => {
  const answers = { personal: { probability: 0.1 }, destructive: { probability: 0.7 }, o0: { probability: 0.9 }, o1: { probability: 0.05 } };
  assert.deepEqual(interpretMulti(answers, opts, { autonomy: "full", threshold: T }), { outcome: "destructive" });
});

test("interpretMulti: safe mode defers personal", () => {
  const answers = { personal: { probability: 0.9 }, destructive: { probability: 0.1 }, o0: { probability: 0.9 }, o1: { probability: 0.05 } };
  assert.deepEqual(interpretMulti(answers, opts, { autonomy: "safe", threshold: T }), { outcome: "personal" });
});

test("interpretMulti: full mode, personal + grounded → answered; ungrounded → defers", () => {
  const base = { personal: { probability: 0.9 }, destructive: { probability: 0.1 }, o0: { probability: 0.9 }, o1: { probability: 0.05 } };

  const grounded = interpretMulti({ ...base, grounded: { probability: 0.9 } }, opts, { autonomy: "full", threshold: T });
  assert.equal(grounded.outcome, "answered");
  assert.equal(grounded.label, "A");

  const ungrounded = interpretMulti({ ...base, grounded: { probability: 0.2 } }, opts, { autonomy: "full", threshold: T });
  assert.equal(ungrounded.outcome, "ungrounded_personal");
});

test("interpretMulti: a mid-band option leaves the whole question unresolved", () => {
  const answers = { personal: { probability: 0.1 }, destructive: { probability: 0.1 }, o0: { probability: 0.9 }, o1: { probability: 0.5 } };
  assert.equal(interpretMulti(answers, opts, { autonomy: "full", threshold: T }).outcome, "low_confidence");
});
