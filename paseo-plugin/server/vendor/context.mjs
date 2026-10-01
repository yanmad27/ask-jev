import { readFileSync, openSync, closeSync, fstatSync, readSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { logFilePath } from "./jev.mjs";
import { env } from "./env.mjs";

// Thực đo (xem README "Automatic gates"): text dày 80k ký tự qua, 90k bị 400 max_tokens_exceeded (state ≤ 32k token)
// 70k là trần có biên an toàn dưới mức đó.
const DEFAULT_CAP = 70_000;
const TRUNC_MARKER = "…[truncated]";
// Tin nhắn người gõ: giữ nguyên văn, mỗi tin tối đa MESSAGE_CAP để một đoạn paste khổng lồ không đẩy hết phần còn lại ra
// khỏi state (5 tin × 3000 = 15k, ≤ 1/4 trần 70k). Turn hội thoại cũng bị cắt TURN_CAP vì cùng lý do.
const MESSAGE_CAP = 3_000;
const TURN_CAP = 4_000;
const RECENT_USER_MESSAGES = 5;

function capMarked(s, n) {
  return s.length > n ? `${s.slice(0, n - TRUNC_MARKER.length)}${TRUNC_MARKER}` : s;
}

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

/** Chỉ text người gõ: tool_result (Claude Code lưu dưới dạng row type "user") và tool_use không phải lời người dùng. */
function humanText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n").trim();
}

// Cùng bộ lọc cho cả row đọc từ file transcript lẫn row Paseo đưa thẳng vào (buildState's
// transcriptRows) — sidechain/meta bỏ qua, chỉ giữ turn user/assistant thật.
function filterRows(rows) {
  return rows.filter((row) => row && !row.isSidechain && !row.isMeta && (row.type === "user" || row.type === "assistant"));
}

// Transcript có thể to hàng trăm MB: chỉ đọc phần đuôi (hook có timeout), bỏ dòng đầu nếu bị cắt giữa chừng.
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;

function readTranscriptLines(path) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
    const lines = buf.subarray(0, got).toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines;
  } finally {
    closeSync(fd);
  }
}

function readRows(path) {
  let lines;
  try {
    lines = readTranscriptLines(path);
  } catch {
    return [];
  }
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return filterRows(rows);
}

/** Tách turn thường khỏi summary nén (Claude Code ghi lại sau /compact: user row có isCompactSummary=true). */
function splitTurnsAndSummary(rows) {
  const plain = rows.filter((r) => !(r.type === "user" && r.isCompactSummary));
  const summaryRow = [...rows].reverse().find((r) => r.type === "user" && r.isCompactSummary);
  const turns = plain
    .map((r) => `${r.type === "user" ? "User" : "Claude"}: ${textOf(r.message?.content)}`)
    .filter((t) => !/^(User|Claude): *$/.test(t))
    .map((t) => capMarked(t, TURN_CAP));
  const userTexts = plain.filter((r) => r.type === "user").map((r) => humanText(r.message?.content)).filter(Boolean);
  const recent = userTexts.slice(-RECENT_USER_MESSAGES).map((t) => capMarked(t, MESSAGE_CAP));
  return {
    turns,
    recentUserMessages: recent,
    currentTask: recent.at(-1) ?? "",
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
export function readUserPastChoices(cwd) {
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
    if (e.kind !== "user_choice" && e.kind !== "outcome") continue; // user_choice = schema v1, outcome = v2
    const row = { question: e.question, chosen: e.chosen, kind_of_answer: e.kind_of_answer };
    if (e.kind === "outcome" && Array.isArray(e.recommended)) {
      row.jev_recommended = e.recommended;
      if (e.agreement) row.agreement = e.agreement;
    }
    (e.cwd === cwd ? sameCwd : otherCwd).push(row);
    if (sameCwd.length + otherCwd.length >= 30) break;
  }
  const choices = [...sameCwd, ...otherCwd].slice(0, 30);
  if (choices.length === 0) return null;
  return { _note: "What the user actually chose when asked — the strongest evidence of their preferences. Same-project choices first. jev_recommended/agreement, when present, show what Jev advised and whether the user went along.", choices };
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
 *
 * `transcriptRows`, khi có, thay hẳn việc đọc `transcriptPath` — dùng bởi Paseo plugin, nơi
 * hội thoại đến từ timeline của agent chứ không phải file transcript Claude Code, nên khỏi
 * phải ghi ra file tạm rồi đọc lại. Cùng shape hàng với transcript thật ({type, isSidechain,
 * isMeta, message: {content}, isCompactSummary}); lọc qua filterRows() giống hệt đường file.
 */
export function buildState({ transcriptPath, transcriptRows = undefined, cwd, sessionId, action, extra }) {
  const jevCap = Number(env("STATE_CHARS", DEFAULT_CAP));
  const rows = transcriptRows ? filterRows(transcriptRows) : readRows(transcriptPath);
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
