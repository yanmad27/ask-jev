import { cleanEnv } from "./testenv.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { parseEvents, filterSince, filterRepo, normalizeRepo, sinceMsFromSpec, recentDecisions, computeStats } from "../lib/stats.mjs";
import { requestError, provider, endpoint } from "../lib/jev.mjs";

const execFileAsync = promisify(execFile);
const transcript = join(mkdtempSync(join(tmpdir(), "askjev-")), "t.jsonl");
writeFileSync(transcript, '{"type":"user","message":{"content":"hi"}}\n{"type":"assistant","message":{"content":"hi"}}\n');
const logFile = join(mkdtempSync(join(tmpdir(), "askjev-log-")), "jev.log");

function stub(handler) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answers: handler(JSON.parse(body)) }));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}
const opts = [{ label: "A", description: "a" }, { label: "B", description: "b" }];

test("lib/stats.mjs: malformed lines skipped, --since filters, recentDecisions caps to newest N", () => {
  const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
  const now = new Date().toISOString();
  const raw = ["not json", JSON.stringify({ ts: old, kind: "decision", outcome: "answered", question: "Old?" }),
    JSON.stringify({ ts: now, kind: "decision", outcome: "answered", question: "New1?" }),
    JSON.stringify({ ts: now, kind: "decision", outcome: "error", question: "New2?" }), ""].join("\n");

  const events = parseEvents(raw);
  assert.equal(events.length, 3);
  assert.equal(filterSince(events, sinceMsFromSpec("7d")).length, 2);
  const lastOne = recentDecisions(events, 1);
  assert.equal(lastOne.length, 1);
  assert.equal(lastOne[0].question, "New2?");
});

test("lib/stats.mjs: computeStats reports per-gate positive/fallback rates", () => {
  const events = [
    { kind: "decision", gate: "ask", outcome: "answered" },
    { kind: "decision", gate: "ask", outcome: "personal" },
    { kind: "decision", gate: "permission", outcome: "allow" },
    { kind: "decision", gate: "permission", outcome: "ask" },
    { kind: "decision", gate: "bash", outcome: "success" },
    { kind: "decision", gate: "bash", outcome: "tests_failed" },
  ];
  const s = computeStats(events);
  assert.equal(s.decisions.total, 6);
  assert.deepEqual(s.decisions.by_gate.ask, { total: 2, positive: 1, by_outcome: { answered: 1, personal: 1 } });
  assert.deepEqual(s.decisions.by_gate.permission, { total: 2, positive: 1, by_outcome: { allow: 1, ask: 1 } });
  assert.deepEqual(s.decisions.by_gate.bash, { total: 2, positive: 1, by_outcome: { success: 1, tests_failed: 1 } });
  // positive: ask/answered, permission/allow, bash/success = 3 of 6
  assert.equal(s.decisions.positive_pct, 50);
  // fallback: ask/personal (non-answered) + permission/ask = 2 of 6
  assert.equal(s.decisions.fallback_pct, (2 / 6) * 100);
});

test("lib/stats.mjs: diagnostics (e.g. Paseo standdown) are excluded from decision totals", () => {
  const events = [
    { kind: "decision", gate: "ask", outcome: "answered" },
    { kind: "diagnostic", gate: "ask", outcome: "paseo_standdown" },
  ];
  const s = computeStats(events);
  assert.equal(s.decisions.total, 1);
  assert.equal(s.decisions.by_outcome.paseo_standdown, undefined);
});

test("lib/stats.mjs: CLI decisions count in totals; acted when confidence >= threshold, fallback below", () => {
  const events = [
    { kind: "decision", gate: "ask", outcome: "answered" },
    { kind: "decision", gate: "ask", outcome: "personal" },
    { kind: "decision", gate: "cli", outcome: "true", confidence: 0.95, threshold: 0.8 },
    { kind: "decision", gate: "cli", outcome: "a", confidence: 0.5, threshold: 0.8 },
  ];
  const s = computeStats(events);
  assert.equal(s.decisions.total, 4);
  assert.deepEqual(s.decisions.by_outcome, { answered: 1, personal: 1, true: 1, a: 1 });
  assert.equal(s.decisions.positive_pct, 50);
  assert.equal(s.decisions.fallback_pct, 50);
  assert.equal(s.fallbacks, 2);
  assert.deepEqual(s.decisions.by_gate.ask, { total: 2, positive: 1, by_outcome: { answered: 1, personal: 1 } });
  assert.deepEqual(s.decisions.by_gate.cli, { total: 2, positive: 1, by_outcome: { true: 1, a: 1 } });
  assert.equal(s.decisions.by_source.cli.decisions, 2);
});

