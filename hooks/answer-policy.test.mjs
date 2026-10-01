import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askJev } from "../lib/jev.mjs";
import {
  buildPickQuestions,
  buildMultiQuestions,
  PERSONAL_QUESTION,
  GROUNDED_QUESTION,
  buildAdviceQuestions,
  buildAdviceMultiQuestions,
  interpretAdvice,
  interpretMultiAdvice,
  adviceBlocker,
  adviseQuestions,
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

// ---- advisory policy: advice only, never answers or suppresses the question ----
const OUTCOMES_THAT_ANSWER_OR_SUPPRESS = ["answered", "destructive", "personal", "ungrounded_personal", "low_confidence", "error", "deferred"];
const pickAnswers = (extra = {}) => ({ pick: { choice: "o1", probabilities: { o0: 0.1, o1: 0.9 } }, grounded: { probability: 0.9 }, ...extra });

test("interpretAdvice: single pick returns pick/confidence/strength/grounded/reason (description + grounded tag)", () => {
  const r = interpretAdvice(pickAnswers(), opts, { threshold: T });
  assert.deepEqual({ ...r, reason: undefined }, { outcome: "advised", pick: "B", recommended: ["B"], confidence: 0.9, strength: "strong", grounded: 0.9, reason: undefined });
  assert.match(r.reason, /^b \[grounded/);
  const weak = interpretAdvice({ pick: { choice: "o0", probabilities: { o0: 0.55, o1: 0.45 } }, grounded: { probability: 0.2 } }, opts, { threshold: T });
  assert.equal(weak.strength, "weak");
  assert.equal(weak.grounded, 0.2);
  assert.match(weak.reason, /^a \[no direct statement/);
  const noGround = interpretAdvice({ pick: pickAnswers().pick }, opts, { threshold: T });
  assert.equal(noGround.grounded, null);
  assert.equal(noGround.reason, "b");
});

test("interpretAdvice: advice for destructive/personal inputs is still advice — destructive/personal scores are ignored, never defer", () => {
  const hostile = pickAnswers({ destructive: { probability: 0.99 }, personal: { probability: 0.99 }, grounded: { probability: 0.01 } });
  const single = interpretAdvice(hostile, opts, { threshold: T });
  assert.equal(single.outcome, "advised");
  const multi = interpretMultiAdvice({ ...hostile, o0: { probability: 0.9 }, o1: { probability: 0.1 } }, opts, { threshold: T });
  assert.equal(multi.outcome, "advised");
  for (const r of [single, multi, ...adviseQuestions([{ options: opts, answers: hostile }])]) assert.ok(!OUTCOMES_THAT_ANSWER_OR_SUPPRESS.includes(r.outcome), r.outcome);
});

test("interpretAdvice/interpretMultiAdvice: corrupt answers → advice_unavailable{parse_error}, never throws", () => {
  for (const bad of [undefined, {}, { pick: { choice: "o9", probabilities: { o9: 1 } } }, { pick: { choice: "o0" } }, { pick: { choice: 3 } }]) {
    assert.deepEqual(interpretAdvice(bad, opts, { threshold: T }), { outcome: "advice_unavailable", reason: "parse_error" });
  }
  assert.equal(interpretMultiAdvice({ o0: { probability: 0.9 } }, opts, { threshold: T }).reason, "parse_error");
});

test("interpretMultiAdvice: every option ≥ 0.5 recommended, mid-band option still yields advice (weak), none → empty recommendation", () => {
  const r = interpretMultiAdvice({ o0: { probability: 0.95 }, o1: { probability: 0.6 }, grounded: { probability: 0.9 } }, opts, { threshold: T });
  assert.deepEqual([r.outcome, r.recommended, r.strength], ["advised", ["A", "B"], "weak"]);
  assert.equal(r.confidence, 0.6);
  assert.match(r.reason, /^a; b \[grounded/);
  const none = interpretMultiAdvice({ o0: { probability: 0.05 }, o1: { probability: 0.1 } }, opts, { threshold: T });
  assert.deepEqual([none.recommended, none.strength, none.reason], [[], "strong", "no option applies"]);
});

test("advice reason is capped at 160 chars and keeps the grounded tag", () => {
  const long = [{ label: "A", description: "x".repeat(400) }, { label: "B", description: "b" }];
  const r = interpretAdvice({ pick: { choice: "o0", probabilities: { o0: 0.9 } }, grounded: { probability: 0.9 } }, long, { threshold: T });
  assert.ok(r.reason.length <= 160);
  assert.match(r.reason, /\[grounded in your messages\/past choices\]$/);
});

test("buildAdvice*Questions: pick/o_i + grounded only (no destructive/personal gating), regardless of autonomy", () => {
  assert.deepEqual(Object.keys(buildAdviceQuestions(opts)), ["pick", "grounded"]);
  assert.deepEqual(Object.keys(buildAdviceMultiQuestions("Q?", opts)), ["grounded", "o0", "o1"]);
});

test("adviceBlocker: single option / missing descriptions", () => {
  assert.equal(adviceBlocker([opts[0]]), "single_option");
  assert.equal(adviceBlocker([{ label: "A", description: "a" }, { label: "B" }]), "missing_definition");
  assert.equal(adviceBlocker(opts), null);
});

test("adviseQuestions: multi-question partial success — per-question advice vs advice_unavailable (real askJev against a stub failing the 2nd/3rd request)", async () => {
  let n = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const i = n++;
      if (i === 1) return (res.writeHead(402), res.end("payment required"));
      if (i === 2) return (res.writeHead(500), res.end("boom"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answers: { pick: { choice: "o1", probabilities: { o0: 0.1, o1: 0.9 } }, grounded: { noul: 0.8 } } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const saved = { ...process.env };
  Object.assign(process.env, { ASK_JEV_LOG_FILE: join(mkdtempSync(join(tmpdir(), "adv-")), "l"), ASK_JEV_API_URL: `http://127.0.0.1:${server.address().port}/`, ASK_JEV_PROVIDER: "typesafe" });
  try {
    const items = [];
    for (const [i, q] of [{ options: opts }, { options: opts }, { options: opts }, { options: [{ label: "A", description: "a" }, { label: "B" }] }].entries()) {
      if (adviceBlocker(q.options)) {
        items.push({ ...q, answers: null });
        continue;
      }
      const item = { ...q, answers: null };
      try {
        item.answers = await askJev("k-12345678", {}, buildAdviceQuestions(q.options), "hook", 1500, undefined, { question_index: i });
      } catch (e) {
        item.errorClass = e.errorClass;
      }
      items.push(item);
    }
    const out = adviseQuestions(items, { threshold: T });
    assert.deepEqual(out.map((r) => r.outcome === "advised" ? `advised:${r.pick}` : `${r.outcome}:${r.reason}`), ["advised:B", "advice_unavailable:billing", "advice_unavailable:server", "advice_unavailable:missing_definition"]);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    server.close();
  }
});
