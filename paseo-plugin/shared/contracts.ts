import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const SINCE_OPTIONS = ["24h", "7d", "all"] as const;
export type SinceOption = (typeof SINCE_OPTIONS)[number];

export const GATES = ["ask", "permission", "stop", "bash", "prompt"] as const;

export const DecisionEventSchema = z.object({
  ts: z.string(),
  gate: z.string().optional(),
  outcome: z.string(),
  question: z.string(),
  label: z.string().optional(),
  confidence: z.number().optional(),
  reason: z.string().optional(),
});

const GateSummarySchema = z.object({
  total: z.number(),
  positive: z.number(),
  by_outcome: z.record(z.string(), z.number()),
});

export const jevStatsRpc = defineRpc({
  name: "ask-jev.stats",
  input: z.object({
    since: z.enum(SINCE_OPTIONS).default("all"),
    outcome: z.string().default("all"),
    gate: z.string().default("all"),
  }),
  output: z.object({
    logPath: z.string(),
    hasLog: z.boolean(),
    calls: z.object({
      total: z.number(),
      ok: z.number(),
      error: z.number(),
      avg_latency_ms: z.number(),
      p95_latency_ms: z.number(),
    }),
    decisions: z.object({
      total: z.number(),
      by_outcome: z.record(z.string(), z.number()),
      by_gate: z.record(z.string(), GateSummarySchema),
      positive_pct: z.number(),
      fallback_pct: z.number(),
    }),
    user_overrides: z.number(),
    recent: z.array(DecisionEventSchema),
  }),
});

export type JevStats = z.infer<typeof jevStatsRpc.output>;

export const jevDecisionRpc = defineRpc({
  name: "ask-jev.decision",
  input: z.object({ ts: z.string(), gate: z.string().optional() }),
  output: z.record(z.string(), z.unknown()).nullable(),
});