test("lib/jev.mjs: askJev retries 5xx until success within budget, logs retried + attempts", async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      calls++;
      if (calls <= 3) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Service temporarily unavailable" } }));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ answers: { ok: { probability: 0.5 } } }));
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const script = "import('./lib/jev.mjs').then(async ({askJev}) => { "
    + "const a = await askJev('dummy', {x:1}, {ok:{type:'boolean',instructions:{question:'q',focus:'f'},criteria:{true:'t',false:'f'}}}, 'test', 8000); "
    + "process.stdout.write(JSON.stringify(a)); });";
  const { stdout } = await execFileAsync("node", ["-e", script], {
    env: { ...cleanEnv(), ASK_JEV_GATEWAY_URL: url, ASK_JEV_LOG_FILE: logFile },
    encoding: "utf8",
  });
  server.close();
  assert.equal(calls, 4);
  assert.deepEqual(JSON.parse(stdout), { ok: { probability: 0.5, confidence: 0.5 } });

  const call = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .filter((e) => e.kind === "call" && e.source === "test").at(-1);
  assert.equal(call.status, "ok");
  assert.equal(call.retried, true);
  assert.equal(call.attempts, 4);
});

test("lib/jev.mjs: a gateway that always 503s gives up within budget, with backoff capping the attempts", async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      calls++;
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Service temporarily unavailable" } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const script = "import('./lib/jev.mjs').then(async ({askJev}) => { const t = Date.now(); "
    + "await askJev('dummy', {x:1}, {ok:{type:'boolean',instructions:{question:'q'},criteria:{true:'t',false:'f'}}}, 'test-503', 4000).catch(() => {}); "
    + "process.stdout.write(String(Date.now() - t)); });";
  const { stdout } = await execFileAsync("node", ["-e", script], {
    env: { ...cleanEnv(), ASK_JEV_GATEWAY_URL: `http://127.0.0.1:${server.address().port}`, ASK_JEV_LOG_FILE: logFile },
    encoding: "utf8",
  });
  server.close();
  assert.ok(Number(stdout) <= 4000, `took ${stdout}ms`);
  // backoff 300 → 600 → 1200 chặn ở tối đa 4 attempt (backoff cố định 300ms sẽ ra ~8); máy bận → có thể 2–3.
  assert.ok(calls >= 2 && calls <= 4, `calls=${calls}`);
});

test("lib/jev.mjs: a hanging gateway response stays within the requested budget", async () => {
  const server = createServer((req) => {
    req.on("data", () => {}); // không bao giờ res.end() — mô phỏng gateway treo
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const budgetMs = 2000;
  const script = "import('./lib/jev.mjs').then(async ({askJev}) => { "
    + `const t0 = Date.now(); try { await askJev('dummy', {x:1}, {ok:{type:'boolean',instructions:{question:'q',focus:'f'},criteria:{true:'t',false:'f'}}}, 'test', ${budgetMs}); } catch {} `
    + "process.stdout.write(String(Date.now() - t0)); });";
  const { stdout } = await execFileAsync("node", ["-e", script], {
    env: { ...cleanEnv(), ASK_JEV_GATEWAY_URL: url, ASK_JEV_LOG_FILE: logFile },
    encoding: "utf8",
  });
  server.close();
  const elapsed = Number(stdout);
  assert.ok(elapsed < budgetMs + 500, `expected well under budgetMs=${budgetMs}, got ${elapsed}ms`);
});

test("lib/jev.mjs: logEvent stamps every line with a unique event_id", async () => {
  const script = "import('./lib/jev.mjs').then(({logEvent}) => { logEvent({kind:'event_id_test'}); logEvent({kind:'event_id_test'}); });";
  await execFileAsync("node", ["-e", script], { env: { ...cleanEnv(), ASK_JEV_LOG_FILE: logFile } });
  const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "event_id_test");
  assert.equal(lines.length, 2);
  assert.match(lines[0].event_id, /^[0-9a-f-]{36}$/);
  assert.match(lines[1].event_id, /^[0-9a-f-]{36}$/);
  assert.notEqual(lines[0].event_id, lines[1].event_id);
});

test("lib/jev.mjs: askJev accepts explicit metadata that overrides process-derived agent/repo", async () => {
  const { server, url } = await recorder([[200, {}, { answers: { ok: { probability: 0.5 } } }]]);
  const script = "import('./lib/jev.mjs').then(async ({askJev}) => { "
    + "await askJev('dummy', {x:1}, {ok:{type:'boolean',instructions:{question:'q'},criteria:{true:'t',false:'f'}}}, 'test-meta', 4000, undefined, "
    + "{agent: 'plugin-agent', repo: 'github.com/example/plugin-repo', session_id: 'plugin-session', request_id: 'req-1'}); });";
  await execFileAsync("node", ["-e", script], { env: { ...cleanEnv(), ASK_JEV_GATEWAY_URL: url, ASK_JEV_LOG_FILE: logFile } });
  server.close();
  const call = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.source === "test-meta").at(-1);
  assert.equal(call.agent, "plugin-agent");
  assert.equal(call.repo, "github.com/example/plugin-repo");
  assert.equal(call.session_id, "plugin-session");
  assert.equal(call.request_id, "req-1");
});

test("cli: wrong input shape fails with the expected shape, not a TypeError", async () => {
  const run = execFileAsync("node", ["bin/jev.mjs"], { env: { ...cleanEnv(), AI_GATEWAY_API_KEY: "x" } });
  run.child.stdin.end(JSON.stringify({ task: "t", context: "c", question: "q" }));
  await assert.rejects(run, (err) => /input must be \{"state"/.test(err.stderr) && /got keys: task, context, question/.test(err.stderr));
});

test("requestError: rejects shapes agents invent, accepts documented ones", () => {
  const q = (over) => ({ state: { x: 1 }, questions: { a: { type: "boolean", instructions: { question: "?" }, criteria: { true: "t", false: "f" }, ...over } } });
  const bad = [
    [null, /input must be/],
    [[], /input must be/],
    [{ state: "s", questions: {} }, /input must be/],
    [{ questions: q().questions }, /input must be/],
    [{ state: "s", question: "free text?" }, /got keys: state, question/],
    [q({ type: "classify" }), /questions\.a\.type must be one of/],
    [q({ instructions: undefined }), /questions\.a\.instructions is required/],
    [q({ criteria: undefined }), /questions\.a\.criteria is required/],
    [q({ criteria: ["A", "B"] }), /questions\.a\.criteria is required/],
    [q({ criteria: { yes: "y", no: "n" } }), /needs both "true" and "false"/],
    [q({ type: "choice", criteria: { only: { what: "x" } } }), /needs 2\+ options/],
  ];
  for (const [input, re] of bad) assert.match(requestError(input) ?? "", re, JSON.stringify(input));

  assert.equal(requestError(q()), null);
  assert.equal(requestError(q({ type: "choice", criteria: { a: { what: "x" }, b: "plain string ok" } })), null);
  const skill = readFileSync("skills/ask-jev/SKILL.md", "utf8").match(/```json\n([\s\S]*?)```/)[1];
  assert.equal(requestError(JSON.parse(skill)), null, "SKILL.md example must stay valid");
  assert.equal(requestError(JSON.parse(readFileSync("evals/fixtures/classify-ticket.json", "utf8"))), null);
});

test("filterRepo: same repo matches across ssh/https/credentials; other repos and repo-less lines drop out", () => {
  for (const url of ["git@github.com:yanmad27/ask-jev.git", "https://github.com/yanmad27/ask-jev", "https://u:tok@GitHub.com/yanmad27/ask-jev.git/", "ssh://git@github.com/yanmad27/ask-jev.git"]) {
    assert.equal(normalizeRepo(url), "github.com/yanmad27/ask-jev", url);
  }
  assert.equal(normalizeRepo(undefined), null);
  const events = [{ repo: "git@github.com:yanmad27/ask-jev.git" }, { repo: "https://github.com/yanmad27/ask-jev" }, { repo: "git@github.com:tini-works/kiosk-app.git" }, {}];
  assert.equal(filterRepo(events, "https://github.com/yanmad27/ask-jev.git").length, 2);
  assert.deepEqual(filterRepo(events, null), [{}]);
});

// --- Providers: typesafe (default) vs vercel (legacy, chọn theo tiền tố key) ---

function recorder(replies) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      const [status, headers, json] = replies[Math.min(seen.length, replies.length) - 1];
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(json));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}
const callJev = (key, url, extraEnv = {}) => {
  const script = "import('./lib/jev.mjs').then(async ({askJev}) => { "
    + "const r = await askJev(process.env.K, {x:1}, {ok:{type:'boolean',instructions:{question:'q'},criteria:{true:'t',false:'f'}}}, 'test-provider', 6000).catch((e) => ({error: e.message})); "
    + "process.stdout.write(JSON.stringify(r)); });";
  return execFileAsync("node", ["-e", script], {
    env: { ...cleanEnv(), K: key, ASK_JEV_PROVIDER: "", ASK_JEV_API_URL: url, ASK_JEV_LOG_FILE: logFile, ...extraEnv },
    encoding: "utf8",
  }).then(({ stdout }) => JSON.parse(stdout));
};
const yes = { ok: { probability: 0.9 }, ok__mirror: { probability: 0.1 } };

