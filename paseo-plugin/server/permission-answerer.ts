import { randomUUID } from "node:crypto";
import type { PluginServerContext, PluginHookAgent } from "@getpaseo/plugin/server";
import type { PaseoApi } from "@getpaseo/client";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { apiKey, askJev, logEvent, runInvocation } from "./vendor/jev.mjs";
import { buildState, hasContext } from "./vendor/context.mjs";
import { env } from "./vendor/env.mjs";
import { adviceBlocker, adviseQuestions, buildAdviceMultiQuestions, buildAdviceQuestions, pickCriteria } from "./vendor/answer-policy.mjs";
import { remoteOf } from "./log";
import { ASK_JEV_ADVICE_KIND, ASK_JEV_ADVICE_VERSION } from "../shared/contracts";
import type { AskJevAdviceData } from "../shared/contracts";

const THRESHOLD = Number(env("ASK_THRESHOLD", "0.8"));
const BUDGET_MS = 8000;
const QUESTION_CAP = 300;
const NOTE_CAP = 80;

// ponytail: swept lazily whenever a request comes in or resolves; a live daemon gets plenty of
// those. A pending question waits for its human, however long that takes — so the TTL is only a
// safety cap against an agent archived without ever resolving, not a confirmation window. Read
// fresh on every sweep so ASK_JEV_PASEO_TTL_MS can be set after import in tests.
function trackedTtlMs(): number {
  return Number(env("PASEO_TTL_MS", String(24 * 60 * 60_000)));
}

interface PaseoOption {
  label: string;
  description?: string;
}

interface PaseoQuestion {
  question: string;
  header?: string;
  options?: PaseoOption[];
  multiSelect?: boolean;
}

interface AdviceRecord {
  recommended: string[];
  confidence: number;
  /** false once timeline.append for this advice is known to have failed — the human never saw it. */
  shown: boolean;
}

interface TrackedRequest {
  owner: string;
  agentId: string;
  requestId: string;
  invocationId: string;
  cwd: string;
  repo?: string;
  questions: PaseoQuestion[];
  createdAt: number;
  /** Set by the resolved event, unload or the TTL sweep. In-flight advice work re-checks it after
   * every await, so nothing is logged or appended for a request the human already moved past. */
  resolved: boolean;
  advice: Array<AdviceRecord | undefined>;
}

const INFLIGHT_KEY = Symbol.for("ask-jev.paseo.inflight");
const BILLING_KEY = Symbol.for("ask-jev.paseo.billing-noted");
const BILLING_NOTED_MAX = 1000;

function inflightMap(): Map<string, TrackedRequest> {
  const g = globalThis as Record<symbol, unknown>;
  if (!(g[INFLIGHT_KEY] instanceof Map)) g[INFLIGHT_KEY] = new Map<string, TrackedRequest>();
  return g[INFLIGHT_KEY] as Map<string, TrackedRequest>;
}

/** Agents already told "credits exhausted" in this process. askJev's own once-per-session decision
 * (err.notice, from billingNoteShown on the log) is made before its provider_error row is written,
 * so two questions of one request failing in parallel would both be told "billing". */
function billingNoted(): Set<string> {
  const g = globalThis as Record<symbol, unknown>;
  if (!(g[BILLING_KEY] instanceof Set)) g[BILLING_KEY] = new Set<string>();
  const set = g[BILLING_KEY] as Set<string>;
  if (set.size > BILLING_NOTED_MAX) set.clear();
  return set;
}

function sweepStale(map: Map<string, TrackedRequest>) {
  const now = Date.now();
  const ttl = trackedTtlMs();
  for (const [key, tracked] of map) {
    if (now - tracked.createdAt < ttl) continue;
    tracked.resolved = true;
    map.delete(key);
    logEvent({ kind: "diagnostic", source: "paseo", gate: "ask", outcome: "unresolved_expired", ...metaOf(tracked) });
  }
}

