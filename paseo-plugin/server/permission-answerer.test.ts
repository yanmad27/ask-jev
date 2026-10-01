import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { registerPermissionAnswerer } from "./permission-answerer";
import { getStats } from "./log";
import requestedSingle from "./__fixtures__/requested-single.json" with { type: "json" };
import requestedMulti from "./__fixtures__/requested-multi.json" with { type: "json" };
import requestedMultiselect from "./__fixtures__/requested-multiselect.json" with { type: "json" };
import resolvedMultiselect from "./__fixtures__/resolved-multiselect.json" with { type: "json" };

// Hermetic env: a throwaway HOME (no real CLAUDE.md/settings.json bleeding in) and a
// per-test log file. No real Jev/typesafe network calls — global.fetch is always mocked.
let logFile: string;
before(() => {
  process.env.HOME = mkdtempSync(join(tmpdir(), "paseo-answerer-home-"));
  process.env.TYPESAFE_API_KEY = "tsk_test_dummy";
  delete process.env.ASK_JEV_PROVIDER;
});
const allContexts: MockPaseo[] = [];
beforeEach(() => {
  allContexts.length = 0;
  const g = globalThis as Record<symbol, unknown>;
  (g[Symbol.for("ask-jev.paseo.inflight")] as Map<string, unknown> | undefined)?.clear();
  (g[Symbol.for("ask-jev.paseo.billing-noted")] as Set<string> | undefined)?.clear();
  logFile = join(mkdtempSync(join(tmpdir(), "paseo-answerer-log-")), "jev.log");
  process.env.ASK_JEV_LOG_FILE = logFile;
});

// Advisory contract: respondToPermission is never called for a question, in any test.
afterEach(() => {
  for (const ctx of allContexts) assert.equal(ctx.responded.length, 0, "respondToPermission must never be called");
});

function readLog(): Array<Record<string, unknown>> {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function makeServer() {
  const handlers: Record<string, (event: unknown, context: unknown) => unknown> = {};
  const server = {
    on(name: string, handler: (event: unknown, context: unknown) => unknown) {
      handlers[name] = handler;
      return () => {
        delete handlers[name];
      };
    },
  };
  return { server: server as never, handlers };
}

interface MockPaseo {
  paseo: { agents: { ref(id: string): { timeline: { refetch: () => Promise<unknown>; append: (item: unknown) => Promise<unknown> }; respondToPermission: (opts: { requestId: string; response: unknown }) => Promise<void> } } };
  responded: Array<{ requestId: string; response: unknown }>;
  appended: unknown[];
}

function makeContext(
  timelineEntries: unknown[] | (() => Promise<unknown[]>),
  opts: { onRespond?: () => Promise<void> | void; appendGate?: Promise<void> } = {},
): MockPaseo {
  const responded: Array<{ requestId: string; response: unknown }> = [];
  const appended: unknown[] = [];
  const handle = {
    timeline: {
      refetch: async () => (typeof timelineEntries === "function" ? timelineEntries() : timelineEntries),
      append: async (item: unknown) => {
        if (opts.appendGate) await opts.appendGate;
        appended.push(item);
        return { seq: appended.length, epoch: "e1" };
      },
    },
    respondToPermission: async (respondOpts: { requestId: string; response: unknown }) => {
      // Simulates the daemon delivering agent.permission_resolved before (or instead of) letting
      // our own respondToPermission call return — the real race this plugin has to survive.
      if (opts.onRespond) await opts.onRespond();
      responded.push(respondOpts);
    },
  };
  const made = { paseo: { agents: { ref: () => handle } }, responded, appended };
  allContexts.push(made);
  return made;
}

const withUserMessage = [{ provider: "claude-worker", item: { type: "user_message", text: "please help me pick" } }];

function mockFetch(answersFor: (body: { questions: Record<string, unknown>; state: unknown }) => Record<string, unknown>) {
  const calls: Array<Record<string, unknown>> = [];
  (globalThis as { fetch?: unknown }).fetch = async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { questions: Record<string, unknown>; state: unknown };
    calls.push(body);
    return { ok: true, status: 200, json: async () => ({ answers: answersFor(body), model: "jev-latest" }), text: async () => "" };
  };
  return calls;
}

// Confident boolean answers: low personal/destructive, high grounded (irrelevant unless personal fires).
const SAFE_BOOLEANS = { personal: { noul: 0.1 }, destructive: { noul: 0.05 }, grounded: { noul: 0.9 } };


const AGENT = requestedSingle.agent;
const Q1 = requestedSingle.request.input.questions[0].question;
const SINGLE_PICK = { pick: { choice: "o0", probabilities: { o0: 0.95, o1: 0.05 } }, grounded: { noul: 0.9 } };

