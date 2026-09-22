import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { logFilePath } from "./jev.mjs";

// Thực đo (xem README "Automatic gates"): 90k ký tự vẫn 200 OK, gateway không công bố
// giới hạn. 100k là trần có biên an toàn, không phải trần đo được thật sự.
const DEFAULT_CAP = 100_000;

function cap(s, n) {
  if (typeof s !== "string") return "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      if (p.type === "text") return p.text;
      if (p.type === "tool_use") return `[called ${p.name}]`;
      if (p.type === "tool_result") {
        const t = typeof p.content === "string"
          ? p.content
          : Array.isArray(p.content) ? p.content.map((c) => c.text ?? "").join(" ") : "";
        return `[tool result: ${t.slice(0, 300)}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function readRows(path) {
  let lines;
  try {
    lines = readFileSync(path, "utf8").split("\n");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.isSidechain || row.isMeta) continue;
    if (row.type !== "user" && row.type !== "assistant") continue;
    rows.push(row);
  }
  return rows;
}

/** Tách turn thường khỏi summary nén (Claude Code ghi lại sau /compact: user row có isCompactSummary=true). */
function splitTurnsAndSummary(rows) {
  const plain = rows.filter((r) => !(r.type === "user" && r.isCompactSummary));
  const summaryRow = [...rows].reverse().find((r) => r.type === "user" && r.isCompactSummary);
  const turns = plain
    .map((r) => `${r.type === "user" ? "User" : "Claude"}: ${textOf(r.message?.content)}`)
    .filter((t) => !/^(User|Claude): *$/.test(t));
  const userTexts = plain.filter((r) => r.type === "user").map((r) => textOf(r.message?.content)).filter(Boolean);
  return {
    turns,
    recentUserMessages: userTexts.slice(-5),
    currentTask: userTexts.at(-1) ?? "",
    sessionSummary: summaryRow ? textOf(summaryRow.message?.content) : "",
  };
}

/** CLAUDE.md (global, project root, project .claude/) + MEMORY.md — đúng thứ tự Claude Code tự nạp. */
function readPreferences(cwd) {
  const slug = cwd ? cwd.replace(/\//g, "-") : "";
  const candidates = [
    join(homedir(), ".claude", "CLAUDE.md"),
    cwd ? join(cwd, "CLAUDE.md") : null,
    cwd ? join(cwd, ".claude", "CLAUDE.md") : null,
    slug ? join(homedir(), ".claude", "projects", slug, "memory", "MEMORY.md") : null,
  ].filter(Boolean);

  let text = "";
  const budget = 8_000;
  for (const path of candidates) {
    if (text.length >= budget) break;
    let content;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    text += `\n--- ${path} ---\n${content}`;
  }
  return {
    _note: "User/project preferences and conventions (CLAUDE.md, persistent memory) — these override generic defaults.",
    content: cap(text.trim(), budget),
  };
}

function findLastTodoWrite(rows) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const content = rows[i].message?.content;
    if (rows[i].type !== "assistant" || !Array.isArray(content)) continue;
    const tw = [...content].reverse().find((p) => p.type === "tool_use" && p.name === "TodoWrite");
    if (tw?.input?.todos) return tw.input.todos;
  }
  return null;
}

function findPlanFile(rows) {
  const pathRe = /(~?\/?\.claude\/plans\/[^\s"'`]+\.md)/;
  for (const row of rows.slice(-20).reverse()) {
    const m = pathRe.exec(textOf(row.message?.content));
    if (!m) continue;
    const raw = m[1];
    const resolved = raw.startsWith("/") ? raw : join(homedir(), raw.replace(/^~\//, ""));
    try {
      return cap(readFileSync(resolved, "utf8"), 4_000);
    } catch {
      continue;
    }
  }
  return null;
}

function readPlanAndTodos(rows) {
  const todos = findLastTodoWrite(rows);
  const plan = findPlanFile(rows);
  if (!todos && !plan) return null;
  return {
    _note: "The latest TodoWrite state and/or a referenced plan file — what's in flight and what's left.",
    todos: todos ?? undefined,
    plan: plan ?? undefined,
  };
}

/** 10 quyết định gần nhất của Jev trong CHÍNH phiên này — để Jev nhất quán với chính nó. */
function readHistory(sessionId) {
  if (!sessionId) return null;
  let lines;
  try {
    lines = readFileSync(logFilePath(), "utf8").split("\n");
  } catch {
    return null;
  }
  const decisions = [];
  for (let i = lines.length - 1; i >= 0 && decisions.length < 10; i--) {
    if (!lines[i].trim()) continue;
    let e;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (e.kind !== "decision" || e.session_id !== sessionId) continue;
    decisions.unshift({ gate: e.gate, question: e.question, outcome: e.outcome, label: e.label, confidence: e.confidence });
  }
  if (decisions.length === 0) return null;
  return { _note: "Jev's own recent decisions this session — stay consistent, and notice what the user overrode.", decisions };
}

/**
 * 30 lần gần nhất người dùng thực sự CHỌN gì khi được hỏi (mọi phiên) — bằng chứng
 * mạnh nhất về preference, mạnh hơn hẳn một đoạn mô tả do LLM tự viết (đo thực tế:
 * cùng câu hỏi, "user preferences" do LLM viết → 0.98 sai lựa chọn; 7 lựa chọn thật
 * của người dùng → 1.00 đúng). Cùng thư mục (cwd) trước, phiên khác xếp sau.
 */
function readUserPastChoices(cwd) {
  let lines;
  try {
    lines = readFileSync(logFilePath(), "utf8").split("\n");
  } catch {
    return null;
  }
  const sameCwd = [];
  const otherCwd = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let e;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (e.kind !== "user_choice") continue;
    const row = { question: e.question, options: e.options, chosen: e.chosen };
    (e.cwd === cwd ? sameCwd : otherCwd).push(row);
    if (sameCwd.length + otherCwd.length >= 30) break;
  }
  const choices = [...sameCwd, ...otherCwd].slice(0, 30);
  if (choices.length === 0) return null;
  return { _note: "What the user actually chose when asked — the strongest evidence of their preferences. Same-project choices first.", choices };
}

