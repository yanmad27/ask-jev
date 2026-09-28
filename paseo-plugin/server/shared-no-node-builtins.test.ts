import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";

// Paseo bundles everything under a plugin's shared/ as one isomorphic (client+server) chunk and
// refuses to build if anything in that graph imports a Node built-in — even a file the client
// never actually loads (a real install failure this repro'd: "Node module cannot be imported into
// the plugin shared bundle: node:fs imported by .../shared/jev.mjs"). This guards shared/ against
// a regression; the Node-only vendored modules (jev/context/gate/env/answer-policy) live under
// server/vendor/ instead, which this check does not scan.
const BUILTIN_NAMES = new Set(builtinModules.filter(Boolean));

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re = /\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) specs.push(m[1] ?? m[2] ?? m[3]);
  return specs;
}

function isNodeBuiltin(spec: string): boolean {
  if (spec.startsWith("node:")) return true;
  const bare = spec.split("/")[0];
  return BUILTIN_NAMES.has(bare) || BUILTIN_NAMES.has(spec);
}

/** Every disallowed import in `source`, for reporting. */
function violations(source: string): string[] {
  return importSpecifiers(source).filter(isNodeBuiltin);
}

test("detector: flags a Node built-in import (proves this would have failed on the pre-fix layout)", () => {
  assert.deepEqual(violations('import { readFileSync } from "node:fs";\nexport const x = 1;'), ["node:fs"]);
  assert.deepEqual(violations('import fs from "fs";'), ["fs"]);
  assert.deepEqual(violations('const p = require("path");'), ["path"]);
  assert.deepEqual(violations('import { z } from "zod";\nimport type { Foo } from "@getpaseo/plugin";'), []);
});

test("paseo-plugin/shared/ contains no Node built-in imports — Paseo bundles it isomorphically and rejects any", () => {
  const sharedDir = join(process.cwd(), "shared");
  const files = readdirSync(sharedDir).filter((f) => f.endsWith(".mjs") || f.endsWith(".ts") || f.endsWith(".tsx"));
  assert.ok(files.length > 0, "expected at least one file under paseo-plugin/shared/ to check");

  const offenders: Record<string, string[]> = {};
  for (const file of files) {
    const found = violations(readFileSync(join(sharedDir, file), "utf8"));
    if (found.length > 0) offenders[file] = found;
  }
  assert.deepEqual(offenders, {}, `Node built-in import(s) found under paseo-plugin/shared/ — move the file to server/vendor/ instead: ${JSON.stringify(offenders)}`);
});
