#!/usr/bin/env node
/**
 * CLI để tự hỏi Jev: đọc `{state, questions}` từ stdin (hoặc file truyền vào),
 * in `answers` thô ra stdout. Dùng bởi skill ask-jev, hoặc trực tiếp.
 */
import { readFileSync } from "node:fs";
import { apiKey, askJev, logEvent, logFilePath, requestError, NOT_CHAT } from "../lib/jev.mjs";
import { truncate } from "../lib/gate.mjs";
import { computeStats, filterSince, parseEvents, recentDecisions, sinceMsFromSpec } from "../lib/stats.mjs";

function fail(message) {
  process.stderr.write(`jev: ${message}\n`);
  process.exit(1);
}

// result: boolean/noul → probability thô; choice → {choice, probability của lựa chọn đó};
// type khác (vd score) → answer nguyên văn, vì chưa có quy ước rút gọn.
function cliResult(q, answer) {
  if (!answer) return undefined;
  if (q.type === "boolean" || q.type === "noul") return answer.probability;
  if (q.type === "choice") return { choice: answer.choice, probability: answer.probabilities?.[answer.choice] };
  return answer;
}

function cliConfidence(q, answer) {
  if (!answer) return undefined;
  if (q.type === "boolean" || q.type === "noul") return answer.confidence;
  if (q.type === "choice") return answer.probabilities?.[answer.choice];
  return undefined;
}

// Kích thước từng field top-level của state, giống buildState() bên hook — rẻ vì chỉ
// stringify một lần mỗi field, không phải toàn bộ cây lặp lại.
function cliStateSizes(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return undefined;
  try {
    return Object.fromEntries(Object.entries(state).map(([k, v]) => [k, JSON.stringify(v).length]));
  } catch {
    return undefined;
  }
}

function stats(args) {
  const path = logFilePath();
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    process.stdout.write(`no log yet at ${path}\n`);
    return;
  }

  let events = parseEvents(raw);
  events = filterSince(events, sinceMsFromSpec(args[args.indexOf("--since") + 1]));
  const lastN = Number(args[args.indexOf("--last") + 1]);
  if (lastN > 0) events = events.slice(-lastN);

  const summary = computeStats(events);

  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify(summary) + "\n");
    return;
  }

  process.stdout.write(`Calls: ${summary.calls.total} (ok ${summary.calls.ok}, error ${summary.calls.error})\n`);
  process.stdout.write(`Latency: avg ${summary.calls.avg_latency_ms}ms, p95 ${summary.calls.p95_latency_ms}ms\n`);
  process.stdout.write(`Jev decided: ${summary.decisions.positive_pct.toFixed(1)}%  Fell back to user: ${summary.decisions.fallback_pct.toFixed(1)}%  User overrides: ${summary.user_overrides}\n\n`);
  process.stdout.write("Decisions by outcome:\n");
  for (const [outcome, count] of Object.entries(summary.decisions.by_outcome)) {
    const pct = summary.decisions.total ? ((count / summary.decisions.total) * 100).toFixed(1) : "0.0";
    process.stdout.write(`  ${outcome.padEnd(20)} ${String(count).padStart(4)}  ${pct}%\n`);
  }
  process.stdout.write("\nBy gate:\n");
  for (const [gate, g] of Object.entries(summary.decisions.by_gate)) {
    const pct = g.total ? ((g.positive / g.total) * 100).toFixed(1) : "0.0";
    const top = Object.entries(g.by_outcome).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([o, c]) => `${o} ${c}`).join(", ");
    process.stdout.write(`  ${gate.padEnd(12)} calls ${String(g.total).padStart(4)}  positive ${pct.padStart(5)}%  ${top}\n`);
  }
  process.stdout.write("\nRecent decisions:\n");
  for (const d of recentDecisions(events, 10)) {
    const q = d.question.length > 60 ? `${d.question.slice(0, 57)}...` : d.question;
    const extra = d.label ? (d.confidence != null ? `${d.label} (${Number(d.confidence).toFixed(2)})` : d.label) : "";
    process.stdout.write(`  ${d.ts}  ${d.outcome.padEnd(18)} ${q.padEnd(62)} ${extra}\n`);
  }
}

async function main() {
  if (process.argv[2] === "stats") return stats(process.argv.slice(3));

  const path = process.argv[2];
  let raw;
  try {
    raw = readFileSync(path ?? 0, "utf8");
  } catch (err) {
    return fail(`cannot read input: ${err.message}`);
  }

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return fail("input is not valid JSON");
  }

  const invalid = requestError(input);
  if (invalid) return fail(`${invalid}. ${NOT_CHAT}`);

  const key = apiKey();
  if (!key) return fail("no API key (set TYPESAFE_API_KEY or ~/.claude/ask-jev.key)");

  try {
    const answers = await askJev(key, input.state, input.questions);
    process.stdout.write(JSON.stringify(answers));

    const sizes = cliStateSizes(input.state);
    for (const [name, q] of Object.entries(input.questions)) {
      const questionText = typeof q.instructions === "string" ? q.instructions : q.instructions?.question ?? "";
      logEvent({
        kind: "decision",
        source: "cli",
        question: name,
        question_text: truncate(questionText, 4000),
        options: Object.keys(q.criteria ?? {}),
        result: cliResult(q, answers[name]),
        confidence: cliConfidence(q, answers[name]),
        ...(sizes ? { state_sizes: sizes } : {}),
      });
    }
  } catch (err) {
    return fail(err.message);
  }
}

main();
