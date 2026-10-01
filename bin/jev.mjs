#!/usr/bin/env node
/**
 * CLI để tự hỏi Jev: đọc `{state, questions}` từ stdin (hoặc file truyền vào),
 * in `answers` thô ra stdout. Dùng bởi skill ask-jev, hoặc trực tiếp.
 */
import { readFileSync } from "node:fs";
import { apiKey, askJev, logEvent, logFilePath, requestError, NOT_CHAT } from "../lib/jev.mjs";
import { truncate } from "../lib/gate.mjs";
import { evidenceFindings, findingLine } from "../lib/cli-validate.mjs";
import { computeStats, filterSince, parseEvents, recentDecisions, sinceMsFromSpec } from "../lib/stats.mjs";

function fail(message, code = 1) {
  process.stderr.write(`jev: ${message}\n`);
  process.exit(code);
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

// outcome cho lib/stats.mjs: boolean/noul cắt ở 0.5 ra "true"/"false", choice là chính lựa chọn
// đã pick — để computeStats gom decision CLI vào gate riêng ("cli") thay vì rơi vào "unknown"
// và lẫn vào by_outcome/positive_pct của các gate khác.
function cliOutcome(q, answer) {
  if (!answer) return undefined;
  if (q.type === "boolean" || q.type === "noul") return typeof answer.probability === "number" ? (answer.probability >= 0.5 ? "true" : "false") : undefined;
  if (q.type === "choice") return answer.choice;
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

  const out = (line) => process.stdout.write(`${line}\n`);
  const c = summary.calls;
  const ag = summary.agreement;
  out(`Calls: ${c.total} (ok ${c.ok}, error ${c.error})  error rate ${(c.error_rate * 100).toFixed(1)}%`);
  out(`Latency: avg ${c.avg_latency_ms}ms, p95 ${c.p95_latency_ms}ms`);
  out(`Human answers: ${summary.human_answers}   Agreement with Jev: ${ag.compared ? `${ag.agreement_pct.toFixed(1)}% (${ag.agree} of ${ag.compared} compared; disagree ${ag.disagree}, partial ${ag.partial})` : "n/a (no answers compared with a recommendation)"}`);
  const adv = summary.advisory;
  out(`Advice on AskUserQuestion: ${adv.questions} questions, advised ${adv.advised} (strong ${adv.strong}, weak ${adv.weak}), unavailable ${adv.advice_unavailable}`);
  out(`Positive outcomes: ${summary.decisions.positive_pct.toFixed(1)}%  Fallbacks: ${summary.decisions.fallback_pct.toFixed(1)}%`);
  out("  (CLI rows: positive = a strong result, confidence at or above the threshold; the log only observes the result, not whether the agent acted on it)");
  out("\nBy entry point:");
  out(`  ${"entry point".padEnd(14)} ${"decisions".padStart(9)} ${"calls".padStart(6)} ${"errors".padStart(7)} ${"error rate".padStart(11)}`);
  const entryPoints = new Set([...Object.keys(c.by_source), ...Object.keys(summary.decisions.by_source)]);
  for (const ep of entryPoints) {
    const call = c.by_source[ep] ?? { calls: 0, errors: 0, error_rate: 0 };
    const dec = summary.decisions.by_source[ep]?.decisions ?? 0;
    out(`  ${ep.padEnd(14)} ${String(dec).padStart(9)} ${String(call.calls).padStart(6)} ${String(call.errors).padStart(7)} ${`${(call.error_rate * 100).toFixed(1)}%`.padStart(11)}`);
  }
  const sd = summary.standdowns;
  out(`\nStand-downs (not decisions, not errors): ${sd.total}${sd.total ? `  ${Object.entries(sd.by_reason).map(([r, n]) => `${r} ${n}`).join(", ")}` : ""}`);
  const pe = summary.provider_errors;
  out(`Provider errors: ${pe.total}${pe.total ? `  ${Object.entries(pe.by_class).map(([k, n]) => `${k} ${n}`).join(", ")}` : ""}`);
  out("\nDecisions by outcome:");
  for (const [outcome, count] of Object.entries(summary.decisions.by_outcome)) {
    const pct = summary.decisions.total ? ((count / summary.decisions.total) * 100).toFixed(1) : "0.0";
    out(`  ${outcome.padEnd(20)} ${String(count).padStart(4)}  ${pct}%`);
  }
  out("\nBy gate:");
  for (const [gate, g] of Object.entries(summary.decisions.by_gate)) {
    const pct = g.total ? ((g.positive / g.total) * 100).toFixed(1) : "0.0";
    const top = Object.entries(g.by_outcome).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([o, n]) => `${o} ${n}`).join(", ");
    out(`  ${gate.padEnd(12)} calls ${String(g.total).padStart(4)}  positive ${pct.padStart(5)}%  ${top}`);
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

  const findings = evidenceFindings(input);
  const rejects = findings.filter((f) => f.severity === "reject");
  if (rejects.length) {
    for (const f of rejects) process.stderr.write(`${findingLine(f, "rejected")}\n`);
    process.exit(2);
  }
  for (const f of findings) process.stderr.write(`${findingLine(f, "warning")}\n`);
  const warnings = findings.map(({ class: cls, path, message }) => ({ class: cls, path, message: truncate(message, 300) }));

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
        gate: "cli",
        question: name,
        question_text: truncate(questionText, 4000),
        options: Object.keys(q.criteria ?? {}),
        outcome: cliOutcome(q, answers[name]),
        result: cliResult(q, answers[name]),
        confidence: cliConfidence(q, answers[name]),
        ...(sizes ? { state_sizes: sizes } : {}),
        ...(warnings.length ? { warnings } : {}),
      });
    }
  } catch (err) {
    return fail(err.message);
  }
}

main();
