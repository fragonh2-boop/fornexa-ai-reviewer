import test from "node:test";
import assert from "node:assert/strict";
import { buildUserPrompt, DEFAULT_MAX_INLINE_DIFF_CHARS } from "../src/prompt.js";

test("buildUserPrompt: conserva diff completo si no supera el límite inline", () => {
  const diffText = "diff --git a/foo.ts b/foo.ts\n+console.log('hello');";
  const prompt = buildUserPrompt({
    prNumber: 99,
    title: "Test PR",
    headSha: "1111222233334444555566667777888899990000",
    diffText,
    changedFiles: ["foo.ts"],
    checks: [],
    mode: "SEGUNDA_REVISION",
  });

  assert.ok(prompt.includes("Diff completo:"));
  assert.ok(prompt.includes(diffText));
  assert.ok(!prompt.includes("diff truncado"));
});

test("buildUserPrompt: trunca inline diffs gigantescos y añade aviso de get_full_file", () => {
  const hugeDiff = "x".repeat(200_000);
  const prompt = buildUserPrompt({
    prNumber: 91,
    title: "Large PR",
    headSha: "2222333344445555666677778888999900001111",
    diffText: hugeDiff,
    changedFiles: ["file1.ts", "file2.ts"],
    checks: [],
    mode: "SEGUNDA_REVISION",
    maxInlineDiffChars: 50_000,
  });

  assert.ok(prompt.includes("Diff (primeros 50000 caracteres de 200000; para el resto usa get_full_file):"));
  assert.ok(prompt.includes("diff truncado: el diff completo contiene 200000 caracteres"));
  assert.ok(prompt.includes("Usa la herramienta get_full_file"));
  assert.ok(!prompt.includes("x".repeat(50_001)));
});
