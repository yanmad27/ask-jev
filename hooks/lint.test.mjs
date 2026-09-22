import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function allMjsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allMjsFiles(path));
    else if (entry.name.endsWith(".mjs")) out.push(path);
  }
  return out;
}

function allTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allTsFiles(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

const files = [...allMjsFiles("hooks"), ...allMjsFiles("lib")];
const tsFiles = [...allTsFiles("paseo-plugin/server"), ...(readdirSync("paseo-plugin").includes("index.server.ts") ? ["paseo-plugin/index.server.ts"] : [])];

test("no criteria bucket named undetermined/unsure/other/unknown (real regression: a fallback bucket that just echoes the evidence back scores 1.0 and decides nothing)", () => {
  const offenders = [];
  const keyPattern = /\b(undetermined|unsure|other|unknown)\s*:/;
  for (const path of files) {
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (keyPattern.test(line)) offenders.push(`${path}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test("only lib/env.mjs reads legacy JEV_-prefixed env vars directly — everything else goes through env()", () => {
  const offenders = [];
  const pattern = /process\.env\.JEV_/;
  for (const path of files) {
    if (path === join("lib", "env.mjs") || path.includes("lint.test")) continue;
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (pattern.test(line)) offenders.push(`${path}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test("no gate hand-writes a preferences/user_* string literal (evidence only — lib/context.mjs is the only source, from real files/logs)", () => {
  const offenders = [];
  const literalPattern = /\b(preferences|user_\w+)\s*[:=]\s*["'`]/;
  for (const path of files) {
    if (path === join("lib", "context.mjs")) continue;
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (literalPattern.test(line)) offenders.push(`${path}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test("paseo-plugin mirrors lib/env.mjs: JEV_ env reads must have ASK_JEV_ first on same line", () => {
  const offenders = [];
  for (const path of tsFiles) {
    if (path === "hooks/lint.test.mjs") continue;
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/[^"'`]process\.env\.JEV_/.test(line) || /^\s*process\.env\.JEV_/.test(line)) {
        const askIdx = line.indexOf("ASK_JEV_");
        const jevIdx = line.indexOf("process.env.JEV_");
        if (askIdx === -1 || askIdx > jevIdx) offenders.push(`${path}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, []);
});
