import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceFindings, applyStrictness } from "../lib/cli-validate.mjs";
import { cleanEnv } from "./testenv.mjs";

const bool = (question) => ({ type: "boolean", instructions: { question }, criteria: { true: "yes, per the definition", false: "no, per the definition" } });
const choice = (question, labels) => ({ type: "choice", instructions: { question }, criteria: Object.fromEntries(labels.map((l) => [l, { what: `the ${l} option`, not_for: "the others", examples: [l] }])) });
const req = (stateJson, questions) => ({ state: JSON.parse(stateJson), questions });
const classes = (input) => evidenceFindings(input).map((f) => `${f.class}:${f.severity}`);
const has = (input, cls, severity) => classes(input).includes(`${cls}:${severity}`);
const lacks = (input, cls) => !evidenceFindings(input).some((f) => f.class === cls);

const TASTE_Q = { q: choice("Which tone would the user like for the release note?", ["blunt", "warm"]) };

test("agent_user_description: description keys and free text reject; user words and diffs pass", () => {
  assert.ok(has(req('{"user_style":"prefers terse"}', { q: bool("Is `ticket` urgent?") }), "agent_user_description", "reject"));
  assert.ok(has(req('{"notes":"the user probably likes dark mode"}', { q: bool("Is `ticket` urgent?") }), "agent_user_description", "reject"));
  assert.ok(lacks(req('{"user_messages":["I prefer terse"]}', { q: bool("Is `ticket` urgent?") }), "agent_user_description"));
  assert.ok(lacks(req('{"diff":"- the user likes dark mode\\n+ the user wants light mode"}', { q: bool("Is `diff` a UI change?") }), "agent_user_description"));
  assert.ok(lacks(req('{"ticket":"Customers say they want a refund and he likes the old plan"}', { q: bool("Is `ticket` a refund request?") }), "agent_user_description"));
  assert.ok(has(req('{"user_messages":["The user prefers blunt answers"]}', { q: bool("Is `x` ok?") }), "agent_user_description", "flag"));
});

test("taste_without_user_words: taste question without user words rejects; with them passes", () => {
  assert.ok(has(req('{"ticket":"Release 1.2 notes draft"}', TASTE_Q), "taste_without_user_words", "reject"));
  assert.ok(has(req('{"user_messages":["short"]}', TASTE_Q), "taste_without_user_words", "reject"));
  assert.ok(lacks(req('{"user_messages":["Keep it short and blunt."]}', TASTE_Q), "taste_without_user_words"));
  assert.ok(lacks(req('{"past_choices":["chose the blunt wording last time"]}', TASTE_Q), "taste_without_user_words"));
  assert.ok(lacks(req('{"ticket":"x written angrily"}', { q: choice("Which tone is `ticket` written in?", ["angry", "neutral"]) }), "taste_without_user_words"));
  assert.ok(has(req('{"names":"a, b"}', { q: choice("Which name should I use for the helper?", ["a", "b"]) }), "taste_without_user_words", "reject"));
});

test("self_referential_evidence: flag only — repeated question/labels flag; unrelated quotes and genuine grounded words never reject", () => {
  const colour = { q: choice("Which color should the badge be?", ["blue", "red"]) };
  assert.ok(has(req('{"user_messages":["ask me about color: blue or red"]}', colour), "self_referential_evidence", "flag"));
  assert.ok(has(req('{"user_messages":["Which color should the badge be?"]}', colour), "self_referential_evidence", "flag"));
  assert.deepEqual(evidenceFindings(req('{"user_messages":["unrelated words about the weekend"]}', colour)).filter((f) => f.class === "self_referential_evidence"), []);
  const grounded = req('{"user_messages":["I always pick blue over red for badges, keep it that way"]}', colour);
  assert.ok(!classes(grounded).some((c) => c.endsWith(":reject")), `grounded user words must not be rejected: ${classes(grounded)}`);
  const single = req('{"user_messages":["I always pick blue for badges, keep it that way"]}', colour);
  assert.deepEqual(classes(single), []);
});

test("checkable_fact: flag without command output, pass with it", () => {
  assert.ok(has(req("{}", { q: bool("Is CI green on this PR?") }), "checkable_fact", "flag"));
  assert.ok(has(req("{}", { q: bool("Did you publish the package? Is the package public?") }), "checkable_fact", "flag"));
  assert.ok(lacks(req('{"command_output":"✓ all checks passed"}', { q: bool("Is CI green on this PR?") }), "checkable_fact"));
  assert.ok(lacks(req('{"item":"a burger"}', { q: bool("Is `item` a hamburger?") }), "checkable_fact"));
});

test("self_judgement: own output rejects; classifying external text passes", () => {
  assert.ok(has(req('{"diff":"x"}', { q: bool("Is my fix correct?") }), "self_judgement", "reject"));
  assert.ok(has(req('{"diff":"x"}', { q: bool("Am I done with the implementation, everything complete?") }), "self_judgement", "reject"));
  assert.ok(has(req('{"my_summary":"all good"}', { q: bool("Is `x` fine?") }), "self_judgement", "reject"));
  assert.ok(lacks(req('{"line":"ERR x"}', { q: choice("Is this log line an error or a warning?", ["error", "warning"]) }), "self_judgement"));
});

