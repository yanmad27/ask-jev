#!/usr/bin/env node
/**
 * Tự đăng ký PreToolUse hook thẳng vào settings.json của người dùng.
 *
 * Bug hiện tại của Claude Code (anthropics/claude-code#36397): PreToolUse hook
 * khai trong hooks/hooks.json của plugin không chạy — chỉ SessionStart chạy
 * được từ plugin. Nên hook chính (ask-jev.mjs) không bao giờ được gọi dù cài
 * đúng, key đúng, API đúng. Script này chạy mỗi SessionStart (cơ chế
 * plugin duy nhất còn hoạt động) để tự ghi entry PreToolUse cho
 * AskUserQuestion thẳng vào settings.json — nơi hook khai trực tiếp vẫn chạy
 * bình thường.
 *
 * Tự sửa mỗi phiên: bản plugin đổi (cache dir đổi theo version), hay đường dẫn
 * cũ từ trước lần đổi tên jev-ask → ask-jev, đều tự cập nhật lại, không cần
 * người dùng làm gì. Hết bug ở Claude Code thì entry này thừa nhưng vô hại —
 * hai hook cùng "deny" một câu hỏi không sai, chỉ tốn thêm một lần gọi API.
 *
 * Không đụng gì khác trong settings.json ngoài đúng entry của mình. Đọc/ghi
 * lỗi kiểu gì cũng im lặng bỏ qua — hook phụ này không được phép làm hỏng
 * settings.json của người dùng.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "ask-jev.mjs";
const LEGACY_MARKER = "jev-ask.mjs";
const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

function ourHook(hookPath) {
  return {
    type: "command",
    command: `node "${hookPath}"`,
    timeout: 15,
    statusMessage: "Asking Jev before asking you...",
  };
}

function isOurs(hook) {
  return hook.command?.includes(MARKER) || hook.command?.includes(LEGACY_MARKER);
}

function main() {
  const hookPath = fileURLToPath(new URL("./ask-jev.mjs", import.meta.url));
  const desired = ourHook(hookPath);

  let settings;
  try {
    settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") return; // file hỏng: không đụng vào
    settings = {};
  }

  settings.hooks ??= {};
  settings.hooks.PreToolUse ??= [];
  const list = settings.hooks.PreToolUse;

  const block = list.find((b) => b.matcher === "AskUserQuestion" && (b.hooks ?? []).some(isOurs));

  if (!block) {
    list.push({ matcher: "AskUserQuestion", hooks: [desired] });
  } else {
    const hook = block.hooks.find(isOurs);
    if (hook.command === desired.command) return; // đã đúng, khỏi ghi
    Object.assign(hook, desired);
  }

  writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
}

// Im lặng tuyệt đối: hook phụ này không bao giờ được phép chặn phiên hay báo lỗi.
try {
  main();
} catch {}
