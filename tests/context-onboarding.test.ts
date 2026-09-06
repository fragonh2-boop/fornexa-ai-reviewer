import assert from "node:assert/strict";
import test from "node:test";
import {
  buildContextFromThread,
  containsPotentialSecret,
  CONTEXT_MARKER,
  CONTEXT_PROCESS_COMMAND,
  CONTEXT_RESPONSE_MARKER,
  ensureContextResponseMarker,
  isContextProcessCommand,
  isContextReadyMessage,
  parseContextPackage,
  splitSlackText,
} from "../src/context-onboarding.js";

function packageText(index: number, total: number, body: string, final = false): string {
  return `${CONTEXT_MARKER}\n\nPAQUETE ${final ? "FINAL " : ""}${index}/${total}\n\n${body}`;
}

test("reconstruye paquetes completos en orden numérico", () => {
  const result = buildContextFromThread(
    [
      { ts: "2", user: "U1", text: packageText(2, 2, "Segundo", true) },
      { ts: "1", user: "U1", text: packageText(1, 2, "Primero") },
    ],
    "U1"
  );

  assert.deepEqual(result, { ok: true, context: "Primero\n\nSegundo", packageCount: 2 });
});

test("acepta paquetes atribuidos al mismo usuario mediante una app autorizada", () => {
  const result = buildContextFromThread(
    [
      { ts: "1", user: "U1", botId: "BAPP", text: packageText(1, 2, "Primero") },
      { ts: "2", user: "U1", botId: "BAPP", text: packageText(2, 2, "Segundo", true) },
    ],
    "U1"
  );

  assert.equal(result.ok, true);
});

test("rechaza paquetes incompletos, autores distintos y secretos", () => {
  assert.equal(
    buildContextFromThread(
      [{ ts: "1", user: "U1", text: packageText(1, 2, "Primero") }],
      "U1"
    ).ok,
    false
  );
  assert.equal(
    buildContextFromThread(
      [
        { ts: "1", user: "U1", text: packageText(1, 2, "Primero") },
        { ts: "2", user: "U2", text: packageText(2, 2, "Segundo", true) },
      ],
      "U1"
    ).ok,
    false
  );
  assert.equal(
    buildContextFromThread(
      [{ ts: "1", user: "U1", text: packageText(1, 1, "Token sk-abcdefghijklmnopqrstuv", true) }],
      "U1"
    ).ok,
    false
  );
  assert.equal(containsPotentialSecret("-----BEGIN PRIVATE KEY-----"), true);
});

test("reconoce exclusivamente el final o la orden exacta como disparador", () => {
  assert.equal(isContextReadyMessage(packageText(1, 2, "Uno")), false);
  assert.equal(isContextReadyMessage(packageText(2, 2, "Dos", true)), true);
  assert.equal(isContextProcessCommand(CONTEXT_PROCESS_COMMAND), true);
  assert.equal(isContextProcessCommand(`${CONTEXT_PROCESS_COMMAND} ahora`), false);
  assert.equal(parseContextPackage("texto cualquiera"), null);
});

test("divide respuestas largas sin superar el máximo", () => {
  const chunks = splitSlackText(`${"a".repeat(260)}\n\n${"b".repeat(260)}`, 300);
  assert.equal(chunks.join("").length >= 520, true);
  assert.equal(chunks.every((chunk) => chunk.length <= 300), true);
  assert.throws(() => splitSlackText("texto", 199));
});

test("normaliza el marcador de respuesta para impedir reprocesados", () => {
  assert.equal(
    ensureContextResponseMarker("Pregunta 1"),
    `${CONTEXT_RESPONSE_MARKER}\n\nPregunta 1`
  );
  assert.equal(
    ensureContextResponseMarker(`${CONTEXT_RESPONSE_MARKER}\n\nPregunta 1`),
    `${CONTEXT_RESPONSE_MARKER}\n\nPregunta 1`
  );
});
