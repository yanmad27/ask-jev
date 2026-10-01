import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceFindings } from "../lib/cli-validate.mjs";
import { cleanEnv } from "./testenv.mjs";

const bool = (question) => ({ type: "boolean", instructions: { question }, criteria: { true: "yes, per the definition", false: "no, per the definition" } });
const choice = (question, labels) => ({ type: "choice", instructions: { question }, criteria: Object.fromEntries(labels.map((l) => [l, { what: `the ${l} option`, not_for: "the others", examples: [l] }])) });
const req = (stateJson, questions) => ({ state: JSON.parse(stateJson), questions });
const classes = (input) => evidenceFindings(input).map((f) => `${f.class}:${f.severity}`);
const has = (input, cls, severity) => classes(input).includes(`${cls}:${severity}`);
const lacks = (input, cls) => !evidenceFindings(input).some((f) => f.class === cls);

const TASTE_Q = { q: choice("Which tone would the user like for the release note?", ["blunt", "warm"]) };

test("agent_user_description: description keys reject (any depth), taste prose flags; user words and diffs pass", () => {
  assert.ok(has(req('{"user_style":"prefers terse"}', { q: bool("Is `ticket` urgent?") }), "agent_user_description", "reject"));
  assert.ok(has(req('{"notes":"the user probably likes dark mode"}', { q: bool("Is `ticket` urgent?") }), "agent_user_description", "flag"));
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
  const optionSets = [["merge_now", "wait"], ["force_push", "rebase"], ["submit_pr", "keep_local"], ["close_pr", "leave_open"], ["send_email", "draft_only"], ["invite_user", "skip"], ["Push to origin", "Stay local"], ["do_not_push", "go"]];
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

const PEER_BRIEF = "Goal: add a --dry-run flag to the sync script. Steps: push the branch to origin when green, open a PR against main, and once approved merge and deploy to staging. The user wants a short summary. Also delete the temp dir under /tmp/sync-work and send nothing else. Do not touch UserSvc. Prefer the existing naming style.";
const TASTE_BRIEF = `${PEER_BRIEF} The user probably likes terse logs.`;
const PEER_REPORT = "Done: added --dry-run. I pushed the branch to origin and opened a PR; the user asked me to merge it, so I merged and deployed. I deleted the temp dir. Tests: 12 pass. My fix works locally.";

test("Lead callers: tier routing request with an action-heavy Peer brief in state is not rejected or flagged", () => {
  const tier = { type: "choice", instructions: { question: "Which Peer tier does `task` belong to?", focus: "Judge the nature of the work, not its size or how many files it touches." }, criteria: {
    cheap_peer: { what: "Mechanical, well-specified edits with no design judgement", not_for: "peer, expensive_peer", examples: ["rename UserSvc to UserService across the repo"] },
    peer: { what: "Feature work with moderate judgement inside a known design", not_for: "cheap_peer, expensive_peer", examples: ["add rate limiting to POST /login"] },
    expensive_peer: { what: "Cross-cutting design where mistakes break invariants", not_for: "cheap_peer, peer", examples: ["redesign the auth flow to support SSO without breaking existing sessions"] },
  } };
  const input = { state: { task: PEER_BRIEF }, questions: { tier } };
  assert.deepEqual(evidenceFindings(input), []);
  const taste = evidenceFindings({ state: { task: TASTE_BRIEF }, questions: { tier } });
  assert.deepEqual(taste.map((f) => `${f.class}:${f.severity}`), ["agent_user_description:flag"]);
});

test("Lead callers: capability_failure judging a Peer's report against its spec is not self_judgement and is not rejected", () => {
  const capability = { type: "boolean", instructions: "Does `report` show a capability failure given `spec`?", criteria: {
    true: "The Peer had everything it needed and still produced wrong reasoning, broke stated invariants, or lost track across files — the spec was sufficient",
    false: "The output is incomplete or wrong because of missing context, vague acceptance criteria, wrong file paths, ambiguous requirements, a permission block, or a task too large — the spec, not the model, is at fault",
  } };
  const input = { state: { spec: PEER_BRIEF, report: PEER_REPORT }, questions: { capability_failure: capability } };
  assert.ok(!classes(input).some((c) => c.endsWith(":reject")), classes(input).join());
  assert.ok(lacks(input, "self_judgement"));
  assert.ok(lacks(input, "user_decision_action"));
  assert.ok(lacks(input, "taste_without_user_words"));
});

test("actions/taste in the question or option labels still reject even when a Peer brief is in state (scope is what Jev is asked to decide)", () => {
  const withBrief = (q) => ({ state: { task: PEER_BRIEF }, questions: { q } });
  assert.ok(has(withBrief(bool("Should I push the branch to origin?")), "user_decision_action", "reject"));
  assert.ok(has(withBrief(choice("What next?", ["merge_now", "wait"])), "user_decision_action", "reject"));
  assert.ok(has(withBrief(choice("Which wording would the user like?", ["terse", "verbose"])), "taste_without_user_words", "reject"));
});

test("round 2 (1): action only in criteria definitions/labels is a flag, not a reject; framing or verb+object label rejects", () => {
  const deployBuild = { type: "choice", instructions: { question: "Classify the requested operation." }, criteria: { deploy: { what: "Deploy to production", not_for: "build", examples: [] }, build: { what: "Build locally", not_for: "deploy", examples: [] } } };
  assert.deepEqual(classes({ state: { request: "ship it" }, questions: { q: deployBuild } }), ["ambiguous_action:flag"]);
  const neutral = { type: "choice", instructions: { question: "Which next step?" }, criteria: { yes: { what: "Proceed with the deployment", not_for: "no", examples: [] }, no: { what: "Keep it local", not_for: "yes", examples: [] } } };
  assert.deepEqual(classes({ state: { diff: "x" }, questions: { q: neutral } }), ["ambiguous_action:flag"]);
  const pushOrigin = { type: "choice", instructions: { question: "Which next step?" }, criteria: { yes: { what: "Push to origin", not_for: "no", examples: [] }, no: { what: "Keep local", not_for: "yes", examples: [] } } };
  assert.deepEqual(classes({ state: { diff: "x" }, questions: { q: pushOrigin } }), ["ambiguous_action:flag"]);
  const bool2 = { type: "boolean", instructions: "Which next step?", criteria: { true: "Merge the PR now", false: "Leave it open" } };
  assert.deepEqual(classes({ state: { diff: "x" }, questions: { q: bool2 } }), ["ambiguous_action:flag"]);
  assert.ok(has({ state: { diff: "x" }, questions: { q: { ...pushOrigin, instructions: { question: "Should I do the next step?" } } } }, "user_decision_action", "reject"));
  assert.ok(has({ state: { diff: "x" }, questions: { q: { ...pushOrigin, instructions: { question: "Which next step?", focus: "ok to go ahead?" } } } }, "user_decision_action", "reject"));
  assert.ok(has({ state: { diff: "x" }, questions: { q: { ...deployBuild, criteria: { merge_now: { what: "m", not_for: "build", examples: [] }, build: { what: "b", not_for: "merge_now", examples: [] } } } } }, "user_decision_action", "reject"));
});

test("round 3: 'proceed with / go ahead with / carry out / do the <action noun>' in criteria flags ambiguous_action (never silent, never reject)", () => {
  const mk = (yes) => ({ type: "choice", instructions: { question: "Which next step?" }, criteria: { yes: { what: yes, not_for: "no", examples: [] }, no: { what: "Keep it local", not_for: "yes", examples: [] } } });
  for (const yes of ["Proceed with the deployment", "Go ahead with the release", "Carry out the merge", "Do the rollout", "Proceed with the database migration", "Go ahead with this payment", "Do the purchase"]) {
    assert.deepEqual(classes({ state: { diff: "x" }, questions: { q: mk(yes) } }), ["ambiguous_action:flag"], yes);
  }
  assert.deepEqual(classes({ state: { diff: "x" }, questions: { q: mk("Proceed with the analysis") } }), []);
});

test("round 4 (1): ANY single-word bare label under a neutral classification flags ambiguous_action; framing and verb+object labels still reject", () => {
  for (const [question, labels] of [["Classify this git operation", ["push", "pull", "fetch"]], ["Classify the cleanup", ["delete", "archive"]], ["Classify the request", ["upload", "download"]], ["Classify the contact", ["invite", "remove"]], ["Classify the order", ["purchase", "refund"]], ["Classify the step", ["release", "deploy", "merge"]]]) {
    assert.deepEqual(classes(req('{"op":"git push origin main"}', { q: choice(question, labels) })), ["ambiguous_action:flag"], labels.join());
  }
  assert.ok(has(req('{"op":"x"}', { q: choice("Should I push?", ["yes", "no"]) }), "user_decision_action", "reject"));
  assert.ok(has(req('{"op":"x"}', { q: choice("Should I push?", ["push", "wait"]) }), "user_decision_action", "reject"));
  for (const labels of [["merge_now", "wait"], ["submit_pr", "keep"], ["send_email", "draft"], ["force_push", "rebase"], ["do_not_push", "go"], ["Push to origin", "Stay local"]]) {
    assert.ok(has(req('{"op":"x"}', { q: choice("Classify the step", labels) }), "user_decision_action", "reject"), labels.join());
  }
});

test("round 4 (2): examples are inspected (flag), every criteria/instructions string is size-guarded, instructions.detail is scanned for decision framing", () => {
  const mk = (extra) => ({ type: "choice", instructions: { question: "Which next step?" }, criteria: { yes: { what: "The next step", not_for: "no", examples: extra.yes ?? ["x"] }, no: { what: "Keep it local", not_for: extra.notFor ?? "yes", examples: extra.no ?? ["y"] } } });
  assert.deepEqual(classes({ state: { d: "x" }, questions: { q: mk({ yes: ["Proceed with the deployment"] }) } }), ["ambiguous_action:flag"]);
  assert.deepEqual(classes({ state: { d: "x" }, questions: { q: mk({ yes: ["Push to origin"] }) } }), ["ambiguous_action:flag"]);
  assert.ok(has({ state: { d: "x" }, questions: { q: mk({ notFor: "n".repeat(5000) }) } }, "oversized_text", "reject"));
  assert.ok(has({ state: { d: "x" }, questions: { q: mk({ yes: ["e".repeat(5000)] }) } }, "oversized_text", "reject"));
  const pad = "word ".repeat(1000) + "Should I merge now?";
  const withDetail = (detail) => ({ type: "boolean", instructions: { question: "Is `d` ok?", detail }, criteria: { true: "yes", false: "no" } });
  assert.ok(has({ state: { d: "x" }, questions: { q: withDetail("Should I merge now?") } }, "user_decision_action", "reject"));
  assert.ok(has({ state: { d: "x" }, questions: { q: withDetail(pad) } }, "oversized_text", "reject"));
  assert.ok(has({ state: { d: "x" }, questions: { q: { type: "boolean", instructions: { question: "Is `d` ok?", nested: { more: pad } }, criteria: { true: "yes", false: "no" } } } }, "oversized_text", "reject"));
  assert.ok(has({ state: { d: "x" }, questions: { q: { type: "boolean", instructions: ["Is `d` ok?", pad], criteria: { true: "yes", false: "no" } } } }, "oversized_text", "reject"));
});

test("round 2 (2): 'should my/our X be accepted/approved/merged…' and 'is my X ready/good enough' reject self_judgement", () => {
  for (const q of ["Should my fix be accepted?", "Should our change be approved?", "Can my PR be merged?", "Should my patch be shipped?", "Is my fix ready?", "Is my implementation good enough?", "Would my change be good enough to land?"]) {
    assert.ok(has(req('{"diff":"a to b"}', { q: bool(q) }), "self_judgement", "reject"), q);
  }
  assert.ok(lacks(req('{"report":"x"}', { q: bool("Should the Peer's fix be accepted given `report`?") }), "self_judgement"));
});

test("round 2 (3): oversized question/focus/definition rejects as oversized_text; padding cannot hide a decision question", () => {
  const padded = "word ".repeat(1000) + "Should I merge now?";
  assert.ok(padded.length > 4096);
  assert.ok(has(req('{"diff":"x"}', { q: bool(padded) }), "oversized_text", "reject"));
  assert.ok(has(req('{"diff":"x"}', { q: { type: "boolean", instructions: { question: "Is `diff` ok?", focus: padded }, criteria: { true: "yes", false: "no" } } }), "oversized_text", "reject"));
  assert.ok(has(req('{"diff":"x"}', { q: { type: "boolean", instructions: "Is `diff` ok?", criteria: { true: padded, false: "no" } } }), "oversized_text", "reject"));
  assert.ok(lacks(req('{"diff":"x"}', { q: bool("a ".repeat(2000)) }), "oversized_text"));
  assert.ok(lacks(req(JSON.stringify({ diff: padded }), { q: bool("Is `diff` ok?") }), "oversized_text"));
});

test("review repair (b): nested description-style key rejects at any depth", () => {
  const r = evidenceFindings(req('{"context":{"user_style":"prefers terse"}}', { q: bool("Is `context` urgent?") }));
  assert.ok(r.some((f) => f.class === "agent_user_description" && f.severity === "reject" && f.path === "state.context.user_style"));
  assert.ok(has(req('{"items":[{"persona":"terse"}]}', { q: bool("Is `items` urgent?") }), "agent_user_description", "reject"));
  assert.ok(has(req('{"a":{"b":{"my_summary":"fine"}}}', { q: bool("Is `a` ok?") }), "self_judgement", "reject"));
});

test("review repair (c): taste prose anywhere in state flags (never rejects); Lead shapes still produce no reject", () => {
  const nested = req('{"context":{"notes":"the user probably likes dark mode"}}', { q: bool("Is `context` urgent?") });
  assert.ok(has(nested, "agent_user_description", "flag"));
  assert.ok(!classes(nested).some((c) => c.endsWith(":reject")));
});

test("review repair (d): 'What version is installed?' with no command output flags checkable_fact", () => {
  assert.ok(has(req("{}", { q: bool("What version is installed?") }), "checkable_fact", "flag"));
  assert.ok(lacks(req('{"command_output":"v1.5.0"}', { q: bool("What version is installed?") }), "checkable_fact"));
});

test("review repair (e): first-person ownership + evaluative question rejects; Lead capability_failure (Peer report vs spec) stays allowed", () => {
  for (const q of ["Does my fix work?", "Is our change correct?", "Will my PR break anything?", "Did I fix it?", "Is my implementation of the parser good?"]) {
    assert.ok(has(req('{"diff":"a to b"}', { q: bool(q) }), "self_judgement", "reject"), q);
  }
  const cap = bool("Does `report` show a capability failure given `spec`?");
  assert.ok(lacks({ state: { spec: PEER_BRIEF, report: "Done. My fix works locally." }, questions: { capability_failure: cap } }, "self_judgement"));
  assert.ok(lacks(req('{"log":"x"}', { q: bool("Does the Peer's fix work for `report`?") }), "self_judgement"));
});

test("review repair 2: classifying release/deploy/merge/publish labels is flagged ambiguous_action, not rejected; permission framing or object labels reject", () => {
  for (const labels of [["release", "maintenance"], ["deploy", "docs"], ["merge", "feature"], ["publish", "draft"], ["ship", "chore"], ["push_notification", "bug"]]) {
    const input = req('{"commit":"chore: bump version to 1.2.0"}', { kind: choice("Classify this commit.", labels) });
    assert.deepEqual(classes(input), ["ambiguous_action:flag"], labels.join());
  }
  assert.deepEqual(classes(req('{"commit":"x"}', { kind: choice("Classify this commit.", ["feature", "bugfix"]) })), []);
  assert.ok(has(req('{"commit":"x"}', { kind: choice("Should I ship this commit or hold it?", ["release", "hold"]) }), "user_decision_action", "reject"));
  assert.ok(has(req('{"commit":"x"}', { kind: choice("Whether to go ahead with this commit?", ["merge", "wait"]) }), "user_decision_action", "reject"));
  assert.ok(has(req('{"commit":"x"}', { kind: choice("Classify this commit.", ["merge_now", "wait"]) }), "user_decision_action", "reject"));
});

test("review repair 3: validator is linear on 1 MB hostile inputs (< 200 ms)", () => {
  const big = "is my code " + "x ".repeat(500_000);
  const hostile = "does my fix " + "a ".repeat(500_000);
  const inputs = [
    { state: { notes: big, context: { deep: hostile } }, questions: { q: bool(big) } },
    { state: { user_messages: [big] }, questions: { q: bool(hostile) } },
    { state: { x: "the user " + "z".repeat(1_000_000) }, questions: { q: choice(big, ["a", "b"]) } },
  ];
  const t0 = performance.now();
  for (const i of inputs) evidenceFindings(i);
  assert.ok(performance.now() - t0 < 200, `took ${performance.now() - t0}ms`);
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

test("CLI: flag → proceeds, stderr warning, warnings on the logged row; ASK_JEV_CLI_STRICT=0 is no longer an override", async () => {
  await withStub(async (url, hits) => {
    const log = join(mkdtempSync(join(tmpdir(), "cliv-")), "log");
    const r = await runCli(req("{}", { q: bool("Is CI green on this PR?") }), { ASK_JEV_API_URL: url, ASK_JEV_LOG_FILE: log });
    assert.equal(r.code, 0);
    assert.match(r.stderr, /jev: warning \[checkable_fact\] at questions\.q/);
    assert.equal(JSON.parse(r.stdout).q.probability, 0.97);
    assert.equal(hits(), 1);
    const row = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((e) => e.kind === "decision");
    assert.equal(row.warnings[0].class, "checkable_fact");

    const stillRejected = await runCli(req('{"diff":"x"}', { q: bool("Should I merge now?") }), { ASK_JEV_API_URL: url, ASK_JEV_LOG_FILE: log, ASK_JEV_CLI_STRICT: "0" });
    assert.equal(stillRejected.code, 2);
    assert.match(stillRejected.stderr, /rejected \[user_decision_action\]/);
    assert.equal(hits(), 1);
  });
});

test("CLI: a valid agent-internal request keeps working (exit 0, no warnings)", async () => {
  await withStub(async (url, hits) => {
    const log = join(mkdtempSync(join(tmpdir(), "cliv-")), "log");
    const r = await runCli(req('{"task":"Extract invoice numbers from 40 receipts."}', { tier: choice("Which model tier suffices for `task`?", ["haiku", "sonnet"]) }), { ASK_JEV_API_URL: url, ASK_JEV_LOG_FILE: log });
    assert.equal(r.code, 0);
    assert.equal(r.stderr, "");
    assert.equal(hits(), 1);
    const row = JSON.parse(readFileSync(log, "utf8").trim().split("\n").find((l) => l.includes('"decision"')));
    assert.equal(row.warnings, undefined);
    assert.equal(row.question, "Which model tier suffices for `task`?");
    assert.equal(row.question_name, "tier");
    assert.equal(row.question_text, undefined);
  });
});

test("CLI: provider error text on stderr is redacted (key never printed)", async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => (res.writeHead(401), res.end("invalid key k-12345678 for Bearer abcdefghijklmnopqrstuvwxyz0123456789")));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const log = join(mkdtempSync(join(tmpdir(), "cliv-")), "log");
    const r = await runCli(req('{"task":"Extract invoice numbers."}', { tier: choice("Which model tier suffices for `task`?", ["haiku", "sonnet"]) }), { ASK_JEV_API_URL: `http://127.0.0.1:${server.address().port}/`, ASK_JEV_LOG_FILE: log });
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.stderr, /k-12345678|abcdefghijklmnopqrstuvwxyz0123456789/);
    assert.match(r.stderr, /^jev: /);
  } finally {
    server.close();
  }
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