/** Lệnh/pattern người dùng đã allow/deny sẵn — Jev không được chấm risky cho cái đã allow-list. */
function readPermissions(cwd) {
  const paths = [
    join(homedir(), ".claude", "settings.json"),
    cwd ? join(cwd, ".claude", "settings.json") : null,
    cwd ? join(cwd, ".claude", "settings.local.json") : null,
  ].filter(Boolean);
  const allow = [];
  const deny = [];
  for (const path of paths) {
    try {
      const settings = JSON.parse(readFileSync(path, "utf8"));
      allow.push(...(settings.permissions?.allow ?? []));
      deny.push(...(settings.permissions?.deny ?? []));
    } catch {
      continue;
    }
  }
  if (allow.length === 0 && deny.length === 0) return null;
  let dedupedAllow = [...new Set(allow)];
  let dedupedDeny = [...new Set(deny)];
  while (JSON.stringify({ allow: dedupedAllow, deny: dedupedDeny }).length > 2_000 && (dedupedAllow.length || dedupedDeny.length)) {
    if (dedupedDeny.length) dedupedDeny.pop();
    else dedupedAllow.pop();
  }
  return {
    _note: "Patterns the user already allow-/deny-listed — an allow-listed command is not risky by definition.",
    allow: dedupedAllow,
    deny: dedupedDeny,
  };
}

function readWorkspace(cwd) {
  const run = (args) => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  return {
    _note: "Current git state — branch, what's changed, the actual diff of uncommitted work, and the file list.",
    branch: run(["branch", "--show-current"]),
    status: run(["status", "--short"]).split("\n").slice(0, 40).join("\n"),
    diffStat: run(["diff", "--stat"]).split("\n").slice(0, 40).join("\n"),
    diff: cap(run(["diff"]), 6_000),
    files: run(["ls-files"]).split("\n").slice(0, 60).join("\n"),
  };
}

