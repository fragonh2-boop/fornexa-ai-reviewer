import assert from "node:assert/strict";
import test from "node:test";
import {
  acquireLock,
  extractFirstChoice,
  isLockStale,
  ownsLock,
  releaseLock,
  withTimeout,
} from "../src/reliability.js";

test("detecta candados frescos, caducados y el borde exacto", () => {
  assert.equal(isLockStale(1_000, 1_999, 1_000), false);
  assert.equal(isLockStale(1_000, 2_000, 1_000), true);
  assert.equal(isLockStale(1_000, 2_001, 1_000), true);
});

test("recupera un candado atascado sin permitir que el trabajo antiguo libere el nuevo", () => {
  const locks = new Map<string, number>();
  const first = acquireLock(locks, "review", 1_000, 1_000);
  assert.equal(first.acquired, true);

  assert.deepEqual(acquireLock(locks, "review", 1_000, 1_999), { acquired: false });
  const retry = acquireLock(locks, "review", 1_000, 2_000);
  assert.deepEqual(retry, { acquired: true, startedAt: 2_000, recoveredStaleLock: true });

  if (!first.acquired || !retry.acquired) throw new Error("se esperaban dos adquisiciones");
  releaseLock(locks, "review", first.startedAt);
  assert.equal(locks.get("review"), retry.startedAt);
  assert.equal(ownsLock(locks, "review", first.startedAt), false);
  assert.equal(ownsLock(locks, "review", retry.startedAt), true);
  releaseLock(locks, "review", retry.startedAt);
  assert.equal(locks.has("review"), false);
});

test("extrae la primera opción y describe respuestas inválidas de DeepSeek", () => {
  const choice = { message: { content: "ok" } };
  assert.equal(extractFirstChoice({ choices: [choice] }), choice);
  assert.throws(
    () => extractFirstChoice({ choices: [] }),
    /DeepSeek no devolvió ninguna opción/
  );
  assert.throws(
    () => extractFirstChoice({}),
    /DeepSeek no devolvió ninguna opción/
  );
  assert.throws(
    () => extractFirstChoice({ error: { message: "rate limit" } }),
    /rate limit/
  );
});

test("el timeout rechaza una llamada que no termina", async () => {
  await assert.rejects(
    withTimeout(new Promise<never>(() => undefined), 10, "Prueba"),
    /Prueba superó el timeout de 10 ms/
  );
  assert.equal(await withTimeout(Promise.resolve("ok"), 1_000, "Prueba"), "ok");
});