let seq = 0;
const freshRequest = <T extends { id: string }>(base: T): T => ({ ...base, id: `${base.id}-${++seq}` });
const resolvedEvent = (request: { id: string }, answers: Record<string, string>, behavior = "allow") => ({
  agent: AGENT,
  requestId: request.id,
  resolution: { behavior, updatedInput: { answers } },
});
const rowsOf = (kind: string, request?: { id: string }) => readLog().filter((e) => e.kind === kind && (!request || e.request_id === request.id));
const adviceData = (item: unknown) => (item as { data: Record<string, unknown> }).data;

function failingFetch(make: () => unknown) {
  let calls = 0;
  (globalThis as { fetch?: unknown }).fetch = async () => {
    calls++;
    return make();
  };
  return () => calls;
}
const httpError = (status: number, body = "") => ({ ok: false, status, headers: { get: () => null }, text: async () => body, json: async () => ({}) });

test("single question: one advice timeline item with the exact payload, decision row, nothing answered", async () => {
  const { server, handlers } = makeServer();
  const cleanup = registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = freshRequest(requestedSingle.request);
  const calls = mockFetch(() => SINGLE_PICK);

  await handlers["agent.permission_requested"]({ agent: AGENT, request }, ctx);

  assert.equal(calls.length, 1);
  assert.equal(ctx.appended.length, 1);
  const item = ctx.appended[0] as { type: string; kind: string; version: number; id: string; data: Record<string, unknown> };
  assert.equal(item.type, "plugin");
  assert.equal(item.kind, "ask-jev.advice");
  assert.equal(item.version, 1);
  assert.equal(typeof item.id, "string");
  assert.deepEqual(item.data, {
    text: 'Jev advice: "Red" (0.95) — option description: “A warm primary color [grounded in your messages/past choices]”',
    question: Q1,
    question_index: 0,
    question_count: 1,
    status: "advised",
    recommended: ["Red"],
    recommended_index: [0],
    confidence: 0.95,
    strength: "strong",
    reason: "A warm primary color [grounded in your messages/past choices]",
  });

  const decisions = rowsOf("decision", request);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].outcome, "advised");
  assert.equal(decisions[0].mode, "advisory");
  assert.deepEqual(decisions[0].recommended, ["Red"]);
  assert.equal(decisions[0].invocation_id, `${AGENT.id}:${request.id}`);
  assert.equal(decisions[0].schema, 2);
  assert.equal(decisions[0].source, "paseo");
  assert.equal(rowsOf("user_choice").length, 0);
  cleanup();
});

test("multi-question request: one advice item per question, each with its own decision row", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = freshRequest(requestedMulti.request);
  const [q1, q2] = requestedMulti.request.input.questions;
  mockFetch((body) => {
    const pending = (body.state as { pendingQuestion: string }).pendingQuestion;
    return pending === q1.question ? SINGLE_PICK : { pick: { choice: "o1", probabilities: { o0: 0.1, o1: 0.9 } }, grounded: { noul: 0.2 } };
  });

  await handlers["agent.permission_requested"]({ agent: requestedMulti.agent, request }, ctx);

  assert.equal(ctx.appended.length, 2);
  const [d1, d2] = ctx.appended.map(adviceData);
  assert.deepEqual([d1.question_index, d1.recommended], [0, ["Apple"]]);
  assert.deepEqual([d2.question_index, d2.recommended, d2.question], [1, ["Winter"], q2.question]);
  assert.deepEqual([d1.question, d1.question_count], ["B0-SPIKE-B: pick a fruit", 2]);
  assert.match(String(d1.text), /^Jev advice: "Apple"/);
  assert.match(String(d2.text), /no direct statement from you — a guess/);
  const decisions = rowsOf("decision", request);
  assert.deepEqual(decisions.map((d) => [d.question_index, d.outcome]), [[0, "advised"], [1, "advised"]]);
});

test("multiSelect: advice item recommends every applying option", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = freshRequest(requestedMultiselect.request);
  mockFetch(() => ({ o0: { noul: 0.9 }, o1: { noul: 0.05 }, o2: { noul: 0.9 }, o3: { noul: 0.05 }, grounded: { noul: 0.9 } }));

  await handlers["agent.permission_requested"]({ agent: requestedMultiselect.agent, request }, ctx);

  assert.equal(ctx.appended.length, 1);
  const data = adviceData(ctx.appended[0]);
  assert.deepEqual(data.recommended, ["Apple", "Cherry"]);
  assert.equal(data.status, "advised");
  assert.match(String(data.text), /^Jev advice: "Apple", "Cherry" \(0\.9\d?\)/);
  assert.deepEqual(rowsOf("decision", request)[0].recommended, ["Apple", "Cherry"]);
});