test("provider: non-vck key → typesafe request (Bearer, body.model, type noul, no ai-* headers); noul maps to probability", async () => {
  const { server, seen, url } = await recorder([[200, {}, { model: "jev-1.13.0", answers: { ok: { type: "noul", noul: 0.9 }, ok__mirror: { type: "noul", noul: 0.1 } } }]]);
  const out = await callJev("tsk_abc", url);
  server.close();
  assert.equal(seen[0].headers.authorization, "Bearer tsk_abc");
  assert.ok(!Object.keys(seen[0].headers).some((h) => h.startsWith("ai-")));
  assert.equal(seen[0].body.model, "jev-latest");
  assert.equal(seen[0].body.questions.ok.type, "noul");
  assert.equal(seen[0].body.questions.ok__mirror.type, "noul");
  assert.equal(out.ok.probability, 0.9);
  const call = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.source === "test-provider").at(-1);
  assert.equal(call.provider, "typesafe");
  assert.equal(call.api_model, "jev-1.13.0");
});

test("provider: vck_ key → exact legacy Vercel request (headers, body without model, boolean type)", async () => {
  const { server, seen, url } = await recorder([[200, {}, { answers: yes }]]);
  const out = await callJev("vck_abc", url);
  server.close();
  const h = seen[0].headers;
  assert.equal(seen[0].url, "/");
  assert.equal(h.authorization, "Bearer vck_abc");
  assert.equal(h["ai-model-id"], "typesafe-ai/jev");
  assert.equal(h["ai-gateway-protocol-version"], "0.0.1");
  assert.equal(h["ai-evaluation-model-specification-version"], "4");
  assert.deepEqual(Object.keys(seen[0].body), ["state", "questions"]);
  assert.equal(seen[0].body.questions.ok.type, "boolean");
  assert.equal(out.ok.probability, 0.9);
});

