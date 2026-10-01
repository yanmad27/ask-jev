import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const SINCE_OPTIONS = ["24h", "7d", "all"] as const;
export type SinceOption = (typeof SINCE_OPTIONS)[number];

export const GATES = ["ask", "permission", "stop", "bash", "prompt"] as const;

export const DecisionEventSchema = z.object({
  ts: z.string(),
  event_id: z.string().optional(),
  source: z.string().optional(),
  gate: z.string().optional(),
  outcome: z.string(),
  question: z.string(),
  label: z.string().optional(),
  confidence: z.number().optional(),
  reason: z.string().optional(),
  repo: z.string().optional(),
  agent: z.string().optional(),
});

const GateSummarySchema = z.object({
  total: z.number(),
  positive: z.number(),
  by_outcome: z.record(z.string(), z.number()),
});

const AgreementSchema = z.object({
  compared: z.number(),
  agree: z.number(),
  disagree: z.number(),
  partial: z.number(),
  agreement_pct: z.number(),
});

const AdvisorySchema = z.object({
  questions: z.number(),
  advised: z.number(),
  advice_unavailable: z.number(),
  unavailable_by_reason: z.record(z.string(), z.number()),
  strong: z.number(),
  weak: z.number(),
});

export const jevStatsRpc = defineRpc({
  name: "ask-jev.stats",
  input: z.object({
    since: z.enum(SINCE_OPTIONS).default("all"),
    outcome: z.string().default("all"),
    gate: z.string().default("all"),
    cwd: z.string().optional(),
  }),
  output: z.object({
    logPath: z.string(),
    scope: z.string(),
    hasLog: z.boolean(),
    calls: z.object({
      total: z.number(),
      ok: z.number(),
      error: z.number(),
      avg_latency_ms: z.number(),
      p95_latency_ms: z.number(),
      error_rate: z.number(),
      by_source: z.record(z.string(), z.object({ calls: z.number(), errors: z.number(), error_rate: z.number() })),
    }),
    decisions: z.object({
      total: z.number(),
      by_outcome: z.record(z.string(), z.number()),
      by_gate: z.record(z.string(), GateSummarySchema),
      positive_pct: z.number(),
      fallback_pct: z.number(),
      by_source: z.record(z.string(), z.object({ decisions: z.number() })),
    }),
    // stats v2 (additive): `user_overrides` is a deprecated alias of `human_answers`.
    human_answers: z.number(),
    user_overrides: z.number(),
    agreement: AgreementSchema,
    advisory: AdvisorySchema,
    provider_errors: z.object({ total: z.number(), by_class: z.record(z.string(), z.number()) }),
    standdowns: z.object({ total: z.number(), by_reason: z.record(z.string(), z.number()) }),
    recent: z.array(DecisionEventSchema),
  }),
});

export type JevStats = z.infer<typeof jevStatsRpc.output>;

export const jevDecisionRpc = defineRpc({
  name: "ask-jev.decision",
  input: z.object({ event_id: z.string().optional(), ts: z.string(), gate: z.string().optional() }),
  output: z.record(z.string(), z.unknown()).nullable(),
});

// The `data` shape server/permission-answerer.ts appends via timeline.append({type:"plugin", ...}).
// A plugin timeline item needs a matching client.addTimelineRenderer (kind+version+schema) to
// render at all — see index.client.tsx — otherwise Paseo has nothing to display it with.
export const ASK_JEV_TIMELINE_KIND = "ask-jev.decision";
export const ASK_JEV_TIMELINE_VERSION = 1;
export const AskJevTimelineDataSchema = z.object({
  text: z.string(),
  question: z.string(),
  label: z.string(),
  confidence: z.number(),
});

// Advice for a still-pending question: a separate plugin item (permission events are observe-only,
// so the pending card itself cannot be annotated). `status:"unavailable"` carries no recommendation;
// `reason` is then the advice_unavailable reason code (billing, timeout, provider_error, …).
export const ASK_JEV_ADVICE_KIND = "ask-jev.advice";
export const ASK_JEV_ADVICE_VERSION = 1;
export const AskJevAdviceDataSchema = z.object({
  text: z.string(),
  question: z.string(),
  question_index: z.number(),
  question_count: z.number().optional(),
  status: z.enum(["advised", "unavailable"]),
  recommended: z.array(z.string()),
  recommended_index: z.array(z.number()).optional(),
  confidence: z.number().nullable(),
  strength: z.enum(["strong", "weak"]).optional(),
  reason: z.string(),
});
export type AskJevAdviceData = z.infer<typeof AskJevAdviceDataSchema>;
