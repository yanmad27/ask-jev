import { cleanEnv } from "./testenv.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = process.cwd();
const OPTS = [{ label: "Blue", description: "b" }, { label: "Red", description: "r" }, { label: "Green", description: "g" }];

function tmpLog() {
  return join(mkdtempSync(join(tmpdir(), "answer-hook-log-")), "jev.log");
}

/** Seed the PreToolUse advice rows of one invocation, exactly as hooks/ask-jev.mjs writes them. */
function seedAdvice(logFile, toolUseId, rows) {
  const lines = rows.map((r, i) => JSON.stringify({
    kind: "decision", gate: "ask", mode: "advisory", invocation_id: toolUseId, session_id: "sess-1", question_index: i,
    question: r.question, options: OPTS.map((o) => o.label), ...(r.advice ?? { outcome: "advice_unavailable", reason: "provider_error" }),
  }));
  writeFileSync(logFile, lines.join("\n") + "\n");
}
const advised = (recommended, confidence = 0.86) => ({ outcome: "advised", recommended, confidence, strength: "strong", advice_text: `Jev đề xuất: ${recommended.join(", ")} (${confidence.toFixed(2)}) — b` });

async function runAnswerHook(toolResponse, logFile, extra = {}) {
  const script = join(repoRoot, "hooks", "ask-jev-answer.mjs");
  const input = { tool_name: "AskUserQuestion", session_id: "sess-1", tool_use_id: "toolu_1", cwd: "/repo", tool_response: toolResponse, ...extra };
  const child = execFileAsync("node", [script], { env: { ...cleanEnv(), ASK_JEV_API_KEY: "vck_dummy", ASK_JEV_LOG_FILE: logFile }, encoding: "utf8" });
  child.child.stdin.end(JSON.stringify(input));
  await child;
}

function outcomes(logFile) {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === "outcome");
}

const answered = (...pairs) => `Your questions have been answered: ${pairs.map(([q, a]) => `"${q}"="${a}"`).join(", ")}. You can now continue with these answers in mind.`;
const toolInput = (...questions) => ({ questions: questions.map((q) => ({ options: OPTS, multiSelect: false, ...q })) });

test("outcome: a pick that matches Jev's recommendation → agree, linked by tool_use_id", async () => {
  const log = tmpLog();
  seedAdvice(log, "toolu_1", [{ question: "Color?", advice: advised(["Blue"]) }]);
  await runAnswerHook(answered(["Color?", "Blue"]), log, { tool_input: toolInput({ question: "Color?" }) });
  const [o] = outcomes(log);
  assert.equal(o.invocation_id, "toolu_1");
  assert.equal(o.question, "Color?");
  assert.equal(o.question_index, 0);
  assert.deepEqual(o.options, ["Blue", "Red", "Green"]);
  assert.deepEqual(o.chosen, ["Blue"]);
  assert.equal(o.kind_of_answer, "option");
  assert.equal(o.advice_shown, true);
  assert.deepEqual(o.recommended, ["Blue"]);
  assert.equal(o.recommended_confidence, 0.86);
  assert.equal(o.agreement, "agree");
  assert.equal(o.cwd, "/repo");
});

test("outcome: a different pick → disagree, with both sides recorded", async () => {
  const log = tmpLog();
  seedAdvice(log, "toolu_1", [{ question: "Color?", advice: advised(["Blue"]) }]);
  await runAnswerHook(answered(["Color?", "Red"]), log, { tool_input: toolInput({ question: "Color?" }) });
  const [o] = outcomes(log);
  assert.equal(o.agreement, "disagree");
  assert.deepEqual(o.chosen, ["Red"]);
  assert.deepEqual(o.recommended, ["Blue"]);
});

test("outcome: free-text 'Other' → free_text kind and agreement, still carries the recommendation", async () => {
  const log = tmpLog();
  seedAdvice(log, "toolu_1", [{ question: "Where is it?", advice: advised(["Blue"], 0.7) }]);
  await runAnswerHook('The user answered: "Where is it?"="~/Downloads/logo.png". Read the answers carefully.', log, { tool_input: toolInput({ question: "Where is it?" }) });
  const [o] = outcomes(log);
  assert.equal(o.kind_of_answer, "free_text");
  assert.equal(o.agreement, "free_text");
  assert.deepEqual(o.chosen, ["~/Downloads/logo.png"]);
  assert.deepEqual(o.recommended, ["Blue"]);
});

