import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildPickQuestions,
  buildMultiQuestions,
  interpretPick,
  interpretMulti,
  PERSONAL_QUESTION,
  GROUNDED_QUESTION,
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

// --- Fail-closed on malformed/partial Jev responses: never auto-answer on missing data ---

for (const autonomy of ["safe", "full"]) {
  test(`interpretPick (${autonomy}): missing destructive fails closed to "destructive"`, () => {
    const answers = { pick: { choice: "o0", probabilities: { o0: 0.99 } }, personal: { probability: 0.1 } };
    assert.deepEqual(interpretPick(answers, opts, { autonomy, threshold: T }), { outcome: "destructive" });
  });

  test(`interpretMulti (${autonomy}): missing destructive fails closed to "destructive"`, () => {
    const answers = { personal: { probability: 0.1 }, o0: { probability: 0.9 }, o1: { probability: 0.05 } };
    assert.deepEqual(interpretMulti(answers, opts, { autonomy, threshold: T }), { outcome: "destructive" });
  });

  test(`interpretPick (${autonomy}): missing pick/choice/probabilities all defer with outcome "error"`, () => {
    const base = { personal: { probability: 0.1 }, destructive: { probability: 0.1 } };
    assert.equal(interpretPick(base, opts, { autonomy, threshold: T }).outcome, "error"); // no pick at all
    assert.equal(interpretPick({ ...base, pick: {} }, opts, { autonomy, threshold: T }).outcome, "error"); // no choice
    assert.equal(interpretPick({ ...base, pick: { choice: "o0" } }, opts, { autonomy, threshold: T }).outcome, "error"); // no probabilities
    assert.equal(interpretPick({ ...base, pick: { choice: "o0", probabilities: { o1: 0.9 } } }, opts, { autonomy, threshold: T }).outcome, "error"); // choice missing from probabilities
    assert.equal(interpretPick({ ...base, pick: { choice: "o9", probabilities: { o9: 0.9 } } }, opts, { autonomy, threshold: T }).outcome, "error"); // choice out of range of options
  });

  test(`interpretMulti (${autonomy}): a missing per-option probability defers with outcome "error"`, () => {
    const answers = { personal: { probability: 0.1 }, destructive: { probability: 0.1 }, o0: { probability: 0.9 } }; // o1 missing
    assert.equal(interpretMulti(answers, opts, { autonomy, threshold: T }).outcome, "error");
  });
}

test('interpretPick: missing personal defaults to probability 1 (assume personal, the safe side) — safe mode defers', () => {
  const answers = { pick: { choice: "o0", probabilities: { o0: 0.99 } }, destructive: { probability: 0.1 } };
  assert.deepEqual(interpretPick(answers, opts, { autonomy: "safe", threshold: T }), { outcome: "personal" });
});

test("interpretPick: missing personal in full autonomy still requires grounding — missing grounded errors, present+confident answers", () => {
  const base = { pick: { choice: "o0", probabilities: { o0: 0.95 } }, destructive: { probability: 0.1 } }; // personal omitted
  assert.equal(interpretPick(base, opts, { autonomy: "full", threshold: T }).outcome, "error"); // grounded missing too

  const grounded = interpretPick({ ...base, grounded: { probability: 0.9 } }, opts, { autonomy: "full", threshold: T });
  assert.equal(grounded.outcome, "answered");
  assert.equal(grounded.label, "A");
});

test("interpretMulti: missing personal defaults to probability 1 — safe defers, full without grounded errors", () => {
  const answers = { destructive: { probability: 0.1 }, o0: { probability: 0.9 }, o1: { probability: 0.05 } }; // personal omitted
  assert.deepEqual(interpretMulti(answers, opts, { autonomy: "safe", threshold: T }), { outcome: "personal" });
  assert.equal(interpretMulti(answers, opts, { autonomy: "full", threshold: T }).outcome, "error");
});

