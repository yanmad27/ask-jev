#!/usr/bin/env node
/** Nhắc luật hỏi Jev vào mọi phiên, không chỉ khi AskUserQuestion hay skill được nạp. */
import { fileURLToPath } from "node:url";
import { apiKey } from "../lib/jev.mjs";
import { sessionStartRule } from "../lib/guidance.mjs";

const key = apiKey();
if (!key) process.exit(0);

const jevPath = fileURLToPath(new URL("../bin/jev.mjs", import.meta.url));

const rule = sessionStartRule(jevPath);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: rule },
}));