test("outcome: a free-text answer inside an option-prefixed multi-question response is classified per question", async () => {
  const log = tmpLog();
  seedAdvice(log, "toolu_1", [{ question: "One?", advice: advised(["Blue"]) }, { question: "Two?", advice: advised(["Red"]) }]);
  await runAnswerHook(answered(["One?", "Blue"], ["Two?", "something else"]), log, { tool_input: toolInput({ question: "One?" }, { question: "Two?" }) });
  const [a, b] = outcomes(log);
  assert.deepEqual([a.kind_of_answer, a.agreement, a.question_index], ["option", "agree", 0]);
  assert.deepEqual([b.kind_of_answer, b.agreement, b.question_index], ["free_text", "free_text", 1]);
});

test("outcome: multiSelect — same set agrees, overlap is partial, disjoint disagrees; labels containing ', ' stay whole", async () => {
  const opts = [...OPTS, { label: "Cyan, light", description: "c" }];
  const cases = [
    [["Blue", "Red"], "Blue, Red", "agree", ["Blue", "Red"]],
    [["Blue", "Red"], "Blue, Green", "partial", ["Blue", "Green"]],
    [["Blue"], "Green, Cyan, light", "disagree", ["Green", "Cyan, light"]],
  ];
  for (const [recommended, answer, agreement, chosen] of cases) {
    const log = tmpLog();
    seedAdvice(log, "toolu_1", [{ question: "Colors?", advice: advised(recommended, 0.9) }]);
    await runAnswerHook(answered(["Colors?", answer]), log, { tool_input: { questions: [{ question: "Colors?", multiSelect: true, options: opts }] } });
    const [o] = outcomes(log);
    assert.equal(o.agreement, agreement, answer);
    assert.deepEqual(o.chosen, chosen, answer);
    assert.equal(o.kind_of_answer, "option");
  }
});

test("outcome: advice_unavailable or no advice row → agreement no_advice, advice_shown false", async () => {
  const log = tmpLog();
  seedAdvice(log, "toolu_1", [{ question: "Color?" }]);
  await runAnswerHook(answered(["Color?", "Blue"]), log, { tool_input: toolInput({ question: "Color?" }) });
  await runAnswerHook(answered(["Color?", "Blue"]), log, { tool_use_id: "toolu_unknown", tool_input: toolInput({ question: "Color?" }) });
  for (const o of outcomes(log)) {
    assert.equal(o.agreement, "no_advice");
    assert.equal(o.advice_shown, false);
    assert.equal(o.recommended, null);
    assert.equal(o.recommended_confidence, null);
  }
  assert.equal(outcomes(log).length, 2);
});

test("outcome: the annotate channel's rewritten question text still joins to the advice row, and the original text is recorded", async () => {
  const log = tmpLog();
  seedAdvice(log, "toolu_1", [{ question: "Color?", advice: advised(["Blue"]) }]);
  const annotated = "Color?\n\nJev đề xuất: Blue (0.86) — b";
  // PostToolUse tool_input may be either the original or the annotated one — both must join.
  await runAnswerHook(answered([annotated, "Blue"]), log, { tool_input: toolInput({ question: "Color?" }) });
  await runAnswerHook(answered([annotated, "Red"]), log, { tool_input: toolInput({ question: annotated }) });
  await runAnswerHook(answered([annotated, "Blue"]), log, {});
  const rows = outcomes(log);
  assert.deepEqual(rows.map((o) => o.agreement), ["agree", "disagree", "agree"]);
  assert.ok(rows.every((o) => o.question_index === 0 && o.invocation_id === "toolu_1"));
  assert.equal(rows[0].question, "Color?");
});

test("outcome: an unparsable tool_response is logged as kind_of_answer 'unparsed', never dropped", async () => {
  const log = tmpLog();
  seedAdvice(log, "toolu_1", [{ question: "Color?", advice: advised(["Blue"]) }]);
  await runAnswerHook("Something Claude Code never wrote before", log, { tool_input: toolInput({ question: "Color?" }) });
  await runAnswerHook({ content: [{ type: "image", source: {} }] }, log);
  await runAnswerHook({}, log);
  const rows = outcomes(log);
  assert.equal(rows.length, 3);
  for (const o of rows) {
    assert.equal(o.kind_of_answer, "unparsed");
    assert.deepEqual(o.chosen, []);
    assert.equal(o.invocation_id, "toolu_1");
    assert.equal(o.agreement, "unparsed");
  }
  assert.equal(rows[0].advice_shown, true);
  assert.equal(rows[0].response_shape, "string");
  assert.equal(rows[2].response_shape, "object:");
});