test("user_decision_action: actions the user decides reject; classification of facts passes", () => {
  const rejects = [
    ["Should I merge now?", bool],
    ["Should I force-push the branch?", bool],
    ["Should I force push to main?", bool],
    ["Ok to open a PR for this?", bool],
    ["Shall we submit the pull request?", bool],
    ["Should I close this PR?", bool],
    ["Go ahead and send the email to the customer?", bool],
    ["Should I post the summary to the channel?", bool],
    ["Can we upload the build to the bucket?", bool],
    ["Should I invite the contractor to the repo?", bool],
    ["Ready to purchase the licence?", bool],
    ["Should I deploy to production?", bool],
    ["Should this branch be deleted?", bool],
    ["Should this issue be closed as a duplicate?", bool],
    ["Should I reply to the thread with the fix?", bool],
  ];
  for (const [q, mk] of rejects) assert.ok(has(req('{"diff":"x"}', { q: mk(q) }), "user_decision_action", "reject"), q);
  const optionSets = [["merge_now", "wait"], ["push", "hold"], ["force_push", "rebase"], ["submit_pr", "keep_local"], ["close_pr", "leave_open"], ["send_email", "draft_only"], ["upload", "skip"], ["invite_user", "skip"], ["purchase", "skip"], ["Push to origin", "Stay local"], ["deploy", "wait"]];
  for (const labels of optionSets) assert.ok(has(req('{"diff":"x"}', { q: choice("What next?", labels) }), "user_decision_action", "reject"), labels.join());
  const passes = [
    bool("Does this diff touch deploy scripts?"),
    bool("Is this ticket asking to merge two accounts?"),
    bool("Can this error be caused by a failed deploy?"),
    bool("Does the message in `log` mention a push notification?"),
    choice("Is this a post-mortem or a status update?", ["post_mortem", "status_update"]),
    choice("Which tier suffices for `task`?", ["haiku", "sonnet"]),
    choice("Which category is `ticket` in?", ["bug", "feature_request", "question"]),
    choice("Is this log line an error or a warning?", ["error", "warning"]),
  ];
  for (const q of passes) assert.ok(lacks(req('{"diff":"x"}', { q }), "user_decision_action"), JSON.stringify(q.instructions));
});

test("a valid agent-internal request produces no findings", () => {
  const input = req('{"task":"Extract invoice numbers from 40 plain-text receipts."}', { tier: choice("Which model tier suffices for `task`?", ["haiku", "sonnet"]) });
  assert.deepEqual(evidenceFindings(input), []);
});

test("ASK_JEV_CLI_STRICT=0 downgrades rejects to flagged-with-downgraded; default leaves them", () => {
  const input = req('{"diff":"x"}', { q: bool("Should I merge now?") });
  const findings = evidenceFindings(input);
  assert.ok(applyStrictness(findings).some((f) => f.severity === "reject"));
  process.env.ASK_JEV_CLI_STRICT = "0";
  try {
    const down = applyStrictness(findings);
    assert.ok(down.every((f) => f.severity === "flag") && down.some((f) => f.downgraded));
  } finally {
    delete process.env.ASK_JEV_CLI_STRICT;
  }
});

const JEV = new URL("../bin/jev.mjs", import.meta.url).pathname;