function sizeOf(obj) {
  return obj ? JSON.stringify(obj).length : 0;
}

/**
 * State đầy đủ như một reviewer thật sẽ xem, đúng thứ tự ưu tiên: preferences (verbatim,
 * không tự diễn giải) > user_past_choices (bằng chứng mạnh nhất — người dùng từng chọn gì)
 * > task hiện tại > action đang xét > plan/todo > tóm tắt phiên (/compact) > conversation
 * (lấp phần ngân sách còn lại) > history quyết định của chính Jev > permissions đã
 * allow-list > workspace > env. 4 phần cuối bị bỏ nếu hết ngân sách. `sizes` trả riêng để
 * caller log kích thước, không log nội dung.
 */
export function buildState({ transcriptPath, cwd, sessionId, action, extra }) {
  const jevCap = Number(process.env.JEV_STATE_CHARS ?? DEFAULT_CAP);
  const rows = readRows(transcriptPath);
  const { turns, recentUserMessages, currentTask, sessionSummary } = splitTurnsAndSummary(rows);

  const preferences = readPreferences(cwd);
  const userPastChoices = readUserPastChoices(cwd);
  const task = {
    _note: "The latest user messages define the current task; earlier ones are background. Preferences (above) override defaults.",
    current_task: currentTask,
    recent_user_messages: recentUserMessages,
  };
  const planAndTodos = readPlanAndTodos(rows);
  const sessionSummaryObj = sessionSummary
    ? { _note: "Summary of everything before the current context window (from /compact) — the session didn't start at the first visible turn.", text: cap(sessionSummary, 4_000) }
    : null;

  const sizes = {
    preferences: sizeOf(preferences),
    user_past_choices: sizeOf(userPastChoices),
    task: sizeOf(task),
    action: sizeOf(action),
    plan_and_todos: sizeOf(planAndTodos),
    session_summary: sizeOf(sessionSummaryObj),
    extra: sizeOf(extra),
  };
  let used = Object.values(sizes).reduce((a, b) => a + b, 0);

  let budget = Math.max(0, jevCap - used);
  const conversationTurns = [];
  for (let i = turns.length - 1; i >= 0 && budget > 0; i--) {
    // JSON.stringify, không .length thô — escaping (\n, \") làm chuỗi thật dài hơn.
    const turnSize = JSON.stringify(turns[i]).length;
    if (turnSize > budget) break;
    conversationTurns.unshift(turns[i]);
    budget -= turnSize;
  }
  const conversation = { _note: "Recent conversation turns, newest first, filling whatever budget is left.", turns: conversationTurns };
  sizes.conversation = sizeOf(conversation);
  used += sizes.conversation;

  const state = { preferences, task, conversation };
  if (userPastChoices) state.user_past_choices = userPastChoices;
  if (action) state.action = action;
  if (planAndTodos) state.plan_and_todos = planAndTodos;
  if (sessionSummaryObj) state.session_summary = sessionSummaryObj;
  if (extra) state.extra = extra;

  // 4 phần cuối cùng ưu tiên thấp nhất — bỏ từng phần nếu hết ngân sách, vẫn log kích
  // thước thật để biết cái gì bị cắt.
  const tail = [
    ["history", readHistory(sessionId)],
    ["permissions", readPermissions(cwd)],
    ["workspace", readWorkspace(cwd)],
    ["env", { _note: "Where and when this is happening.", cwd, now: new Date().toISOString(), platform: process.platform }],
  ];
  for (const [name, obj] of tail) {
    const size = sizeOf(obj);
    sizes[name] = size;
    if (obj && used + size <= jevCap) {
      state[name] = obj;
      used += size;
    }
  }

  return { state, sizes };
}

export function hasContext(state) {
  return Boolean(state.task.current_task || state.task.recent_user_messages.length > 0 || state.conversation.turns.length > 0);
}
