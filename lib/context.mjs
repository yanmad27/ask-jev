import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { logFilePath } from "./jev.mjs";
import { env } from "./env.mjs";

// Thực đo (xem README "Automatic gates"): 90k ký tự vẫn 200 OK, gateway không công bố
// giới hạn. 100k là trần có biên an toàn, không phải trần đo được thật sự.
const DEFAULT_CAP = 100_000;
const TRUNC_MARKER = "…[truncated]";

function cap(s, n) {
  if (typeof s !== "string") return "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Cắt MỘT field cho vừa `budget` ký tự thật (JSON.stringify), giữ phần đầu, đánh dấu bị
 * cắt — không cố cắt khéo theo cấu trúc con (mỗi field một shape khác nhau), đổi lại đơn
 * giản và luôn đúng: field bị cắt trở thành string thô thay vì object, Jev vẫn đọc được.
 * Không đủ chỗ cho cả marker thì bỏ hẳn field (trả về undefined).
 */
function fitField(value, budget) {
  const full = JSON.stringify(value);
  if (full.length <= budget) return value;
  let headLen = budget - TRUNC_MARKER.length - 2; // trừ 2 cho dấu ngoặc kép bao ngoài
  // `full` có sẵn dấu " của JSON gốc — cắt xong bọc lại thành string thì mỗi dấu " đó
  // escape thành \", dài hơn ước lượng ban đầu. Cắt thêm đúng phần dôi ra, luôn hội tụ
  // sau tối đa vài vòng vì bớt k ký tự nguồn thì output escape giảm ít nhất k.
  for (let i = 0; i < 5 && headLen > 0; i++) {
    const candidate = full.slice(0, headLen) + TRUNC_MARKER;
    const over = JSON.stringify(candidate).length - budget;
    if (over <= 0) return candidate;
    headLen -= over;
  }
  return undefined;
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
  const plansDir = resolve(homedir(), ".claude", "plans") + sep;
  const pathRe = /(~?\/?\.claude\/plans\/[^\s"'`]+\.md)/;
  for (const row of rows.slice(-20).reverse()) {
    const m = pathRe.exec(textOf(row.message?.content));
    if (!m) continue;
    const raw = m[1];
    const candidate = raw.startsWith("/") ? raw : join(homedir(), raw.replace(/^~\//, ""));
    const resolved = resolve(candidate);
    if (!resolved.startsWith(plansDir)) continue; // "../" ra ngoài ~/.claude/plans — bỏ qua (path traversal)
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
    const row = { question: e.question, chosen: e.chosen, kind_of_answer: e.kind_of_answer };
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
  return {
    _note: "Patterns the user already allow-/deny-listed — an allow-listed command is not risky by definition.",
    allow: [...new Set(allow)],
    deny: [...new Set(deny)],
  };
}

// Tracked file vẫn có thể là .env/.pem/.key/*secret* — bỏ hẳn hunk của các file đó khỏi
// diff, dù đã ở trong workspace (đừng để Jev nhìn thấy nội dung secret qua đường vòng).
const SENSITIVE_PATH = /(\.env(\.|$)|\.pem$|\.key$|secret)/i;
function redactSensitiveDiff(diffText) {
  let skip = false;
  return diffText
    .split("\n")
    .filter((line) => {
      const m = /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
      if (m) skip = SENSITIVE_PATH.test(m[1]) || SENSITIVE_PATH.test(m[2]);
      return !skip;
    })
    .join("\n");
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
    diff: cap(redactSensitiveDiff(run(["diff"])), 6_000),
    files: run(["ls-files"]).split("\n").slice(0, 60).join("\n"),
  };
}

/**
 * State đầy đủ như một reviewer thật sẽ xem, đúng thứ tự ưu tiên: preferences (verbatim,
 * không tự diễn giải) > user_past_choices (bằng chứng mạnh nhất — người dùng từng chọn gì)
 * > task hiện tại > action đang xét > plan/todo > tóm tắt phiên (/compact) > conversation
 * (lấp phần ngân sách còn lại) > history quyết định của chính Jev > permissions đã
 * allow-list > workspace > env.
 *
 * Ngân sách được ép trên kích thước THẬT của state đã lấy đến đó (JSON.stringify), không
 * phải tổng ước lượng riêng từng field cộng lại — bug cũ: mỗi field tự cap riêng (vd
 * preferences 8k) rồi LUÔN được đưa nguyên vào bất kể jevCap, nên jevCap nhỏ (vd test với
 * cap=1000) vẫn lọt qua state to gấp 8-9 lần. Field không vừa nữa thì bị cắt (giữ đầu,
 * đánh dấu `…[truncated]`) hoặc bỏ hẳn nếu không còn tí chỗ nào — `add()` áp dụng đều cho
 * mọi field theo đúng thứ tự ưu tiên ở trên. `sizes` trả riêng để caller log kích thước,
 * không log nội dung.
 */
export function buildState({ transcriptPath, cwd, sessionId, action, extra }) {
  const jevCap = Number(env("STATE_CHARS", DEFAULT_CAP));
  const rows = readRows(transcriptPath);
  const { turns, recentUserMessages, currentTask, sessionSummary } = splitTurnsAndSummary(rows);

  const state = {};
  const sizes = {};
  let used = 2; // { } bao ngoài state
  function add(name, value) {
    if (!value) {
      sizes[name] = 0;
      return;
    }
    // Ngân sách cho field còn phải trừ tiếp `"name":` + dấu phẩy của chính nó trong state
    // bao ngoài — không tính riêng size của value thôi (bug đã gặp: state tổng vượt cap
    // dù mỗi field tự nó "vừa", vì thiếu phần overhead key/dấu phẩy này).
    const overhead = name.length + 4;
    const fitted = fitField(value, jevCap - used - overhead);
    if (fitted === undefined) {
      sizes[name] = 0;
      return;
    }
    state[name] = fitted;
    sizes[name] = JSON.stringify(fitted).length;
    used += sizes[name] + overhead;
  }

  add("preferences", readPreferences(cwd));
  add("user_past_choices", readUserPastChoices(cwd));
  add("task", {
    _note: "The latest user messages define the current task; earlier ones are background. Preferences (above) override defaults.",
    current_task: currentTask,
    recent_user_messages: recentUserMessages,
  });
  add("action", action);
  add("plan_and_todos", readPlanAndTodos(rows));
  add("session_summary", sessionSummary
    ? { _note: "Summary of everything before the current context window (from /compact) — the session didn't start at the first visible turn.", text: cap(sessionSummary, 4_000) }
    : null);

  // conversation lấp phần ngân sách còn lại — giữ nguyên hoặc bỏ cả turn, không cắt giữa
  // câu, nên đi qua vòng lặp riêng trước khi add() (add() sẽ không cần cắt thêm vì đã vừa).
  const conversationTurns = [];
  let convBudget = jevCap - used - 60; // chừa chỗ khung {"_note":"...","turns":[...]}
  for (let i = turns.length - 1; i >= 0 && convBudget > 0; i--) {
    const turnSize = JSON.stringify(turns[i]).length;
    if (turnSize > convBudget) break;
    conversationTurns.unshift(turns[i]);
    convBudget -= turnSize;
  }
  add("conversation", { _note: "Recent conversation turns, newest first, filling whatever budget is left.", turns: conversationTurns });

  add("history", readHistory(sessionId));
  add("permissions", readPermissions(cwd));
  add("workspace", readWorkspace(cwd));
  add("env", { _note: "Where and when this is happening.", cwd, now: new Date().toISOString(), platform: process.platform });
  add("extra", extra);

  return { state, sizes };
}

export function hasContext(state) {
  return Boolean(state.task?.current_task || state.task?.recent_user_messages?.length > 0 || state.conversation?.turns?.length > 0);
}