function metaOf(tracked: Pick<TrackedRequest, "agentId" | "repo" | "requestId">) {
  return { agent: tracked.agentId, ...(tracked.repo ? { repo: tracked.repo } : {}), request_id: tracked.requestId };
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Only user/assistant text, in the row shape lib/context.mjs's transcriptRows expects. */
function timelineToRows(entries: unknown[]): Array<{ type: string; message: { content: string } }> {
  const rows: Array<{ type: string; message: { content: string } }> = [];
  for (const entry of entries) {
    const item = (entry as { item?: { type?: string; text?: string } } | undefined)?.item;
    if (!item || typeof item.text !== "string") continue;
    if (item.type === "user_message") rows.push({ type: "user", message: { content: item.text } });
    else if (item.type === "assistant_message") rows.push({ type: "assistant", message: { content: item.text } });
  }
  return rows;
}

/** Builds the same state shape the hook uses, from the Paseo timeline instead of a Claude Code
 * transcript file — buildState's transcriptRows takes the rows directly, no temp file needed. */
async function fetchState(paseo: PaseoApi, agentId: string, cwd: string): Promise<{ state: unknown; sizes: Record<string, number> }> {
  let entries: unknown[] = [];
  try {
    const payload = await paseo.agents.ref(agentId).timeline.refetch();
    entries = Array.isArray(payload) ? payload : ((payload as { entries?: unknown[] })?.entries ?? []);
  } catch {
    entries = [];
  }
  const options = { transcriptRows: timelineToRows(entries), transcriptPath: undefined, cwd, sessionId: undefined, action: undefined, extra: undefined };
  const built = buildState(options as unknown as Parameters<typeof buildState>[0]);
  return built as { state: unknown; sizes: Record<string, number> };
}

type ProviderOutcome = { answers: Record<string, unknown> | null; errorClass?: string; billingNotice?: boolean };

async function askOne(key: string, q: PaseoQuestion, index: number, state: unknown, sizes: Record<string, number>, tracked: TrackedRequest): Promise<ProviderOutcome> {
  const options = q.options ?? [];
  const questions = q.multiSelect ? buildAdviceMultiQuestions(q.question, options) : buildAdviceQuestions(options);
  const jevState = q.multiSelect
    ? { conversationContext: state, pendingQuestion: q.question }
    : { conversationContext: state, pendingQuestion: q.question, answerOptions: pickCriteria(options) };
  try {
    const answers = await askJev(key, jevState, questions, "paseo", BUDGET_MS, sizes, { ...metaOf(tracked), gate: "ask", question_index: index });
    return { answers };
  } catch (err) {
    const e = err as { errorClass?: string; notice?: string };
    return { answers: null, errorClass: e.errorClass, billingNotice: e.notice === "billing" };
  }
}

/** askJev's error class → the advice_unavailable reason (design §D.2). */
function unavailableReason(errorClass: string | undefined): string {
  return errorClass === "billing" || errorClass === "timeout" ? errorClass : "provider_error";
}

const UNAVAILABLE_NOTE: Record<string, string> = {
  single_option: "only one option to choose from",
  missing_definition: "the options have no descriptions for Jev to score",
  no_context: "no conversation context yet",
  timeout: "Jev did not answer in time",
  parse_error: "Jev returned an answer that could not be read",
  provider_error: "the Jev request failed",
};

function adviceText(recommended: string[], confidence: number, reason: string, strength: string | undefined): string {
  const pick = recommended.length > 0 ? recommended.map((l) => `"${l}"`).join(", ") : "no option";
  return `Jev advice: ${pick} (${confidence.toFixed(2)}${strength === "weak" ? ", low confidence" : ""}) — ${reason}`;
}

function unavailableText(reason: string, billingNote: boolean): string {
  if (reason === "billing") {
    return billingNote ? "Jev advice unavailable — Jev credits are exhausted." : "Jev advice unavailable — the Jev request failed.";
  }
  return `Jev advice unavailable — ${UNAVAILABLE_NOTE[reason] ?? UNAVAILABLE_NOTE.provider_error}.`;
}

interface Advised {
  outcome: "advised";
  recommended: string[];
  confidence: number;
  strength: string;
  grounded: number | null;
  reason: string;
}
interface Unavailable {
  outcome: "advice_unavailable";
  reason: string;
}

/** Advice for every question of one pending request, then one timeline item each. Never answers. */
async function adviseRequest(tracked: TrackedRequest, context: { paseo: PaseoApi }): Promise<void> {
  const { questions } = tracked;
  if (questions.length === 0) return;
  const discarded = (stage: string) => logEvent({ kind: "diagnostic", source: "paseo", gate: "ask", outcome: "advice_discarded", reason: stage, ...metaOf(tracked) });

  const blockers = questions.map((q) => adviceBlocker(q.options ?? []) as string | null);
  const key = apiKey();
  let wholeFailure: string | undefined;
  let state: unknown;
  let sizes: Record<string, number> = {};
  if (blockers.some((b) => !b)) {
    if (!key) {
      wholeFailure = "no_key";
    } else {
      const fetched = await fetchState(context.paseo, tracked.agentId, tracked.cwd);
      if (tracked.resolved) return discarded("resolved_during_state_fetch");
      if (!hasContext(fetched.state)) wholeFailure = "no_context";
      state = fetched.state;
      sizes = fetched.sizes;
    }
  }

  const outcomes = await Promise.all(
    questions.map((q, i): Promise<ProviderOutcome> => (blockers[i] || wholeFailure || !key ? Promise.resolve({ answers: null }) : askOne(key, q, i, state, sizes, tracked))),
  );
  if (tracked.resolved) return discarded("resolved_during_provider_call");

  const results = adviseQuestions(
    questions.map((q, i) => ({
      options: q.options ?? [],
      multiSelect: Boolean(q.multiSelect),
      answers: outcomes[i].answers,
      errorClass: wholeFailure ?? unavailableReason(outcomes[i].errorClass),
    })),
    { threshold: THRESHOLD },
  ) as Array<Advised | Unavailable>;

  const noted = billingNoted();
  for (const [i, q] of questions.entries()) {
    // Re-checked per item: the human can resolve between two sequential appends.
    if (tracked.resolved) return discarded("resolved_during_append");
    const r = results[i];
    const base = { question: q.question, question_index: i };
    const prefix = questions.length > 1 ? `[${cap(q.question, NOTE_CAP)}] ` : "";
    let data: AskJevAdviceData;
    let decision: Record<string, unknown>;

    if (r.outcome === "advised") {
      const text = prefix + adviceText(r.recommended, r.confidence, r.reason, r.strength);
      data = { ...base, text, status: "advised", recommended: r.recommended, confidence: r.confidence, strength: r.strength as "strong" | "weak", reason: r.reason };
      decision = { outcome: "advised", recommended: r.recommended, confidence: r.confidence, strength: r.strength, grounded: r.grounded, reason: r.reason, advice_text: cap(text, QUESTION_CAP), display: "timeline" };
      tracked.advice[i] = { recommended: r.recommended, confidence: r.confidence, shown: true };
    } else {
      if (wholeFailure === "no_key") {
        logEvent({ kind: "decision", source: "paseo", gate: "ask", mode: "advisory", outcome: "advice_unavailable", reason: "no_key", note_shown: false, question: cap(q.question, QUESTION_CAP), question_index: i, ...metaOf(tracked) });
        continue; // no key is configuration absence, not a failure worth a timeline item
      }
      const billingNote = r.reason === "billing" && Boolean(outcomes[i].billingNotice) && !noted.has(tracked.agentId);
      if (billingNote) noted.add(tracked.agentId);
      const text = prefix + unavailableText(r.reason, billingNote);
      data = { ...base, text, status: "unavailable", recommended: [], confidence: null, reason: r.reason };
      decision = { outcome: "advice_unavailable", reason: r.reason, note_shown: billingNote };
    }

    logEvent({ kind: "decision", source: "paseo", gate: "ask", mode: "advisory", question: cap(q.question, QUESTION_CAP), question_index: i, options: (q.options ?? []).map((o) => o.label), ...decision, ...metaOf(tracked) });
    try {
      await context.paseo.agents.ref(tracked.agentId).timeline.append({ type: "plugin", id: randomUUID(), kind: ASK_JEV_ADVICE_KIND, version: ASK_JEV_ADVICE_VERSION, data });
    } catch {
      const record = tracked.advice[i];
      if (record) record.shown = false;
      logEvent({ kind: "diagnostic", source: "paseo", gate: "ask", outcome: "advice_append_failed", question_index: i, ...metaOf(tracked) });
    }
  }
}

/** Splits on the daemon's own join (", "), unless the whole raw string already matches a single
 * known label as-is (covers a label that itself contains a comma). Unmatched parts (a free-typed
 * "Other" addition alongside real picks) are kept, not dropped — kind_of_answer downstream reflects
 * whether every part matched a known label. */
function parseMultiSelectAnswer(raw: string, options: PaseoOption[]): string[] {
  const labels = new Set(options.map((o) => o.label));
  if (labels.has(raw)) return [raw];
  return raw.split(", ");
}

function agreementOf(q: PaseoQuestion, advice: AdviceRecord | undefined, chosen: string[], kind: string): string {
  if (!advice) return "no_advice";
  if (kind === "free_text") return "free_text";
  if (kind !== "option") return "no_advice";
  const rec = new Set(advice.recommended);
  const got = new Set(chosen);
  if (rec.size === got.size && [...got].every((c) => rec.has(c))) return "agree";
  if (q.multiSelect && [...got].some((c) => rec.has(c))) return "partial";
  return "disagree";
}

export function registerPermissionAnswerer(server: PluginServerContext): () => void {
  const owner = randomUUID();
  const invocationCtx = (agentId: string, key: string) => ({ invocation_id: key, session_id: agentId, source: "paseo", threshold: THRESHOLD });

  const offRequested = server.on("agent.permission_requested", async (event, context) => {
    const agent = event.agent as PluginHookAgent;
    const request = event.request as AgentPermissionRequest;
    const map = inflightMap();
    sweepStale(map);
    if (request.kind !== "question") return;

    const key = `${agent.id}:${request.id}`;
    if (map.has(key)) return; // duplicate delivery — another copy (or an earlier call) already owns this

    const questions = ((request.input as { questions?: PaseoQuestion[] } | undefined)?.questions ?? []) as PaseoQuestion[];
    const tracked: TrackedRequest = {
      owner,
      agentId: agent.id,
      requestId: request.id,
      invocationId: key,
      cwd: agent.cwd,
      repo: remoteOf(agent.cwd) ?? undefined,
      questions,
      createdAt: Date.now(),
      resolved: false,
      advice: [],
    };
    map.set(key, tracked);

    try {
      await runInvocation(invocationCtx(agent.id, key), () => adviseRequest(tracked, context));
    } catch {
      logEvent({ kind: "diagnostic", source: "paseo", gate: "ask", outcome: "error", ...metaOf(tracked) });
    }
  });

  const offResolved = server.on("agent.permission_resolved", async (event) => {
    try {
      const agent = event.agent as PluginHookAgent;
      const { requestId, resolution } = event as { requestId: string; resolution: AgentPermissionResponse };
      const map = inflightMap();
      sweepStale(map);
      const key = `${agent.id}:${requestId}`;
      const tracked = map.get(key);
      if (!tracked) return; // not a question request this plugin tracked

      tracked.resolved = true;
      map.delete(key);

      if (resolution.behavior !== "allow") return; // nothing chosen to attribute

      const resolvedAnswers = ((resolution as { updatedInput?: { answers?: Record<string, string> } }).updatedInput?.answers ?? {}) as Record<string, string>;
      runInvocation(invocationCtx(agent.id, tracked.invocationId), () => {
        tracked.questions.forEach((q, i) => {
          const chosenRaw = resolvedAnswers[q.question];
          if (chosenRaw === undefined) return;
          const options = q.options ?? [];
          const labels = new Set(options.map((o) => o.label));
          const chosen = typeof chosenRaw !== "string" ? [] : q.multiSelect ? parseMultiSelectAnswer(chosenRaw, options) : [chosenRaw];
          const kind = typeof chosenRaw !== "string" ? "unparsed" : chosen.every((c) => labels.has(c)) ? "option" : "free_text";
          const advice = tracked.advice[i]?.shown ? tracked.advice[i] : undefined;
          logEvent({
            kind: "outcome",
            source: "paseo",
            gate: "ask",
            cwd: tracked.cwd,
            question_index: i,
            question: cap(q.question, QUESTION_CAP),
            options: options.map((o) => o.label),
            chosen,
            kind_of_answer: kind,
            advice_shown: Boolean(advice),
            recommended: advice ? advice.recommended : null,
            recommended_confidence: advice ? advice.confidence : null,
            agreement: agreementOf(q, advice, chosen, kind),
            ...metaOf(tracked),
          });
        });
      });
    } catch {
      logEvent({ kind: "diagnostic", source: "paseo", gate: "ask", outcome: "error" });
    }
  });

  return () => {
    offRequested();
    offResolved();
    // Stop any in-flight advice THIS instance started so nothing is appended after unload. Entries
    // owned by the other installed copy (if any) are left alone; they're that copy's responsibility.
    // Deleted (not just marked resolved) so they don't linger in the shared map across reloads.
    const map = inflightMap();
    for (const [key, tracked] of map) {
      if (tracked.owner !== owner) continue;
      tracked.resolved = true;
      map.delete(key);
    }
  };
}
