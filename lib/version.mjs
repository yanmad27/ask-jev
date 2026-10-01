import { readFileSync } from "node:fs";

function readVersion() {
  try {
    return JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

export const VERSION = readVersion();
