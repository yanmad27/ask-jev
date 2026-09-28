import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerPermissionAnswerer } from "./permission-answerer";
import requestedSingle from "./__fixtures__/requested-single.json" with { type: "json" };
import requestedMulti from "./__fixtures__/requested-multi.json" with { type: "json" };
import requestedMultiselect from "./__fixtures__/requested-multiselect.json" with { type: "json" };
import requestedPartial from "./__fixtures__/requested-partial.json" with { type: "json" };

// Hermetic env: a throwaway HOME (no real CLAUDE.md/settings.json bleeding in) and a
// per-test log file. No real Jev/typesafe network calls — global.fetch is always mocked.
let logFile: string;
before(() => {
  process.env.HOME = mkdtempSync(join(tmpdir(), "paseo-answerer-home-"));
  process.env.TYPESAFE_API_KEY = "tsk_test_dummy";
  delete process.env.ASK_JEV_PROVIDER;
});
beforeEach(() => {
  logFile = join(mkdtempSync(join(tmpdir(), "paseo-answerer-log-")), "jev.log");
  process.env.ASK_JEV_LOG_FILE = logFile;
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

function makeContext(timelineEntries: unknown[] | (() => Promise<unknown[]>), respondFails = false): MockPaseo {
  const responded: Array<{ requestId: string; response: unknown }> = [];
  const appended: unknown[] = [];
  const handle = {
    timeline: {
      refetch: async () => (typeof timelineEntries === "function" ? timelineEntries() : timelineEntries),
      append: async (item: unknown) => {
        appended.push(item);
        return { seq: appended.length, epoch: "e1" };
      },
    },
    respondToPermission: async (opts: { requestId: string; response: unknown }) => {
      if (respondFails) throw new Error("respond failed");
      responded.push(opts);
    },
  };
  return { paseo: { agents: { ref: () => handle } }, responded, appended };
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

test("confident single-select: one respondToPermission with the picked label, decision + timeline logged", async () => {
  const { server, handlers } = makeServer();
  const cleanup = registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const calls = mockFetch(() => ({ pick: { choice: "o0", probabilities: { o0: 0.95, o1: 0.05 } }, ...SAFE_BOOLEANS }));

  const event = { agent: requestedSingle.agent, request: requestedSingle.request };
  await handlers["agent.permission_requested"](event, ctx);

  assert.equal(calls.length, 1);
  assert.equal(ctx.responded.length, 1);
  assert.deepEqual(ctx.responded[0], {
    requestId: requestedSingle.request.id,
    response: { behavior: "allow", updatedInput: { answers: { [requestedSingle.request.input.questions[0].question]: "Red" } } },
  });
  assert.equal(ctx.appended.length, 1);
  assert.match((ctx.appended[0] as { data: { text: string } }).data.text, /Jev chose "Red" \(0\.95\)/);

  const decisions = readLog().filter((e) => e.kind === "decision" && e.request_id === requestedSingle.request.id);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].outcome, "answered");
  assert.equal(decisions[0].source, "paseo");
  assert.equal(decisions[0].agent, requestedSingle.agent.id);

  cleanup();
});

test("confident multi-question request: a single respond carries answers for both questions", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const [q1, q2] = requestedMulti.request.input.questions;
  mockFetch((body) => {
    const pending = (body.state as { pendingQuestion: string }).pendingQuestion;
    return { pick: { choice: "o0", probabilities: { o0: 0.95, o1: 0.05 } }, ...SAFE_BOOLEANS, __which: pending };
  });

  await handlers["agent.permission_requested"]({ agent: requestedMulti.agent, request: requestedMulti.request }, ctx);

  assert.equal(ctx.responded.length, 1);
  const answers = (ctx.responded[0].response as { updatedInput: { answers: Record<string, string> } }).updatedInput.answers;
  assert.equal(answers[q1.question], "Apple");
  assert.equal(answers[q2.question], "Summer");
  assert.equal(ctx.appended.length, 2);
});

test("confident multiSelect: respond joins the selected labels with a comma", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  mockFetch(() => ({ o0: { noul: 0.9 }, o1: { noul: 0.05 }, o2: { noul: 0.9 }, o3: { noul: 0.05 }, personal: { noul: 0.1 }, destructive: { noul: 0.05 } }));

  await handlers["agent.permission_requested"]({ agent: requestedMultiselect.agent, request: requestedMultiselect.request }, ctx);

  assert.equal(ctx.responded.length, 1);
  const answers = (ctx.responded[0].response as { updatedInput: { answers: Record<string, string> } }).updatedInput.answers;
  assert.equal(answers[requestedMultiselect.request.input.questions[0].question], "Apple, Cherry");
});

test("one low-confidence question defers the whole request — all or nothing, no respond", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const [q1] = requestedPartial.request.input.questions;
  mockFetch((body) => {
    const pending = (body.state as { pendingQuestion: string }).pendingQuestion;
    const confident = pending === q1.question;
    return { pick: { choice: "o0", probabilities: { o0: confident ? 0.95 : 0.5, o1: confident ? 0.05 : 0.5 } }, ...SAFE_BOOLEANS };
  });

  await handlers["agent.permission_requested"]({ agent: requestedPartial.agent, request: requestedPartial.request }, ctx);

  assert.equal(ctx.responded.length, 0);
  const decisions = readLog().filter((e) => e.kind === "decision" && e.request_id === requestedPartial.request.id);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].outcome, "deferred");
  assert.equal(decisions[0].reason, "low_confidence");
});