test("provider 402: unavailable item says credits exhausted once per session, then a generic note; provider_error rows written", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  failingFetch(() => httpError(402, "payment required"));

  const first = freshRequest(requestedSingle.request);
  await handlers["agent.permission_requested"]({ agent: AGENT, request: first }, ctx);
  const second = freshRequest(requestedSingle.request);
  await handlers["agent.permission_requested"]({ agent: AGENT, request: second }, ctx);

  assert.equal(ctx.appended.length, 2);
  const [a, b] = ctx.appended.map(adviceData);
  assert.equal(a.status, "unavailable");
  assert.deepEqual([a.recommended, a.confidence, a.reason], [[], null, "billing"]);
  assert.match(String(a.text), /Jev advice unavailable — Jev credits are exhausted\./);
  assert.doesNotMatch(String(b.text), /credits/);
  assert.match(String(b.text), /^Jev advice unavailable/);

  const errs = rowsOf("provider_error");
  assert.equal(errs.length, 2);
  assert.deepEqual(errs.map((e) => [e.error_class, e.billing, e.notified_user, e.fail_open]), [["billing", true, true, true], ["billing", true, false, true]]);
  const decisions = rowsOf("decision");
  assert.deepEqual(decisions.map((d) => [d.outcome, d.reason, d.note_shown]), [["advice_unavailable", "billing", true], ["advice_unavailable", "billing", true]]);
});

test("provider timeout: generic unavailable item, provider_error timeout, no retry storm", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = freshRequest(requestedSingle.request);
  const count = failingFetch(() => {
    throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  });

  await handlers["agent.permission_requested"]({ agent: AGENT, request }, ctx);

  assert.equal(count(), 1);
  assert.equal(ctx.appended.length, 1);
  assert.match(String(adviceData(ctx.appended[0]).text), /^Jev advice unavailable — Jev did not answer in time\./);
  assert.equal(rowsOf("provider_error", request)[0].error_class, "timeout");
  assert.equal(rowsOf("decision", request)[0].reason, "timeout");
});

test("provider 500: generic unavailable item and provider_error server", { timeout: 30_000 }, async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = freshRequest(requestedSingle.request);
  failingFetch(() => httpError(500, "boom"));

  await handlers["agent.permission_requested"]({ agent: AGENT, request }, ctx);

  assert.equal(ctx.appended.length, 1);
  const data = adviceData(ctx.appended[0]);
  assert.deepEqual([data.status, data.reason], ["unavailable", "provider_error"]);
  assert.match(String(data.text), /^Jev advice unavailable — the Jev request failed\./);
  const err = rowsOf("provider_error", request)[0];
  assert.deepEqual([err.error_class, err.http_status, err.billing, err.fail_open], ["server", 500, false, true]);
});

test("one failing question does not hide the other's advice", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = freshRequest(requestedMulti.request);
  const q1 = requestedMulti.request.input.questions[0].question;
  (globalThis as { fetch?: unknown }).fetch = async (_u: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { state: { pendingQuestion: string } };
    if (body.state.pendingQuestion !== q1) return httpError(402, "credit");
    return { ok: true, status: 200, json: async () => ({ answers: SINGLE_PICK, model: "m" }), text: async () => "" };
  };

  await handlers["agent.permission_requested"]({ agent: requestedMulti.agent, request }, ctx);

  assert.deepEqual(ctx.appended.map((i) => adviceData(i).status), ["advised", "unavailable"]);
});

test("missing option descriptions: unavailable item, no provider call", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const calls = mockFetch(() => SINGLE_PICK);
  const request = freshRequest({ ...requestedSingle.request, input: { questions: [{ question: "q?", options: [{ label: "A", description: "a" }, { label: "B" }] }] } });

  await handlers["agent.permission_requested"]({ agent: AGENT, request }, ctx);

  assert.equal(calls.length, 0);
  assert.equal(ctx.appended.length, 1);
  assert.equal(adviceData(ctx.appended[0]).reason, "missing_definition");
  assert.equal(rowsOf("decision", request)[0].reason, "missing_definition");
});

test("no API key: silent (decision row only, no timeline item, no provider call)", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const calls = mockFetch(() => SINGLE_PICK);
  const request = freshRequest(requestedSingle.request);
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  const savedHome = process.env.HOME;
  process.env.HOME = mkdtempSync(join(tmpdir(), "paseo-nokey-home-"));
  try {
    await handlers["agent.permission_requested"]({ agent: AGENT, request }, ctx);
  } finally {
    process.env.TYPESAFE_API_KEY = saved;
    process.env.HOME = savedHome;
  }
  assert.equal(calls.length, 0);
  assert.equal(ctx.appended.length, 0);
  assert.equal(rowsOf("decision", request)[0].reason, "no_key");
});

test("non-question permission kinds are ignored entirely — no Jev call, no tracking, silent resolve", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const calls = mockFetch(() => ({}));
  const request = { ...requestedSingle.request, id: "permission-tool-kind-test", kind: "tool" };

  await handlers["agent.permission_requested"]({ agent: AGENT, request }, ctx);
  await handlers["agent.permission_resolved"](resolvedEvent(request, {}), ctx);

  assert.equal(calls.length, 0);
  assert.equal(ctx.appended.length, 0);
  assert.equal(rowsOf("outcome").length, 0);
});