test("provider: ASK_JEV_PROVIDER=vercel overrides key inference", async () => {
  const { server, seen, url } = await recorder([[200, {}, { answers: yes }]]);
  await callJev("tsk_abc", url, { ASK_JEV_PROVIDER: "vercel" });
  server.close();
  assert.equal(seen[0].headers["ai-model-id"], "typesafe-ai/jev");
});

test("typesafe: 429 is retried honoring retry-after; 401 explains where keys come from", async () => {
  const { server, seen, url } = await recorder([[429, { "retry-after": "1" }, { error: "slow down" }], [200, {}, { answers: { ok: { noul: 0.9 }, ok__mirror: { noul: 0.1 } } }]]);
  const t = Date.now();
  const out = await callJev("tsk_abc", url);
  server.close();
  assert.equal(seen.length, 2);
  assert.ok(Date.now() - t >= 1000, "waited for retry-after");
  assert.equal(out.ok.probability, 0.9);

  const bad = await recorder([[401, {}, { error: "bad key" }]]);
  const err = await callJev("vck_abc", bad.url, { ASK_JEV_PROVIDER: "typesafe" });
  bad.server.close();
  assert.match(err.error, /console\.typesafe\.ai\/keys/);
  assert.match(err.error, /ASK_JEV_PROVIDER=vercel/);
  assert.doesNotMatch(err.error, /gateway/);
});