test("destructive question defers, never responds", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  mockFetch(() => ({ pick: { choice: "o0", probabilities: { o0: 0.95, o1: 0.05 } }, personal: { noul: 0.1 }, destructive: { noul: 0.9 }, grounded: { noul: 0.9 } }));

  const request = { ...requestedSingle.request, id: "permission-destructive-test" };
  await handlers["agent.permission_requested"]({ agent: requestedSingle.agent, request }, ctx);

  assert.equal(ctx.responded.length, 0);
  const decisions = readLog().filter((e) => e.kind === "decision" && e.request_id === request.id);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].outcome, "deferred");
  assert.equal(decisions[0].reason, "destructive");
});

test("missing option descriptions defer immediately, without calling Jev", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const calls = mockFetch(() => ({}));

  const request = {
    ...requestedSingle.request,
    id: "permission-missing-def-test",
    input: { questions: [{ question: "Q?", options: [{ label: "A" }, { label: "B", description: "b" }] }] },
  };
  await handlers["agent.permission_requested"]({ agent: requestedSingle.agent, request }, ctx);

  assert.equal(calls.length, 0);
  assert.equal(ctx.responded.length, 0);
  const decisions = readLog().filter((e) => e.kind === "decision" && e.request_id === request.id);
  assert.equal(decisions[0].outcome, "deferred");
  assert.equal(decisions[0].reason, "missing_definition");
});

test("non-question permission kinds are ignored entirely — no Jev call, no tracking", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const calls = mockFetch(() => ({}));

  const request = { ...requestedSingle.request, id: "permission-tool-kind-test", kind: "tool" };
  await handlers["agent.permission_requested"]({ agent: requestedSingle.agent, request }, ctx);
  assert.equal(calls.length, 0);
  assert.equal(ctx.responded.length, 0);

  // A resolved event for an id this plugin never tracked must be a silent no-op.
  await handlers["agent.permission_resolved"]({ agent: requestedSingle.agent, requestId: request.id, resolution: { behavior: "allow", updatedInput: { answers: {} } } }, ctx);
  assert.equal(readLog().filter((e) => e.kind === "user_choice").length, 0);
});

test("resolved before Jev returns: never responds, logs race_lost", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = { ...requestedSingle.request, id: "permission-race-test" };

  let releaseTimeline!: (v: unknown[]) => void;
  const stuck = new Promise<unknown[]>((resolve) => {
    releaseTimeline = resolve;
  });
  const ctxStuck = makeContext(() => stuck);
  mockFetch(() => ({ pick: { choice: "o0", probabilities: { o0: 0.95, o1: 0.05 } }, ...SAFE_BOOLEANS }));

  // map.set happens synchronously before any await, so the resolved handler below already
  // sees this request as tracked even though fetchState() is still stuck awaiting the timeline.
  const reqPromise = handlers["agent.permission_requested"]({ agent: requestedSingle.agent, request }, ctxStuck);
  await handlers["agent.permission_resolved"]({ agent: requestedSingle.agent, requestId: request.id, resolution: { behavior: "allow", updatedInput: { answers: {} } } }, ctxStuck);
  releaseTimeline(withUserMessage);
  await reqPromise;

  assert.equal(ctxStuck.responded.length, 0);
  const decisions = readLog().filter((e) => e.kind === "decision" && e.request_id === request.id);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].outcome, "race_lost");
});

test("duplicate delivery (two installed plugin copies) makes exactly one Jev call", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const calls = mockFetch(() => ({ pick: { choice: "o0", probabilities: { o0: 0.95, o1: 0.05 } }, ...SAFE_BOOLEANS }));

  const request = { ...requestedSingle.request, id: "permission-dup-test" };
  const event = { agent: requestedSingle.agent, request };
  const p1 = handlers["agent.permission_requested"](event, ctx);
  const p2 = handlers["agent.permission_requested"](event, ctx);
  await Promise.all([p1, p2]);

  assert.equal(calls.length, 1);
  assert.equal(ctx.responded.length, 1);
});

test("human-resolved question (Jev never answered) logs user_choice", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  const request = { ...requestedSingle.request, id: "permission-human-test" };

  delete process.env.TYPESAFE_API_KEY; // forces an immediate "no_key" defer, no Jev call
  try {
    await handlers["agent.permission_requested"]({ agent: requestedSingle.agent, request }, ctx);
  } finally {
    process.env.TYPESAFE_API_KEY = "tsk_test_dummy";
  }
  assert.equal(ctx.responded.length, 0);

  const q = request.input.questions[0].question;
  await handlers["agent.permission_resolved"]({ agent: requestedSingle.agent, requestId: request.id, resolution: { behavior: "allow", updatedInput: { answers: { [q]: "Blue" } } } }, ctx);

  const choices = readLog().filter((e) => e.kind === "user_choice");
  assert.equal(choices.length, 1);
  assert.equal(choices[0].question, q);
  assert.deepEqual(choices[0].chosen, ["Blue"]);
  assert.deepEqual(choices[0].options, ["Red", "Blue"]);
});

test("Jev-resolved question never logs user_choice, even when Paseo echoes the resolution back", async () => {
  const { server, handlers } = makeServer();
  registerPermissionAnswerer(server);
  const ctx = makeContext(withUserMessage);
  mockFetch(() => ({ pick: { choice: "o0", probabilities: { o0: 0.95, o1: 0.05 } }, ...SAFE_BOOLEANS }));

  const request = { ...requestedSingle.request, id: "permission-jev-resolved-test" };
  await handlers["agent.permission_requested"]({ agent: requestedSingle.agent, request }, ctx);
  assert.equal(ctx.responded.length, 1);

  const q = request.input.questions[0].question;
  await handlers["agent.permission_resolved"]({ agent: requestedSingle.agent, requestId: request.id, resolution: { behavior: "allow", updatedInput: { answers: { [q]: "Red" } } } }, ctx);

  assert.equal(readLog().filter((e) => e.kind === "user_choice").length, 0);
});