test("duplicate delivery (two installed plugin copies) makes exactly one Jev call and one item", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const calls = mockFetch(() => SINGLE_PICK);
  const request = freshRequest(requestedSingle.request);

  await Promise.all([handlers["agent.permission_requested"]({ agent: AGENT, request }, ctx), handlers["agent.permission_requested"]({ agent: AGENT, request }, ctx)]);

  assert.equal(calls.length, 1);
  assert.equal(ctx.appended.length, 1);
});

test("outcome, single: human agrees with Jev — row links to the advice by invocation_id", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = freshRequest(requestedSingle.request);
  mockFetch(() => SINGLE_PICK);

  await handlers["agent.permission_requested"]({ agent: AGENT, request }, ctx);
  await handlers["agent.permission_resolved"](resolvedEvent(request, { [Q1]: "Red" }), ctx);

  const [outcome] = rowsOf("outcome", request);
  assert.equal(outcome.agreement, "agree");
  assert.deepEqual([outcome.chosen, outcome.recommended, outcome.recommended_confidence, outcome.advice_shown, outcome.kind_of_answer], [["Red"], ["Red"], 0.95, true, "option"]);
  const [decision] = rowsOf("decision", request);
  assert.equal(outcome.invocation_id, decision.invocation_id);
  assert.equal(outcome.invocation_id, `${AGENT.id}:${request.id}`);
  assert.equal(outcome.question_index, 0);
  assert.equal(outcome.cwd, AGENT.cwd);
  assert.equal(rowsOf("user_choice").length, 0);
});

test("outcome, single: human picks another option → disagree", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = freshRequest(requestedSingle.request);
  mockFetch(() => SINGLE_PICK);

  await handlers["agent.permission_requested"]({ agent: AGENT, request }, ctx);
  await handlers["agent.permission_resolved"](resolvedEvent(request, { [Q1]: "Blue" }), ctx);

  const [outcome] = rowsOf("outcome", request);
  assert.deepEqual([outcome.agreement, outcome.chosen, outcome.recommended], ["disagree", ["Blue"], ["Red"]]);
});

test("outcome, multiSelect: same set agrees, overlap is partial, disjoint disagrees", async () => {
  const run = async (picked: string) => {
    const { server, handlers } = makeServer();
    const cleanup = registerPermissionAnswerer(server);
    const ctx = makeContext(withUserMessage);
    const request = freshRequest(requestedMultiselect.request);
    mockFetch(() => ({ o0: { noul: 0.9 }, o1: { noul: 0.05 }, o2: { noul: 0.9 }, o3: { noul: 0.05 }, grounded: { noul: 0.9 } }));
    await handlers["agent.permission_requested"]({ agent: requestedMultiselect.agent, request }, ctx);
    const q = requestedMultiselect.request.input.questions[0].question;
    await handlers["agent.permission_resolved"]({ agent: requestedMultiselect.agent, requestId: request.id, resolution: { behavior: "allow", updatedInput: { answers: { [q]: picked } } } }, ctx);
    cleanup();
    return rowsOf("outcome", request)[0];
  };
  assert.equal((await run("Apple, Cherry")).agreement, "agree");
  assert.equal((await run("Cherry, Apple")).agreement, "agree");
  const partial = await run("Apple, Banana");
  assert.deepEqual([partial.agreement, partial.chosen], ["partial", ["Apple", "Banana"]]);
  assert.equal((await run("Banana, Date")).agreement, "disagree");
});

test("outcome, multiSelect: the daemon-captured resolved fixture is attributed against the advice", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  mockFetch(() => ({ o0: { noul: 0.9 }, o1: { noul: 0.05 }, o2: { noul: 0.9 }, o3: { noul: 0.05 }, grounded: { noul: 0.9 } }));
  await handlers["agent.permission_requested"]({ agent: requestedMultiselect.agent, request: requestedMultiselect.request }, ctx);
  await handlers["agent.permission_resolved"](resolvedMultiselect, ctx);
  const [outcome] = rowsOf("outcome", requestedMultiselect.request);
  assert.deepEqual([outcome.agreement, outcome.chosen], ["agree", ["Apple", "Cherry"]]);
});

test("outcome, free text: kept verbatim, agreement free_text, advice_shown true", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = freshRequest(requestedSingle.request);
  mockFetch(() => SINGLE_PICK);

  await handlers["agent.permission_requested"]({ agent: AGENT, request }, ctx);
  await handlers["agent.permission_resolved"](resolvedEvent(request, { [Q1]: "Green, actually" }), ctx);

  const [outcome] = rowsOf("outcome", request);
  assert.deepEqual([outcome.kind_of_answer, outcome.agreement, outcome.chosen, outcome.advice_shown], ["free_text", "free_text", ["Green, actually"], true]);
});