test("provider/endpoint: defaults per provider, inference, legacy var, case-insensitive and unknown ASK_JEV_PROVIDER", () => {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (/^(ASK_)?JEV_|^(TYPESAFE|AI_GATEWAY)_API_KEY$/.test(k)) delete process.env[k];
  try {
    assert.deepEqual(endpoint("typesafe"), { url: "https://api.typesafe.ai/v1/systemone", model: "jev-latest" });
    assert.deepEqual(endpoint("vercel"), { url: "https://ai-gateway.vercel.sh/v4/ai/evaluation-model", model: "typesafe-ai/jev" });
    assert.equal(provider("vck_x"), "vercel");
    assert.equal(provider("tsk_x"), "typesafe");
    process.env.AI_GATEWAY_API_KEY = "eyJoidc";
    assert.equal(provider("eyJoidc"), "vercel");
    process.env.TYPESAFE_API_KEY = "eyJoidc";
    assert.equal(provider("eyJoidc"), "typesafe");
    process.env.ASK_JEV_PROVIDER = "Vercel";
    assert.equal(provider("tsk_x"), "vercel");
    for (const bad of ["constructor", "nope"]) {
      process.env.ASK_JEV_PROVIDER = bad;
      assert.throws(() => provider("tsk_x"), /ASK_JEV_PROVIDER must be one of typesafe, vercel/);
    }
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("cli on typesafe: boolean answer is exactly {probability, confidence} — no raw noul/type", async () => {
  const { server, url } = await recorder([[200, {}, { model: "jev-1.13.0", answers: { ok: { type: "noul", noul: 0.9 }, ok__mirror: { type: "noul", noul: 0.1 } } }]]);
  const run = execFileAsync("node", ["bin/jev.mjs"], { env: { ...cleanEnv(), TYPESAFE_API_KEY: "tsk_abc", ASK_JEV_API_URL: url, ASK_JEV_LOG_FILE: logFile } });
  run.child.stdin.end(JSON.stringify({ state: { x: 1 }, questions: { ok: { type: "boolean", instructions: { question: "q" }, criteria: { true: "t", false: "f" } } } }));
  const { stdout } = await run;
  server.close();
  const a = JSON.parse(stdout);
  assert.deepEqual(Object.keys(a.ok).sort(), ["confidence", "probability"]);
  assert.ok(Math.abs(a.ok.probability - 0.9) < 1e-9);
  assert.ok(Math.abs(a.ok.confidence - 0.9) < 1e-9);
});

test("cli decision logging: boolean question logs question (text)/question_name/options/result/confidence, stdout unaffected", async () => {
  const { server, url } = await recorder([[200, {}, { model: "jev-1.13.0", answers: { ok: { type: "noul", noul: 0.9 }, ok__mirror: { type: "noul", noul: 0.1 } } }]]);
  const run = execFileAsync("node", ["bin/jev.mjs"], { env: { ...cleanEnv(), TYPESAFE_API_KEY: "tsk_abc", ASK_JEV_API_URL: url, ASK_JEV_LOG_FILE: logFile } });
  run.child.stdin.end(JSON.stringify({ state: { x: 1 }, questions: { ok: { type: "boolean", instructions: { question: "Is this ok?" }, criteria: { true: "t", false: "f" } } } }));
  const { stdout } = await run;
  server.close();
  assert.deepEqual(JSON.parse(stdout), { ok: { probability: 0.9, confidence: 0.9 } }); // stdout byte-shape unchanged by logging

  const d = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .filter((e) => e.kind === "decision" && e.source === "cli" && e.question_name === "ok").at(-1);
  assert.equal(d.gate, "cli");
  assert.equal(d.outcome, "true"); // 0.9 >= 0.5 cut
  assert.equal(d.question, "Is this ok?");
  assert.equal(d.question_name, "ok");
  assert.deepEqual(d.options.sort(), ["false", "true"]);
  assert.ok(Math.abs(d.result - 0.9) < 1e-9);
  assert.ok(Math.abs(d.confidence - 0.9) < 1e-9);
});

test("cli decision logging: choice question logs {choice, probability} as result", async () => {
  const { server, url } = await recorder([[200, {}, { answers: { pick: { choice: "a", probabilities: { a: 0.7, b: 0.3 } } } }]]);
  const run = execFileAsync("node", ["bin/jev.mjs"], { env: { ...cleanEnv(), ASK_JEV_API_KEY: "vck_dummy", ASK_JEV_GATEWAY_URL: url, ASK_JEV_LOG_FILE: logFile } });
  run.child.stdin.end(JSON.stringify({
    state: { x: 1 },
    questions: { pick: { type: "choice", instructions: { question: "Pick one" }, criteria: { a: { what: "A" }, b: { what: "B" } } } },
  }));
  const { stdout } = await run;
  server.close();
  assert.deepEqual(JSON.parse(stdout), { pick: { choice: "a", probabilities: { a: 0.7, b: 0.3 } } });

  const d = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    .filter((e) => e.kind === "decision" && e.source === "cli" && e.question_name === "pick").at(-1);
  assert.equal(d.gate, "cli");
  assert.equal(d.outcome, "a");
  assert.equal(d.question, "Pick one");
  assert.equal(d.question_name, "pick");
  assert.deepEqual(d.options.sort(), ["a", "b"]);
  assert.deepEqual(d.result, { choice: "a", probability: 0.7 });
  assert.equal(d.confidence, 0.7);
});

test("401 hint on the vercel path when the key is not a Vercel key", async () => {
  const bad = await recorder([[401, {}, { error: "bad" }]]);
  const err = await callJev("tsk_abc", bad.url, { ASK_JEV_PROVIDER: "vercel" });
  bad.server.close();
  assert.match(err.error, /ASK_JEV_PROVIDER=typesafe/);
});

// --- Advisory hook (PreToolUse AskUserQuestion): Jev advises, never answers or blocks ---

import { HOOK_MARGIN_MS } from "../lib/jev.mjs";
import { ADVICE_BUDGET_MS } from "./ask-jev.mjs";

const advOpts = [{ label: "A", description: "a" }, { label: "B", description: "b" }];
const adviceAnswers = (p = 0.86) => ({ pick: { choice: "o0", probabilities: { o0: p } }, grounded: { probability: 0.9 } });

/** Stub provider: handler(body) → answers, or {status, body} for a failure; `hang` never responds. */
async function provider500Stub(handler) {
  const hits = { n: 0 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.n++;
      if (handler === "hang") return;
      const out = handler(JSON.parse(body));
      if (out?.status) {
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(JSON.stringify(out.body ?? { error: "x" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ answers: out }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { hits, url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections?.(); server.close(); } };
}

function advisoryEnv(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "askjev-adv-"));
  return { dir, log: join(dir, "jev.log"), env: { HOME: dir, ASK_JEV_LOG_FILE: join(dir, "jev.log"), ...extra } };
}

async function runAdvisory(input, url, { env: extra = {}, key = "vck_dummy", log } = {}) {
  const e = log ? { log, env: { HOME: dirname(log), ASK_JEV_LOG_FILE: log } } : advisoryEnv();
  const child = execFileAsync("node", ["hooks/ask-jev.mjs"], {
    env: { ...cleanEnv(), ...(key ? { ASK_JEV_API_KEY: key } : {}), ASK_JEV_GATEWAY_URL: url, ...e.env, ...extra },
    encoding: "utf8",
  });
  child.child.stdin.end(JSON.stringify(input));
  const stdout = (await child).stdout;
  const rows = existsSync(e.log) ? readFileSync(e.log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { stdout, json: stdout.trim() ? JSON.parse(stdout) : null, rows, log: e.log };
}

const hookInput = (questions, extra = {}) => ({
  tool_name: "AskUserQuestion", session_id: `s-${Math.random()}`, tool_use_id: `toolu_${Math.random().toString(36).slice(2)}`,
  transcript_path: transcript, tool_input: { questions }, ...extra,
});

/** The invariant: never a deny/allow decision, never answers/response anywhere in the output. */
function assertNeverAnswers(stdout) {
  assert.doesNotMatch(stdout, /"permissionDecision":"(deny|allow)"/);
  assert.doesNotMatch(stdout, /"answers"|"response"/);
  if (!stdout.trim()) return;
  const j = JSON.parse(stdout);
  assert.notEqual(j.hookSpecificOutput?.permissionDecision, "deny");
  assert.notEqual(j.hookSpecificOutput?.permissionDecision, "allow");
  assert.equal(j.hookSpecificOutput?.systemMessage, undefined, "systemMessage must be top-level");
  for (const k of ["answers", "response"]) assert.equal(Object.hasOwn(j.hookSpecificOutput?.updatedInput ?? {}, k), false);
}

test("advisory (message channel, default): top-level systemMessage only — no decision, no updatedInput", async () => {
  const stub1 = await provider500Stub(() => adviceAnswers(0.86));
  const input = hookInput([{ question: "Stack?", options: advOpts }]);
  const r = await runAdvisory(input, stub1.url);
  stub1.close();
  assertNeverAnswers(r.stdout);
  assert.deepEqual(Object.keys(r.json), ["systemMessage"]);
  assert.match(r.json.systemMessage, /^Jev đề xuất: A \(0\.86\) — a/);
  const adv = r.rows.find((e) => e.kind === "decision" && e.outcome === "advised");
  assert.equal(adv.invocation_id, input.tool_use_id);
  assert.equal(adv.session_id, input.session_id);
  assert.equal(adv.mode, "advisory");
  assert.equal(adv.display, "systemMessage");
  assert.deepEqual(adv.recommended, ["A"]);
  assert.equal(adv.strength, "strong");
  assert.equal(adv.advice_text, r.json.systemMessage);
  assert.equal(r.rows.find((e) => e.kind === "call").invocation_id, input.tool_use_id);
});

test("advisory (annotate channel): ask + annotated questions, no answers/response, same top-level systemMessage", async () => {
  const stub1 = await provider500Stub(() => adviceAnswers(0.86));
  const input = hookInput([{ question: "Stack?", header: "Stack", multiSelect: false, options: advOpts }]);
  input.tool_input.extra = "kept";
  const r = await runAdvisory(input, stub1.url, { env: { ASK_JEV_ADVICE_CHANNEL: "annotate" } });
  stub1.close();
  assertNeverAnswers(r.stdout);
  assert.equal(r.json.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(r.json.hookSpecificOutput.permissionDecision, "ask");
  const updated = r.json.hookSpecificOutput.updatedInput;
  assert.equal(updated.extra, "kept");
  assert.deepEqual(Object.keys(updated).sort(), ["extra", "questions"]);
  const [q] = updated.questions;
  assert.match(q.question, /^Stack\?\n\nJev đề xuất: A \(0\.86\) — a/);
  assert.equal(q.options[0].description, "a (Jev đề xuất)");
  assert.equal(q.options[1].description, "b");
  assert.equal(q.header, "Stack");
  assert.match(r.json.systemMessage, /^Jev đề xuất: A \(0\.86\)/);
  assert.equal(r.rows.find((e) => e.outcome === "advised").display, "updatedInput");
});

test("advisory: low confidence is still shown, marked weak", async () => {
  const stub1 = await provider500Stub(() => adviceAnswers(0.55));
  const r = await runAdvisory(hookInput([{ question: "Stack?", options: advOpts }]), stub1.url);
  stub1.close();
  assertNeverAnswers(r.stdout);
  assert.match(r.json.systemMessage, /^Jev nghiêng về: A \(0\.55\)/);
  assert.equal(r.rows.find((e) => e.outcome === "advised").strength, "weak");
});

test("advisory: destructive/personal-looking scores and AUTONOMY=safe never suppress or block — advice is still shown", async () => {
  const stub1 = await provider500Stub(() => ({ ...adviceAnswers(0.95), personal: { probability: 0.99 }, personal__mirror: { probability: 0.99 }, destructive: { probability: 0.99 }, destructive__mirror: { probability: 0.99 } }));
  for (const channel of ["message", "annotate"]) {
    const r = await runAdvisory(hookInput([{ question: `Delete prod DB? ${channel}`, options: advOpts }]), stub1.url, { env: { ASK_JEV_AUTONOMY: "safe", ASK_JEV_ADVICE_CHANNEL: channel } });
    assertNeverAnswers(r.stdout);
    assert.match(r.json.systemMessage, /^Jev đề xuất: A \(0\.95\)/);
  }
  stub1.close();
});

test("advisory: multiSelect shows the recommended set; multi-question output is indexed and annotates each question", async () => {
  const stub1 = await provider500Stub(({ questions }) => (questions.pick ? adviceAnswers(0.9) : { o0: { probability: 0.9 }, o1: { probability: 0.05 }, grounded: { probability: 0.9 } }));
  const questions = [{ question: "Single?", options: advOpts }, { question: "Multi?", multiSelect: true, options: advOpts }];
  const r = await runAdvisory(hookInput(questions), stub1.url, { env: { ASK_JEV_ADVICE_CHANNEL: "annotate" } });
  stub1.close();
  assertNeverAnswers(r.stdout);
  const lines = r.json.systemMessage.split("\n");
  assert.match(lines[0], /^\[1\/2\] Jev đề xuất: A \(0\.90\)/);
  assert.match(lines[1], /^\[2\/2\] Jev đề xuất: A \(0\.90\)/);
  const qs = r.json.hookSpecificOutput.updatedInput.questions;
  assert.equal(qs.length, 2);
  assert.equal(qs[1].options[0].description, "a (Jev đề xuất)");
  assert.equal(qs[1].options[1].description, "b");
  const rows = r.rows.filter((e) => e.outcome === "advised");
  assert.deepEqual(rows.map((e) => e.question_index).sort(), [0, 1]);
});

test("advisory: agent-authored label/reason text is stripped of bidi, zero-width and control characters", async () => {
  const stub1 = await provider500Stub(() => adviceAnswers(0.9));
  const bad = [{ label: "Re‮d​x\u0085y", description: "de‮sc​\nline2" }, { label: "B", description: "b" }];
  const r = await runAdvisory(hookInput([{ question: "q?", options: bad }]), stub1.url);
  stub1.close();
  assert.doesNotMatch(r.json.systemMessage, /[‮​\u0085\n]/);
});

test("advisory: provider 500 → question untouched (no updatedInput), visible 'không có đề xuất' note, provider_error + advice_unavailable rows", async () => {
  const stub1 = await provider500Stub(() => ({ status: 500 }));
  const input = hookInput([{ question: "Stack?", options: advOpts }]);
  const r = await runAdvisory(input, stub1.url, { env: { ASK_JEV_ADVICE_CHANNEL: "annotate" } });
  stub1.close();
  assertNeverAnswers(r.stdout);
  assert.deepEqual(Object.keys(r.json), ["systemMessage"]);
  assert.equal(r.json.systemMessage, "Jev: không có đề xuất (lỗi 500) — bạn tự quyết");
  assert.ok(r.rows.some((e) => e.kind === "provider_error" && e.error_class === "server" && e.invocation_id === input.tool_use_id));
  const row = r.rows.find((e) => e.outcome === "advice_unavailable");
  assert.equal(row.reason, "provider_error");
  assert.equal(row.note_shown, true);
});

test("advisory: provider timeout → note, no updatedInput, advice_unavailable{timeout}", { timeout: 30_000 }, async () => {
  const stub1 = await provider500Stub("hang");
  const r = await runAdvisory(hookInput([{ question: "Stack?", options: advOpts }]), stub1.url);
  stub1.close();
  assertNeverAnswers(r.stdout);
  assert.deepEqual(Object.keys(r.json), ["systemMessage"]);
  assert.match(r.json.systemMessage, /^Jev: không có đề xuất \(lỗi .+\) — bạn tự quyết$/);
  assert.equal(r.rows.find((e) => e.outcome === "advice_unavailable").reason, "timeout");
  assert.ok(r.rows.some((e) => e.kind === "provider_error"));
});

test("advisory: 402 billing → credits-exhausted note once per session; later failures in the session show the generic note", async () => {
  const stub1 = await provider500Stub(() => ({ status: 402, body: { error: "insufficient credits" } }));
  const session = `bill-${Math.random()}`;
  const { log } = advisoryEnv();
  const first = await runAdvisory(hookInput([{ question: "One?", options: advOpts }], { session_id: session }), stub1.url, { log });
  const second = await runAdvisory(hookInput([{ question: "Two?", options: advOpts }], { session_id: session }), stub1.url, { log });
  stub1.close();
  for (const r of [first, second]) {
    assertNeverAnswers(r.stdout);
    assert.deepEqual(Object.keys(r.json), ["systemMessage"]);
  }
  assert.match(first.json.systemMessage, /credits exhausted/);
  assert.doesNotMatch(second.json.systemMessage, /credits/);
  assert.match(second.json.systemMessage, /^Jev: không có đề xuất \(lỗi 402\)/);
  const perr = second.rows.filter((e) => e.kind === "provider_error");
  assert.deepEqual(perr.map((e) => [e.billing, e.notified_user]), [[true, true], [true, false]]);
  assert.equal(second.rows.filter((e) => e.outcome === "advice_unavailable" && e.reason === "billing").length, 2);
});

test("advisory: several questions failing with billing in one request → a single credits note", async () => {
  const stub1 = await provider500Stub(() => ({ status: 402, body: { error: "credits" } }));
  const r = await runAdvisory(hookInput([{ question: "One?", options: advOpts }, { question: "Two?", options: advOpts }]), stub1.url);
  stub1.close();
  assert.equal(r.json.systemMessage.split("\n").length, 1);
  assert.match(r.json.systemMessage, /credits exhausted/);
  assert.equal(r.rows.filter((e) => e.outcome === "advice_unavailable").length, 2);
});

test("advisory: missing option description / single option → no deny, no provider call, advice_unavailable row, silent", async () => {
  const stub1 = await provider500Stub(() => adviceAnswers());
  const missing = await runAdvisory(hookInput([{ question: "M?", options: [{ label: "A" }, { label: "B", description: "b" }] }]), stub1.url);
  const single = await runAdvisory(hookInput([{ question: "S?", options: [{ label: "A", description: "a" }] }]), stub1.url);
  stub1.close();
  assert.equal(stub1.hits.n, 0);
  for (const r of [missing, single]) {
    assertNeverAnswers(r.stdout);
    assert.equal(r.stdout, "");
  }
  assert.equal(missing.rows.find((e) => e.kind === "decision").reason, "missing_definition");
  assert.equal(single.rows.find((e) => e.kind === "decision").reason, "single_option");
  assert.equal(missing.rows.find((e) => e.kind === "decision").outcome, "advice_unavailable");
});

test("advisory: one unadvisable question does not silence advice for the others", async () => {
  const stub1 = await provider500Stub(() => adviceAnswers(0.9));
  const r = await runAdvisory(hookInput([{ question: "Bare?", options: [{ label: "A" }, { label: "B" }] }, { question: "Ok?", options: advOpts }]), stub1.url);
  stub1.close();
  assertNeverAnswers(r.stdout);
  assert.equal(r.json.systemMessage, "[2/2] Jev đề xuất: A (0.90) — a [grounded in your messages/past choices]");
});

test("advisory: no API key → silent, no provider call", async () => {
  const stub1 = await provider500Stub(() => adviceAnswers());
  const r = await runAdvisory(hookInput([{ question: "Stack?", options: advOpts }]), stub1.url, { key: null });
  stub1.close();
  assert.equal(r.stdout, "");
  assert.equal(stub1.hits.n, 0);
  assert.ok(r.rows.every((e) => e.kind === "decision" && e.reason === "no_key" && e.note_shown === false));
});

test("advisory: no usable conversation context → silent, advice_unavailable{no_context}", async () => {
  const stub1 = await provider500Stub(() => adviceAnswers());
  const r = await runAdvisory(hookInput([{ question: "Stack?", options: advOpts }], { transcript_path: "/dev/null" }), stub1.url);
  stub1.close();
  assert.equal(r.stdout, "");
  assert.equal(stub1.hits.n, 0);
  assert.equal(r.rows.find((e) => e.outcome === "advice_unavailable").reason, "no_context");
});

test("advisory: Paseo stand-down → one standdown row, empty stdout, no provider call", async () => {
  const stub1 = await provider500Stub(() => adviceAnswers());
  const input = hookInput([{ question: "Stack?", options: advOpts }]);
  const r = await runAdvisory(input, stub1.url, { env: { PASEO_AGENT_ID: "paseo-agent-1" } });
  stub1.close();
  assert.equal(r.stdout, "");
  assert.equal(stub1.hits.n, 0);
  const rows = r.rows.filter((e) => e.kind !== "call");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "standdown");
  assert.equal(rows[0].reason, "paseo");
  assert.equal(rows[0].gate, "ask");
  assert.equal(rows[0].invocation_id, input.tool_use_id);
});

test("advisory: duplicate registration lock → exactly one advice output, one provider call, one advice row", async () => {
  const stub1 = await provider500Stub(() => adviceAnswers(0.9));
  const input = hookInput([{ question: "Dup?", options: advOpts }]);
  const { log } = advisoryEnv();
  const first = await runAdvisory(input, stub1.url, { log });
  const second = await runAdvisory(input, stub1.url, { log });
  stub1.close();
  assert.match(first.json.systemMessage, /^Jev đề xuất/);
  assert.equal(second.stdout, "");
  assert.equal(stub1.hits.n, 1);
  assert.equal(second.rows.filter((e) => e.outcome === "advised").length, 1);
});

test("advisory: unknown ADVICE_CHANNEL falls back to the message channel", async () => {
  const stub1 = await provider500Stub(() => adviceAnswers(0.9));
  const r = await runAdvisory(hookInput([{ question: "Stack?", options: advOpts }]), stub1.url, { env: { ASK_JEV_ADVICE_CHANNEL: "bogus" } });
  stub1.close();
  assert.deepEqual(Object.keys(r.json), ["systemMessage"]);
});

test("advisory: the hook's provider budget + margin stays under every registered timeout", () => {
  const hooksJson = JSON.parse(readFileSync("hooks/hooks.json", "utf8"));
  const pre = hooksJson.hooks.PreToolUse.find((b) => b.matcher === "AskUserQuestion").hooks.find((h) => h.command.includes("ask-jev.mjs"));
  const selfRegister = Number(/timeout:\s*(\d+)/.exec(readFileSync("hooks/self-register.mjs", "utf8"))?.[1]);
  for (const seconds of [pre.timeout, selfRegister]) {
    assert.ok(Number.isFinite(seconds));
    assert.ok(ADVICE_BUDGET_MS + HOOK_MARGIN_MS <= seconds * 1000, `${ADVICE_BUDGET_MS}ms + margin must fit ${seconds}s`);
  }
});

test("advisory: no auto-answer path is left in the AskUserQuestion hooks", () => {
  for (const f of ["hooks/ask-jev.mjs", "hooks/ask-jev-answer.mjs"]) {
    const src = readFileSync(f, "utf8");
    assert.doesNotMatch(src, /permissionDecision\s*:\s*"(deny|allow)"/, f);
    assert.doesNotMatch(src, /interpretPick|interpretMulti\b|buildPickQuestions|decide\(/, f);
    assert.doesNotMatch(src, /\banswers\s*:/, f);
  }
});
