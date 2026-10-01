import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { cleanEnv } from "./testenv.mjs";

const root = new URL("../", import.meta.url);
const skill = readFileSync(new URL("skills/ask-jev/SKILL.md", root), "utf8");
const sessionStart = JSON.parse(execFileSync("node", [new URL("hooks/session-start.mjs", root).pathname], { env: { ...cleanEnv(), ASK_JEV_API_KEY: "k-12345678" } }).toString()).hookSpecificOutput.additionalContext;
const promptSrc = readFileSync(new URL("hooks/gates/prompt.mjs", root), "utf8");
const reminder = promptSrc.slice(promptSrc.indexOf("const REMINDER"), promptSrc.indexOf("\n", promptSrc.indexOf("const REMINDER")));

const texts = { SessionStart: sessionStart, UserPromptSubmit: reminder, SKILL: skill };

for (const [name, text] of Object.entries(texts)) {
  test(`${name}: states the advise/decide split and the never-via-CLI rule`, () => {
    assert.match(text, /Jev advises; the user decides/);
    assert.match(text, /AskUserQuestion/);
    assert.match(text, /never (via )?this CLI|Never via the CLI/i);
    assert.match(text, /push\/PR\/merge\/deploy/);
    assert.match(text, /external effect/);
    assert.match(text, /manual choice/);
    assert.match(text, /Jev chose "X" \(0\.93\)/);
    assert.match(text, /own description of the user|description of the user/);
  });

  test(`${name}: no longer tells the agent to ask Jev for the user's pick or skip asking the user`, () => {
    assert.doesNotMatch(text, /ask Jev which option the user would pick/i);
    assert.doesNotMatch(text, /In full autonomy: do not ask the user/i);
    assert.doesNotMatch(text, /state assumptions and proceed/i);
  });
}

test("SessionStart and SKILL: internal-judgement scope and checkable-facts rule", () => {
  for (const t of [sessionStart, skill]) {
    assert.match(t, /model\/tier choice/);
    assert.match(t, /internal classification/);
    assert.match(t, /read-only/);
  }
  assert.match(skill, /## Never via the CLI/);
  assert.match(skill, /Exit 2/);
});

test("release-please bumps the generated paseo version.mjs (generic updater + x-release-please-version marker)", () => {
  const cfg = JSON.parse(readFileSync(new URL("release-please-config.json", root), "utf8"));
  const extra = cfg.packages["."]["extra-files"];
  assert.ok(extra.some((f) => f.type === "generic" && f.path === "paseo-plugin/server/vendor/version.mjs"));
  assert.match(readFileSync(new URL("paseo-plugin/server/vendor/version.mjs", root), "utf8"), /VERSION = "\d+\.\d+\.\d+"; \/\/ x-release-please-version\n/);
});