test("outcome, multiSelect with a typed extra: free_text, both parts kept", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = freshRequest(requestedMultiselect.request);
  mockFetch(() => ({ o0: { noul: 0.9 }, o1: { noul: 0.05 }, o2: { noul: 0.05 }, o3: { noul: 0.05 }, grounded: { noul: 0.9 } }));
  await handlers["agent.permission_requested"]({ agent: requestedMultiselect.agent, request }, ctx);
  const q = requestedMultiselect.request.input.questions[0].question;
  await handlers["agent.permission_resolved"]({ agent: requestedMultiselect.agent, requestId: request.id, resolution: { behavior: "allow", updatedInput: { answers: { [q]: "Apple, Elderberry" } } } }, ctx);
  const [outcome] = rowsOf("outcome", request);
  assert.deepEqual([outcome.kind_of_answer, outcome.chosen, outcome.agreement], ["free_text", ["Apple", "Elderberry"], "free_text"]);
});

test("outcome, resolved without advice (provider failed): no_advice, chosen still logged", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = freshRequest(requestedSingle.request);
  failingFetch(() => httpError(402, "credit"));

  await handlers["agent.permission_requested"]({ agent: AGENT, request }, ctx);
  await handlers["agent.permission_resolved"](resolvedEvent(request, { [Q1]: "Blue" }), ctx);

  const [outcome] = rowsOf("outcome", request);
  assert.deepEqual([outcome.agreement, outcome.advice_shown, outcome.recommended, outcome.chosen], ["no_advice", false, null, ["Blue"]]);
});

test("outcome, multi-question: one outcome row per answered question with its own agreement", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = freshRequest(requestedMulti.request);
  const [q1, q2] = requestedMulti.request.input.questions;
  mockFetch(() => SINGLE_PICK);
  await handlers["agent.permission_requested"]({ agent: requestedMulti.agent, request }, ctx);
  await handlers["agent.permission_resolved"]({ agent: requestedMulti.agent, requestId: request.id, resolution: { behavior: "allow", updatedInput: { answers: { [q1.question]: "Apple", [q2.question]: "Winter" } } } }, ctx);
  assert.deepEqual(rowsOf("outcome", request).map((o) => [o.question_index, o.agreement]), [[0, "agree"], [1, "disagree"]]);
});

test("a denied/cancelled question writes no outcome and stops tracking", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = freshRequest(requestedSingle.request);
  mockFetch(() => SINGLE_PICK);
  await handlers["agent.permission_requested"]({ agent: AGENT, request }, ctx);
  await handlers["agent.permission_resolved"](resolvedEvent(request, {}, "deny"), ctx);
  assert.equal(rowsOf("outcome").length, 0);
  await handlers["agent.permission_resolved"](resolvedEvent(request, { [Q1]: "Red" }), ctx);
  assert.equal(rowsOf("outcome").length, 0, "entry was dropped on the first resolution");
});

test("RACE: human resolves while the timeline fetch is pending — no advice, no failure item, outcome kept as no_advice", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  let release!: (v: unknown[]) => void;
  const ctx = makeContext(() => new Promise<unknown[]>((r) => (release = r)));
  const calls = mockFetch(() => SINGLE_PICK);
  const request = freshRequest(requestedSingle.request);

  const pending = handlers["agent.permission_requested"]({ agent: AGENT, request }, ctx);
  await handlers["agent.permission_resolved"](resolvedEvent(request, { [Q1]: "Blue" }), ctx);
  release(withUserMessage);
  await pending;

  assert.equal(calls.length, 0, "no provider call for an already-resolved request");
  assert.equal(ctx.appended.length, 0);
  assert.equal(rowsOf("decision", request).length, 0);
  const [outcome] = rowsOf("outcome", request);
  assert.deepEqual([outcome.agreement, outcome.advice_shown, outcome.chosen], ["no_advice", false, ["Blue"]]);
});

test("RACE: human resolves while the provider call is pending — late advice is dropped, outcome kept", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = freshRequest(requestedSingle.request);
  let releaseFetch!: () => void;
  const gate = new Promise<void>((r) => (releaseFetch = r));
  (globalThis as { fetch?: unknown }).fetch = async () => {
    await gate;
    return { ok: true, status: 200, json: async () => ({ answers: SINGLE_PICK, model: "m" }), text: async () => "" };
  };

  const pending = handlers["agent.permission_requested"]({ agent: AGENT, request }, ctx);
  await new Promise((r) => setTimeout(r, 10));
  await handlers["agent.permission_resolved"](resolvedEvent(request, { [Q1]: "Red" }), ctx);
  releaseFetch();
  await pending;

  assert.equal(ctx.appended.length, 0);
  assert.equal(rowsOf("decision", request).length, 0);
  assert.equal(rowsOf("outcome", request)[0].agreement, "no_advice");
  assert.ok(readLog().some((e) => e.kind === "diagnostic" && e.outcome === "advice_discarded" && e.request_id === request.id));
});