test("outcome: tool_response.content as a content-block array (text parts) is parsed like a string", async () => {
  const log = tmpLog();
  await runAnswerHook({ content: [{ type: "text", text: answered(["Pick a color", "Blue"]) }] }, log);
  const [o] = outcomes(log);
  assert.equal(o.question, "Pick a color");
  assert.deepEqual(o.chosen, ["Blue"]);
  assert.equal(o.kind_of_answer, "option");
});

test("outcome: multiple text parts are concatenated before matching, an escaped quote survives, and a bare string content works", async () => {
  const log = tmpLog();
  await runAnswerHook({ content: [{ type: "text", text: 'The user answered: "Where is it?"=' }, { type: "text", text: '"~/Downloads/logo.png". Read the answers carefully.' }] }, log);
  await runAnswerHook({ content: answered(["Stack?", 'No\\"de']) }, log);
  const [a, b] = outcomes(log);
  assert.deepEqual(a.chosen, ["~/Downloads/logo.png"]);
  assert.equal(a.kind_of_answer, "free_text");
  assert.deepEqual(b.chosen, ['No"de']);
});

test("answer hook is silent without an API key and never emits a decision on stdout", async () => {
  const log = tmpLog();
  const script = join(repoRoot, "hooks", "ask-jev-answer.mjs");
  const child = execFileAsync("node", [script], { env: { ...cleanEnv(), HOME: mkdtempSync(join(tmpdir(), "nohome-")), ASK_JEV_LOG_FILE: log }, encoding: "utf8" });
  child.child.stdin.end(JSON.stringify({ tool_name: "AskUserQuestion", tool_use_id: "t", tool_response: answered(["Q?", "A"]) }));
  const { stdout } = await child;
  assert.equal(stdout, "");
  assert.equal(outcomes(log).length, 0);
});

test("outcome: 3 questions, only 2 parse → the third gets an indexed unparsed outcome with its recommendation", async () => {
  const log = tmpLog();
  seedAdvice(log, "toolu_1", [{ question: "One?", advice: advised(["Blue"]) }, { question: "Two?", advice: advised(["Red"], 0.7) }, { question: "Three?", advice: advised(["Green"], 0.6) }]);
  await runAnswerHook(answered(["One?", "Blue"], ["Three?", "Red"]), log, { tool_input: toolInput({ question: "One?" }, { question: "Two?" }, { question: "Three?" }) });
  const rows = outcomes(log);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((o) => [o.question_index, o.question, o.kind_of_answer]), [[0, "One?", "option"], [1, "Two?", "unparsed"], [2, "Three?", "option"]]);
  assert.deepEqual(rows[1].recommended, ["Red"]);
  assert.equal(rows[1].recommended_confidence, 0.7);
  assert.deepEqual(rows[1].options, ["Blue", "Red", "Green"]);
  assert.deepEqual(rows.map((o) => o.agreement), ["agree", "unparsed", "disagree"]);
});

test("outcome: a fully unfamiliar response for 3 advised questions → 3 linked unparsed outcomes carrying recommendations", async () => {
  const log = tmpLog();
  seedAdvice(log, "toolu_1", [{ question: "One?", advice: advised(["Blue"]) }, { question: "Two?", advice: advised(["Red"], 0.7) }, { question: "Three?", advice: advised(["Green"], 0.6) }]);
  await runAnswerHook("Totally new Claude Code wording", log, { tool_input: toolInput({ question: "One?" }, { question: "Two?" }, { question: "Three?" }) });
  const rows = outcomes(log);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((o) => o.question_index), [0, 1, 2]);
  assert.deepEqual(rows.map((o) => o.question), ["One?", "Two?", "Three?"]);
  assert.deepEqual(rows.map((o) => o.recommended), [["Blue"], ["Red"], ["Green"]]);
  assert.deepEqual(rows.map((o) => o.recommended_confidence), [0.86, 0.7, 0.6]);
  assert.ok(rows.every((o) => o.kind_of_answer === "unparsed" && o.invocation_id === "toolu_1" && o.advice_shown === true));
});

test("outcome: unparsed with no advice rows falls back to tool_input.questions for the expected indexes", async () => {
  const log = tmpLog();
  await runAnswerHook("nope", log, { tool_input: toolInput({ question: "A?" }, { question: "B?" }) });
  const rows = outcomes(log);
  assert.deepEqual(rows.map((o) => [o.question_index, o.question, o.recommended]), [[0, "A?", null], [1, "B?", null]]);
});

