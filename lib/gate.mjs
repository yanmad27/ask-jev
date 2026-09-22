import { readFileSync } from "node:fs";
import { apiKey } from "./jev.mjs";

const DEFAULT_GATES = "permission,stop,bash,prompt";

export const FOCUS = "Weigh state in this order: preferences override defaults; current_task/recent_user_messages define scope " +
  "(the user's original ask is the ground truth); action is the exact thing being judged; plan_and_todos and session_summary give " +
  "the rest of the session; conversation is recent detail; history is Jev's own past decisions this session — stay consistent; " +
  "workspace is current git state.";

export const DESTRUCTIVE = {
  true: "Would destroy or expose something that cannot be undone: deletes files outside the workspace, drops data, " +
    "force-pushes or rewrites shared history, publishes/deploys/pays/sends to third parties, or leaks secrets",
  false: "Reversible, scoped inside the workspace, or already something the user explicitly asked for",
};

/** JEV_AUTONOMY: "full" (mặc định — Jev tự quyết, chỉ việc destructive mới hỏi lại) hay "safe" (giữ hành vi cũ). */
export function autonomy() {
  return process.env.JEV_AUTONOMY === "safe" ? "safe" : "full";
}

/** Bật/tắt từng gate qua JEV_GATES (danh sách phẩy); rỗng = tắt hết. Không key = tắt hết. */
export function enabled(name) {
  if (!apiKey()) return false;
  const list = (process.env.JEV_GATES ?? DEFAULT_GATES).split(",").map((s) => s.trim());
  return list.includes(name);
}

export function tailText(s, n) {
  if (typeof s !== "string") return "";
  return s.split("\n").slice(-n).join("\n");
}

export function truncate(s, n) {
  if (typeof s !== "string") return "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function readStdinJson() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}