test("RACE: human resolves before a provider FAILURE would be shown — no unavailable item, outcome kept", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = freshRequest(requestedSingle.request);
  let releaseFetch!: () => void;
  const gate = new Promise<void>((r) => (releaseFetch = r));
  (globalThis as { fetch?: unknown }).fetch = async () => {
    await gate;
    return httpError(402, "payment required");
  };

  const pending = handlers["agent.permission_requested"]({ agent: AGENT, request }, ctx);
  await new Promise((r) => setTimeout(r, 10));
  await handlers["agent.permission_resolved"](resolvedEvent(request, { [Q1]: "Blue" }), ctx);
  releaseFetch();
  await pending;

  assert.equal(ctx.appended.length, 0);
  assert.equal(rowsOf("decision", request).length, 0, "no stale advice_unavailable decision either");
  assert.equal(rowsOf("provider_error", request).length, 1, "the failure itself is still recorded");
  assert.deepEqual([rowsOf("outcome", request)[0].agreement, rowsOf("outcome", request)[0].chosen], ["no_advice", ["Blue"]]);
});

test("RACE: human resolves while the FIRST append is still pending — outcome is no_advice for every question, no decision row, nothing appended afterwards", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  let releaseAppend!: () => void;
  const appendGate = new Promise<void>((r) => (releaseAppend = r));
  const ctx = makeContext(withUserMessage, { appendGate });
  const request = freshRequest(requestedMulti.request);
  const [q1, q2] = requestedMulti.request.input.questions;
  mockFetch(() => SINGLE_PICK);

  const pending = handlers["agent.permission_requested"]({ agent: requestedMulti.agent, request }, ctx);
  await new Promise((r) => setTimeout(r, 20)); // first append is now blocked inside timeline.append
  await handlers["agent.permission_resolved"]({ agent: requestedMulti.agent, requestId: request.id, resolution: { behavior: "allow", updatedInput: { answers: { [q1.question]: "Apple", [q2.question]: "Summer" } } } }, ctx);
  releaseAppend();
  await pending;

  assert.equal(ctx.appended.length, 1, "only the append already in flight lands; the second item is never attempted");
  const outcomes = rowsOf("outcome", request);
  assert.deepEqual(outcomes.map((o) => [o.agreement, o.advice_shown, o.recommended]), [["no_advice", false, null], ["no_advice", false, null]]);
  assert.equal(rowsOf("decision", request).length, 0, "no advised decision for advice the human never saw");
  assert.ok(readLog().some((e) => e.kind === "diagnostic" && e.outcome === "advice_discarded" && e.reason === "resolved_during_append"));
});

test("an append that COMPLETED before resolution counts as shown for that question only", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = freshRequest(requestedMulti.request);
  const [q1, q2] = requestedMulti.request.input.questions;
  mockFetch(() => SINGLE_PICK);
  const handle = ctx.paseo.agents.ref(AGENT.id);
  const realAppend = handle.timeline.append;
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((r) => (releaseSecond = r));
  let n = 0;
  handle.timeline.append = async (item: unknown) => {
    if (++n === 2) await secondGate;
    return realAppend(item);
  };

  const pending = handlers["agent.permission_requested"]({ agent: requestedMulti.agent, request }, ctx);
  await new Promise((r) => setTimeout(r, 20));
  await handlers["agent.permission_resolved"]({ agent: requestedMulti.agent, requestId: request.id, resolution: { behavior: "allow", updatedInput: { answers: { [q1.question]: "Apple", [q2.question]: "Summer" } } } }, ctx);
  releaseSecond();
  await pending;

  assert.deepEqual(rowsOf("outcome", request).map((o) => o.agreement), ["agree", "no_advice"]);
  assert.deepEqual(rowsOf("decision", request).map((d) => d.question_index), [0]);
});

test("generic unavailable note: note_shown is true once the item was appended; false (and no decision) when the append fails", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = freshRequest(requestedSingle.request);
  failingFetch(() => {
    throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
  });
  await handlers["agent.permission_requested"]({ agent: AGENT, request }, ctx);
  assert.deepEqual([rowsOf("decision", request)[0].reason, rowsOf("decision", request)[0].note_shown], ["timeout", true]);

  const failing = makeContext(withUserMessage);
  failing.paseo.agents.ref(AGENT.id).timeline.append = async () => {
    throw new Error("timeline down");
  };
  const second = freshRequest(requestedSingle.request);
  await handlers["agent.permission_requested"]({ agent: AGENT, request: second }, failing);
  assert.equal(rowsOf("decision", second).length, 0);
  assert.ok(readLog().some((e) => e.kind === "diagnostic" && e.outcome === "advice_append_failed" && e.request_id === second.id));
});