test("outcome: matching is by exact key — 'Pick' vs 'Pick\\nmore' never cross-attribute, annotated or not, and the original question is logged", async () => {
  const log = tmpLog();
  seedAdvice(log, "toolu_1", [{ question: "Pick", advice: advised(["Blue"]) }, { question: "Pick\nmore", advice: advised(["Red"], 0.7) }]);
  const a0 = "Pick\n\n[1/2] Jev đề xuất: Blue (0.86) — b";
  const a1 = "Pick\nmore\n\n[2/2] Jev đề xuất: Red (0.70) — b";
  for (const [ti, resp] of [
    [toolInput({ question: "Pick" }, { question: "Pick\nmore" }), answered(["Pick", "Blue"], ["Pick\nmore", "Green"])],
    [toolInput({ question: a0 }, { question: a1 }), answered([a0, "Blue"], [a1, "Green"])],
    [undefined, answered([a0, "Blue"], [a1, "Green"])],
  ]) {
    await runAnswerHook(resp, log, ti ? { tool_input: ti } : {});
  }
  const rows = outcomes(log);
  assert.equal(rows.length, 6);
  for (let k = 0; k < 6; k += 2) {
    assert.deepEqual([rows[k].question_index, rows[k].question, rows[k].chosen, rows[k].agreement], [0, "Pick", ["Blue"], "agree"]);
    assert.deepEqual([rows[k + 1].question_index, rows[k + 1].question, rows[k + 1].chosen, rows[k + 1].agreement], [1, "Pick\nmore", ["Green"], "disagree"]);
  }
});

test("outcome: an answer key that is only a prefix-extension of a question is NOT attributed to it", async () => {
  const log = tmpLog();
  seedAdvice(log, "toolu_1", [{ question: "Pick", advice: advised(["Blue"]) }]);
  await runAnswerHook(answered(["Pick\nsomething else", "Red"]), log, { tool_input: toolInput({ question: "Pick" }) });
  const rows = outcomes(log);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].question_index, rows[0].kind_of_answer], [0, "unparsed"]);
  assert.equal(rows[1].question_index, undefined);
  assert.equal(rows[1].agreement, "no_advice");
});

// --- Claude Code 2.1.284 (S0): tool_response is an OBJECT {questions, answers:{<question>:<label>}, annotations} ---
const FRUIT = [{ label: "Apple", description: "red" }, { label: "Banana", description: "yellow" }];
const s0 = (answers, questions) => ({ questions, answers, annotations: {} });

test("S0 object: single pick under annotate (answers key = annotated text) → original question, recommended Banana, chosen Apple, disagree", async () => {
  const log = tmpLog();
  const adviceText = "Jev đề xuất: Banana (0.86) — yellow";
  seedAdvice(log, "toolu_1", [{ question: "Which fruit?", advice: { ...advised(["Banana"]), advice_text: adviceText } }]);
  const annotated = `Which fruit?\n\n${adviceText}`;
  const questions = [{ question: annotated, header: "Fruit", multiSelect: false, options: [FRUIT[0], { ...FRUIT[1], description: "yellow (Jev đề xuất)" }] }];
  await runAnswerHook(s0({ [annotated]: "Apple" }, questions), log, { tool_input: { questions } });
  const [o] = outcomes(log);
  assert.deepEqual([o.question_index, o.question, o.chosen, o.kind_of_answer, o.agreement], [0, "Which fruit?", ["Apple"], "option", "disagree"]);
  assert.deepEqual(o.recommended, ["Banana"]);
  assert.equal(o.advice_shown, true);
  assert.deepEqual(o.options, ["Apple", "Banana"]);
});

test("S0 object: plain (unannotated) key, and no tool_input at all (index fallback via tool_response.questions)", async () => {
  const log = tmpLog();
  seedAdvice(log, "toolu_1", [{ question: "Which fruit?", advice: advised(["Banana"]) }]);
  await runAnswerHook(s0({ "Which fruit?": "Banana" }, [{ question: "Which fruit?", options: FRUIT }]), log, { tool_input: { questions: [{ question: "Which fruit?", options: FRUIT }] } });
  await runAnswerHook(s0({ "Which fruit?": "Banana" }, [{ question: "Which fruit?", options: FRUIT }]), log, {});
  const rows = outcomes(log);
  assert.equal(rows.length, 2);
  for (const o of rows) assert.deepEqual([o.question, o.chosen, o.agreement, o.question_index], ["Which fruit?", ["Banana"], "agree", 0]);
});

