import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readSafeSidecarFile } from "../src/sidecar-file-reader.js";

test("sidecar file reader rejects symlinks, secrets, unsafe names and oversized files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fornexa-sidecar-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "fornexa-outside-"));
  try {
    await fs.writeFile(path.join(root, "README.md"), "safe documentation");
    assert.match(await readSafeSidecarFile(root, "README.md"), /safe documentation/);

    await fs.writeFile(path.join(root, "notes.md"), `token sk-${"a".repeat(24)}`);
    assert.match(await readSafeSidecarFile(root, "notes.md"), /contenido parece incluir una credencial/);
    await fs.writeFile(path.join(root, "settings.md"), "password=opaque-value-123");
    assert.match(await readSafeSidecarFile(root, "settings.md"), /contenido parece incluir una credencial/);
    await fs.writeFile(path.join(root, "large.md"), "x".repeat(15_001));
    assert.match(await readSafeSidecarFile(root, "large.md"), /supera el límite/);
    await fs.writeFile(path.join(outside, "outside.md"), "outside");
    await fs.symlink(path.join(outside, "outside.md"), path.join(root, "linked.md"));
    assert.match(await readSafeSidecarFile(root, "linked.md"), /enlaces simbólicos/);
    assert.match(await readSafeSidecarFile(root, "config/database.yml"), /Error de seguridad/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