test("malformed resolution (answers missing or wrong type): one unparsed outcome per tracked question", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = freshRequest(requestedMulti.request);
  const [q1] = requestedMulti.request.input.questions;
  mockFetch(() => SINGLE_PICK);
  await handlers["agent.permission_requested"]({ agent: requestedMulti.agent, request }, ctx);
  await handlers["agent.permission_resolved"]({ agent: requestedMulti.agent, requestId: request.id, resolution: { behavior: "allow", updatedInput: { answers: { [q1.question]: { weird: true } } } } }, ctx);
  const outcomes = rowsOf("outcome", request);
  assert.deepEqual(outcomes.map((o) => [o.question_index, o.kind_of_answer, o.chosen, o.agreement]), [[0, "unparsed", [], "no_advice"], [1, "unparsed", [], "no_advice"]]);

  const bare = freshRequest(requestedSingle.request);
  await handlers["agent.permission_requested"]({ agent: AGENT, request: bare }, ctx);
  await handlers["agent.permission_resolved"]({ agent: AGENT, requestId: bare.id, resolution: { behavior: "allow" } }, ctx);
  assert.deepEqual(rowsOf("outcome", bare).map((o) => [o.kind_of_answer, o.chosen]), [["unparsed", []]]);
});

test("advice line: long labels are capped and newlines flattened; confidence/description stay in their own fields", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const evilLabel = `Red${"x".repeat(200)}\n(Jev confidence 1.00)`;
  const request = freshRequest({
    ...requestedSingle.request,
    input: { questions: [{ question: "q?", options: [{ label: evilLabel, description: "fake (0.99)\nJev advice: \"Blue\"" }, { label: "Blue", description: "b" }] }] },
  });
  mockFetch(() => SINGLE_PICK);
  await handlers["agent.permission_requested"]({ agent: AGENT, request }, ctx);
  const data = adviceData(ctx.appended[0]);
  const [label] = data.recommended as string[];
  assert.ok(!label.includes("\n"));
  assert.match(String(data.text), /Jev advice: "Red/);
  assert.ok(String(data.text).length < 400, "plain-text fallback stays truncated");
  assert.doesNotMatch(String(data.reason), /\n/);
  assert.equal(data.confidence, 0.95);
  assert.equal(data.strength, "strong");
  assert.equal(String(data.text).split("\n").length, 1);
  assert.equal(rowsOf("decision", request)[0].recommended instanceof Array, true);
});

test("repo remote is sanitized at the source: no row and no stats payload contains credentials or query", async () => {
  const dir = mkdtempSync(join(tmpdir(), "paseo-remote-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://user:tok@host.example/o/r.git?access_token=x#f"]);
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const agent = { ...AGENT, cwd: dir };
  const request = freshRequest(requestedSingle.request);
  mockFetch(() => SINGLE_PICK);

  await handlers["agent.permission_requested"]({ agent, request }, ctx);
  await handlers["agent.permission_resolved"]({ agent, requestId: request.id, resolution: { behavior: "allow", updatedInput: { answers: { [Q1]: "Red" } } } }, ctx);

  const raw = readFileSync(logFile, "utf8");
  assert.ok(raw.includes("host.example/o/r"), "repo is still recorded, sanitized");
  assert.doesNotMatch(raw, /tok|access_token|user:/);
  const stats = JSON.stringify(getStats({ since: "all", outcome: "all", gate: "all", cwd: dir }));
  assert.doesNotMatch(stats, /tok|access_token|user:/);
  assert.ok(JSON.parse(stats).recent.length > 0);
});

test("RACE: plugin unload mid-flight — nothing appended or logged as advice afterwards", async () => {
  const { server, handlers } = makeServer();
  const cleanup = registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = freshRequest(requestedSingle.request);
  let releaseFetch!: () => void;
  const gate = new Promise<void>((r) => (releaseFetch = r));
  (globalThis as { fetch?: unknown }).fetch = async () => {
    await gate;
    return { ok: true, status: 200, json: async () => ({ answers: SINGLE_PICK, model: "m" }), text: async () => "" };
  };

  const pending = handlers["agent.permission_requested"]({ agent: AGENT, request }, ctx);
  await new Promise((r) => setTimeout(r, 10));
  cleanup();
  releaseFetch();
  await pending;

  assert.equal(ctx.appended.length, 0);
  assert.equal(rowsOf("decision", request).length, 0);
  assert.equal(Object.keys(handlers).length, 0);
});

test("unload deletes this instance's tracked entries so a fresh instance can process the same request", async () => {
  const { server, handlers } = makeServer();
  const cleanupA = registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = freshRequest(requestedSingle.request);
  const first = mockFetch(() => SINGLE_PICK);
  await handlers["agent.permission_requested"]({ agent: AGENT, request }, ctx);
  assert.equal(first.length, 1);

  cleanupA();
  registerPermissionAnswerer(server);
  const second = mockFetch(() => SINGLE_PICK);
  await handlers["agent.permission_requested"]({ agent: AGENT, request }, ctx);
  assert.equal(second.length, 1, "not skipped as an already-tracked duplicate");
});