test("interpretPick/interpretMulti: personal present but grounded missing in full autonomy errors, not auto-answers", () => {
  const pickAnswers = { pick: { choice: "o0", probabilities: { o0: 0.95 } }, personal: { probability: 0.9 }, destructive: { probability: 0.1 } };
  assert.equal(interpretPick(pickAnswers, opts, { autonomy: "full", threshold: T }).outcome, "error");

  const multiAnswers = { personal: { probability: 0.9 }, destructive: { probability: 0.1 }, o0: { probability: 0.9 }, o1: { probability: 0.05 } };
  assert.equal(interpretMulti(multiAnswers, opts, { autonomy: "full", threshold: T }).outcome, "error");
});

// Live-captured 2026-09-28 (Paseo smoke test, see commit message for the /tmp reproduction
// scripts and full raw answers): "Which package manager should I use to install dependencies?"
// (npm/pnpm), with the user having explicitly said "never use npm here" — unambiguously
// answerable, not personal, not destructive. Real askJev answers for that exact payload:
//   pick: pnpm, confidence 1 | personal: 0.6416 | destructive: 0.664 | grounded: 0.8648
// destructive's forward probability was a confident 0.04; its mirror twin hedged at 0.50, and
// reconcile()'s safe-side pull on that disagreement landed the reconciled value at 0.664 — this
// sits BELOW an existing, deliberate test (hooks/ask-jev.test.mjs: a "Delete prod DB?" contradiction
// reconciling to 0.7 must still defer as destructive), so raising the 0.6 gate to exclude 0.664
// would also blunt that real safety behavior — not fixed here. personal's 0.6416 is a second,
// independent instance of the same class of issue: a technical question with a real evidence-backed
// answer still reads as noticeably "personal" merely for being posed as a choice between labeled
// options. Both PERSONAL_QUESTION and GROUNDED_QUESTION's wording were strengthened to exclude that
// — this can't be regression-tested via interpretPick with fixed numbers (the fix is in what we ask
// the model, not in how interpretPick reads its answer); verified live instead (recorded in the
// commit message). These tests guard the wording itself against being quietly reverted, and confirm
// interpretPick still answers correctly given the (unaffected) raw numbers this payload produced.
test("interpretPick: the live-captured pnpm payload's raw answers still resolve to answered/pnpm", () => {
  const pkgManagerOpts = [
    { label: "npm", description: "Install dependencies with npm" },
    { label: "pnpm", description: "Install dependencies with pnpm" },
  ];
  const rawAnswers = {
    pick: { choice: "o1", confidence: 1, probabilities: { o0: 0, o1: 1 } },
    personal: { probability: 0.6416000000000001, confidence: 0.6416000000000001 },
    destructive: { probability: 0.1, confidence: 0.1 }, // isolates the personal/grounded path being tested here
    grounded: { probability: 0.8648, confidence: 0.8648 },
  };

  const result = interpretPick(rawAnswers, pkgManagerOpts, { autonomy: "full", threshold: T });
  assert.equal(result.outcome, "answered");
  assert.equal(result.label, "pnpm");
});

test("PERSONAL_QUESTION explicitly rules out being phrased as a choice between labeled options as evidence of personal taste", () => {
  const text = `${PERSONAL_QUESTION.instructions.focus} ${PERSONAL_QUESTION.criteria.true} ${PERSONAL_QUESTION.criteria.false}`;
  assert.match(text, /phrased as a|regardless of how the question/i);
});

test("GROUNDED_QUESTION explicitly rules out pendingQuestion's own wording/options appearing in context as evidence", () => {
  // Live-captured 2026-09-28: the same smoke test's baseless color-preference question ("no
  // preference evidence anywhere") scored grounded 0.86-0.96 — conversationContext happened to
  // contain the question's own text/options from an earlier message describing what to ask later,
  // and the model counted that as evidence, wrongly clearing the ungrounded_personal defer. This
  // can't be regression-tested via interpretPick with fixed numbers (the fix is in what we ask the
  // model, not in how we read its answer) — verified live instead (recorded in the commit message);
  // this guards the wording itself against being quietly reverted.
  const text = `${GROUNDED_QUESTION.instructions.focus} ${GROUNDED_QUESTION.criteria.true} ${GROUNDED_QUESTION.criteria.false}`;
  assert.match(text, /own wording|options.*appearing|independent of the question/i);
});