test("S0 object: multiSelect as array and as ', '-joined string", async () => {
  const opts = [...FRUIT, { label: "Cherry, dark", description: "c" }];
  for (const value of [["Banana", "Cherry, dark"], "Banana, Cherry, dark"]) {
    const log = tmpLog();
    seedAdvice(log, "toolu_1", [{ question: "Fruits?", advice: advised(["Banana", "Apple"], 0.9) }]);
    const questions = [{ question: "Fruits?", multiSelect: true, options: opts }];
    await runAnswerHook(s0({ "Fruits?": value }, questions), log, { tool_input: { questions } });
    const [o] = outcomes(log);
    assert.deepEqual(o.chosen, ["Banana", "Cherry, dark"]);
    assert.equal(o.agreement, "partial");
    assert.equal(o.kind_of_answer, "option");
  }
});

test("S0 object: free text 'Other' → free_text kind, still carries the recommendation", async () => {
  const log = tmpLog();
  seedAdvice(log, "toolu_1", [{ question: "Which fruit?", advice: advised(["Banana"]) }]);
  const questions = [{ question: "Which fruit?", options: FRUIT }];
  await runAnswerHook({ ...s0({ "Which fruit?": "dragon fruit" }, questions), annotations: { "Which fruit?": { notes: "x" } } }, log, { tool_input: { questions } });
  const [o] = outcomes(log);
  assert.deepEqual([o.kind_of_answer, o.agreement, o.chosen, o.question], ["free_text", "free_text", ["dragon fruit"], "Which fruit?"]);
  assert.deepEqual(o.recommended, ["Banana"]);
});

test("S0 object: answers whose keys match no question → indexed unparsed for the expected question plus an unindexed outcome; unknown object → indexed unparsed", async () => {
  const log = tmpLog();
  seedAdvice(log, "toolu_1", [{ question: "Which fruit?", advice: advised(["Banana"]) }]);
  const questions = [{ question: "Which fruit?", options: FRUIT }];
  await runAnswerHook(s0({ "Something else entirely": "Apple" }, questions), log, { tool_input: { questions } });
  await runAnswerHook({ weird: true }, log, { tool_input: { questions } });
  const rows = outcomes(log);
  assert.equal(rows.length, 3);
  assert.deepEqual([rows[0].question_index, rows[0].kind_of_answer, rows[0].recommended], [0, "unparsed", ["Banana"]]);
  assert.equal(rows[1].question_index, undefined);
  assert.deepEqual([rows[2].question_index, rows[2].kind_of_answer, rows[2].response_shape], [0, "unparsed", "object:weird"]);
});

test("S0 object: failure-annotated key (advice_unavailable row with note_shown) is matched exactly", async () => {
  const log = tmpLog();
  const note = "Jev: không có đề xuất (lỗi 500) — bạn tự quyết";
  seedAdvice(log, "toolu_1", [{ question: "Which fruit?", advice: { outcome: "advice_unavailable", reason: "provider_error", note_shown: true, advice_text: note } }]);
  const annotated = `Which fruit?\n\n${note}`;
  await runAnswerHook(s0({ [annotated]: "Apple" }, [{ question: annotated, options: FRUIT }]), log, { tool_input: { questions: [{ question: annotated, options: FRUIT }] } });
  const [o] = outcomes(log);
  assert.deepEqual([o.question_index, o.question, o.chosen, o.agreement, o.advice_shown], [0, "Which fruit?", ["Apple"], "no_advice", false]);
});

test("outcome loop is clamped to 10 questions (hostile tool_input with a huge questions array)", async () => {
  const log = tmpLog();
  const questions = Array.from({ length: 5000 }, (_, i) => ({ question: `q${i}?`, options: OPTS }));
  await runAnswerHook("nothing parseable", log, { tool_input: { questions } });
  assert.equal(outcomes(log).length, 10);
});

test("total outcome rows per invocation are capped at 10 even with 1000 unknown answer keys", async () => {
  const log = tmpLog();
  const answers = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`unknown ${i}`, "x"]));
  await runAnswerHook({ questions: [], answers, annotations: {} }, log, { tool_input: toolInput({ question: "Real?" }) });
  assert.equal(outcomes(log).length, 10);
});