test("TTL sweep: an entry whose human never answered is evicted (no unbounded growth) and a late resolve is a no-op", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = freshRequest(requestedSingle.request);
  mockFetch(() => SINGLE_PICK);
  const map = (globalThis as Record<symbol, unknown>)[Symbol.for("ask-jev.paseo.inflight")] as Map<string, unknown>;

  process.env.ASK_JEV_PASEO_TTL_MS = "10";
  try {
    await handlers["agent.permission_requested"]({ agent: AGENT, request }, ctx);
    assert.equal(map.size, 1);
    await new Promise((r) => setTimeout(r, 20));
    await handlers["agent.permission_requested"]({ agent: AGENT, request: { ...request, id: "permission-sweep-trigger", kind: "tool" } }, ctx);
  } finally {
    delete process.env.ASK_JEV_PASEO_TTL_MS;
  }

  assert.equal(map.size, 0);
  assert.ok(readLog().some((e) => e.kind === "diagnostic" && e.outcome === "unresolved_expired" && e.request_id === request.id));
  await handlers["agent.permission_resolved"](resolvedEvent(request, { [Q1]: "Red" }), ctx);
  assert.equal(rowsOf("outcome").length, 0);
});

test("a pending question survives well past the old confirmation window — a late human answer still yields an outcome", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = freshRequest(requestedSingle.request);
  mockFetch(() => SINGLE_PICK);

  await handlers["agent.permission_requested"]({ agent: AGENT, request }, ctx);
  await new Promise((r) => setTimeout(r, 30));
  await handlers["agent.permission_requested"]({ agent: AGENT, request: { ...request, id: "permission-other-tool", kind: "tool" } }, ctx);
  await handlers["agent.permission_resolved"](resolvedEvent(request, { [Q1]: "Red" }), ctx);

  assert.equal(rowsOf("outcome", request)[0].agreement, "agree");
});

test("a failing timeline.append is logged and the outcome treats the advice as not shown", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const handle = ctx.paseo.agents.ref(AGENT.id);
  handle.timeline.append = async () => {
    throw new Error("timeline down");
  };
  const request = freshRequest(requestedSingle.request);
  mockFetch(() => SINGLE_PICK);

  await handlers["agent.permission_requested"]({ agent: AGENT, request }, ctx);
  await handlers["agent.permission_resolved"](resolvedEvent(request, { [Q1]: "Red" }), ctx);

  assert.ok(readLog().some((e) => e.kind === "diagnostic" && e.outcome === "advice_append_failed"));
  assert.deepEqual([rowsOf("outcome", request)[0].advice_shown, rowsOf("outcome", request)[0].agreement], [false, "no_advice"]);
});

test("options sharing a 70-char prefix stay distinguishable: data carries the full label and the option index", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const prefix = "P".repeat(70);
  const request = freshRequest({
    ...requestedSingle.request,
    input: { questions: [{ question: "q?", options: [{ label: `${prefix} alpha`, description: "a" }, { label: `${prefix} beta\u0007`, description: "b" }] }] },
  });
  mockFetch(() => ({ pick: { choice: "o1", probabilities: { o0: 0.1, o1: 0.9 } }, grounded: { noul: 0.9 } }));
  await handlers["agent.permission_requested"]({ agent: AGENT, request }, ctx);
  const data = adviceData(ctx.appended[0]);
  assert.deepEqual(data.recommended, [`${prefix} beta`]);
  assert.deepEqual(data.recommended_index, [1]);
  assert.ok(String(data.text).length < 400);
  await handlers["agent.permission_resolved"](resolvedEvent(request, { "q?": `${prefix} beta\u0007` }), ctx);
  assert.equal(rowsOf("outcome", request)[0].agreement, "agree");
});

test("advice data and text strip bidi overrides, zero-width and C1 control characters from agent-authored text", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const label = "Re\u202Ed\u200B\u0085x\u2066y\uFEFF";
  const request = freshRequest({
    ...requestedSingle.request,
    input: { questions: [{ question: "q\u202E?", options: [{ label, description: "de\u202Esc\u200B" }, { label: "Blue", description: "b" }] }] },
  });
  mockFetch(() => SINGLE_PICK);
  await handlers["agent.permission_requested"]({ agent: AGENT, request }, ctx);
  const data = adviceData(ctx.appended[0]);
  assert.deepEqual(data.recommended, ["Redxy"]);
  assert.equal(data.reason, "desc [grounded in your messages/past choices]");
  assert.equal(data.question, "q?");
  assert.doesNotMatch(JSON.stringify(data), /[\u0080-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/);
});