async function withStub(fn) {
  let hits = 0;
  const server = createServer((req, res) => {
    hits++;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answers: { q: { probability: 0.97, confidence: 0.95 }, tier: { choice: "haiku", probabilities: { haiku: 0.9, sonnet: 0.1 }, confidence: 0.9 } } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/`, () => hits);
  } finally {
    server.close();
  }
}

function runCli(input, env) {
  return new Promise((resolve) => {
    const child = execFile("node", [JEV], { env: { ...cleanEnv(), ASK_JEV_API_KEY: "k-12345678", ASK_JEV_PROVIDER: "typesafe", ...env }, timeout: 15000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

test("CLI: reject → exit 2, clear stderr, zero provider calls, no decision row", async () => {
  await withStub(async (url, hits) => {
    const log = join(mkdtempSync(join(tmpdir(), "cliv-")), "log");
    const r = await runCli(req('{"diff":"x"}', { q: bool("Should I merge now?") }), { ASK_JEV_API_URL: url, ASK_JEV_LOG_FILE: log });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /jev: rejected \[user_decision_action\] at questions\.q: .*AskUserQuestion/);
    assert.equal(r.stdout, "");
    assert.equal(hits(), 0);
    assert.equal(existsSync(log), false);
    const taste = await runCli(req('{"ticket":"x"}', TASTE_Q), { ASK_JEV_API_URL: url, ASK_JEV_LOG_FILE: log });
    assert.equal(taste.code, 2);
    assert.match(taste.stderr, /taste_without_user_words/);
    assert.equal(hits(), 0);
  });
});

test("CLI: flag → proceeds, stderr warning, warnings on the logged row; STRICT=0 downgrade logs downgraded", async () => {
  await withStub(async (url, hits) => {
    const log = join(mkdtempSync(join(tmpdir(), "cliv-")), "log");
    const r = await runCli(req("{}", { q: bool("Is CI green on this PR?") }), { ASK_JEV_API_URL: url, ASK_JEV_LOG_FILE: log });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /jev: warning \[checkable_fact\] at questions\.q/);
    assert.equal(JSON.parse(r.stdout).q.probability, 0.97);
    assert.equal(hits(), 1);
    const row = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.kind === "decision");
    assert.equal(row.warnings[0].class, "checkable_fact");

    const down = await runCli(req('{"diff":"x"}', { q: bool("Should I merge now?") }), { ASK_JEV_API_URL: url, ASK_JEV_LOG_FILE: log, ASK_JEV_CLI_STRICT: "0" });
    assert.equal(down.code, 0);
    assert.match(down.stderr, /warning \[user_decision_action\]/);
    assert.equal(hits(), 2);
  });
});

test("CLI: a valid agent-internal request keeps working (exit 0, no warnings)", async () => {
  await withStub(async (url, hits) => {
    const log = join(mkdtempSync(join(tmpdir(), "cliv-")), "log");
    const r = await runCli(req('{"task":"Extract invoice numbers from 40 receipts."}', { tier: choice("Which model tier suffices for `task`?", ["haiku", "sonnet"]) }), { ASK_JEV_API_URL: url, ASK_JEV_LOG_FILE: log });
    assert.equal(r.code, 0);
    assert.equal(r.stderr, "");
    assert.equal(hits(), 1);
    assert.equal(JSON.parse(readFileSync(log, "utf8").trim().split("\n").find((l) => l.includes('"decision"'))).warnings, undefined);
  });
});

test("CLI: the shipped eval fixture still passes validation (no findings)", () => {
  const fixture = JSON.parse(readFileSync(new URL("../evals/fixtures/classify-ticket.json", import.meta.url), "utf8"));
  assert.deepEqual(evidenceFindings(fixture), []);
});

test("jev stats text: v2 view with Human answers, agreement, per-entry-point table, separate stand-downs, error rates, no 'User overrides'", async () => {
  const log = join(mkdtempSync(join(tmpdir(), "cliv-")), "log");
  const rows = [
    { kind: "call", source: "hook", status: "ok", latency_ms: 400 },
    { kind: "call", source: "paseo", status: "error", error_class: "timeout", latency_ms: 800 },
    { kind: "call", source: "cli", status: "ok", latency_ms: 300 },
    { kind: "decision", source: "hook", gate: "ask", mode: "advisory", question: "Q1", outcome: "advised", strength: "strong" },
    { kind: "decision", source: "cli", gate: "cli", question: "tier", outcome: "haiku", confidence: 0.9, threshold: 0.8 },
    { kind: "outcome", source: "hook", recommended: ["A"], chosen: ["A"], agreement: "agree" },
    { kind: "outcome", source: "hook", recommended: ["A"], chosen: ["B"], agreement: "disagree" },
    { kind: "standdown", source: "paseo", reason: "paseo" },
    { kind: "provider_error", source: "paseo", error_class: "timeout" },
  ];
  writeFileSync(log, rows.map((r) => JSON.stringify({ ts: "2026-09-30T10:00:00.000Z", schema: 2, ...r })).join("\n") + "\n");
  const r = await new Promise((resolve) => execFile("node", [JEV, "stats"], { env: { ...cleanEnv(), ASK_JEV_LOG_FILE: log } }, (e, stdout, stderr) => resolve({ stdout, stderr })));
  assert.match(r.stdout, /^Calls: 3 \(ok 2, error 1\)/);
  assert.match(r.stdout, /Human answers: 2/);
  assert.match(r.stdout, /Agreement with Jev: 50\.0% \(1 of 2 compared/);
  assert.match(r.stdout, /By entry point:/);
  for (const ep of ["hook", "paseo", "cli"]) assert.match(r.stdout, new RegExp(`^  ${ep} `, "m"));
  assert.match(r.stdout, /paseo\s+0\s+1\s+1\s+100\.0%/);
  assert.match(r.stdout, /Stand-downs \(not decisions, not errors\): 1/);
  assert.match(r.stdout, /Provider errors: 1/);
  assert.match(r.stdout, /error rate 33\.3%/);
  assert.doesNotMatch(r.stdout, /User overrides/i);
  assert.doesNotMatch(r.stdout, /Jev decided/);
  assert.match(r.stdout, /only observes the result, not whether the agent acted/);
  process.stdout.write(`\n--- sample jev stats ---\n${r.stdout}`);
});
