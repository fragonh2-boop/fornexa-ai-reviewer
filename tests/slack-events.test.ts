import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { isReviewResponse, parseReviewRequest } from "../src/review-request.js";
import {
  extractHumanMessage,
  extractReviewRequest,
  verifySlackSignature,
} from "../src/slack-events.js";

function sign(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac("sha256", secret)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
}

test("verifica una firma vigente y rechaza manipulación o replay", () => {
  const secret = "test-secret";
  const timestamp = "1788667200";
  const rawBody = JSON.stringify({ type: "event_callback" });
  const signature = sign(secret, timestamp, rawBody);

  assert.equal(
    verifySlackSignature({
      rawBody,
      timestamp,
      signature,
      signingSecret: secret,
      nowMs: Number(timestamp) * 1000,
    }),
    true
  );
  assert.equal(
    verifySlackSignature({
      rawBody: `${rawBody} `,
      timestamp,
      signature,
      signingSecret: secret,
      nowMs: Number(timestamp) * 1000,
    }),
    false
  );
  assert.equal(
    verifySlackSignature({
      rawBody,
      timestamp,
      signature,
      signingSecret: secret,
      nowMs: (Number(timestamp) + 301) * 1000,
    }),
    false
  );
});

test("extrae una solicitud PR solo con línea PR explícita y HEAD", () => {
  const text =
    "DEEPSEEK — ACCIÓN REQUERIDA\n\nPR #54\nRepo: fragonh2-boop/Fornexa\nHEAD: `ab87ab8a6807386069ee2324988d40f58e0861c7`";
  const parsed = parseReviewRequest(text, "DEEPSEEK");
  assert.equal(parsed?.target, "pr");
  if (!parsed || parsed.target !== "pr") throw new Error("se esperaba target PR");
  assert.equal(parsed.prNumber, 54);
  assert.equal(parsed.requestedHead, "ab87ab8a6807386069ee2324988d40f58e0861c7");
  assert.equal(parsed.instructions, text);
  assert.equal(parseReviewRequest("DEEPSEEK — ACCIÓN REQUERIDA\nPR #54", "DEEPSEEK"), null);
});

test("acepta una mención con HEAD exacto como los triggers de Slack", () => {
  const text =
    "<@U0BV95NCT89|Fornexa DeepSeek Reviewer> DEEPSEEK — ACCIÓN REQUERIDA — RETRY\n\nPR #60\nHEAD exacto: 463a259166ccd31cfbbc73eb6835946fd3dd683e";
  const parsed = parseReviewRequest(text, "DEEPSEEK");

  assert.equal(parsed?.target, "pr");
  if (!parsed || parsed.target !== "pr") throw new Error("se esperaba target PR");
  assert.equal(parsed.prNumber, 60);
  assert.equal(parsed.requestedHead, "463a259166ccd31cfbbc73eb6835946fd3dd683e");
});

test("TARGET main gana sobre referencias narrativas a PRs históricas", () => {
  const text =
    "<@U0BV95NCT89|Fornexa DeepSeek Reviewer> DEEPSEEK — ACCIÓN REQUERIDA\n\nRepo: fragonh2-boop/Fornexa\nTARGET: main\nHEAD: `d4e1d15bf53d518aa1f3c2ca606a2a0a3dfc52ce`\n\nRevisión de conjunto post-PR #61. No revises PR #60 de nuevo.";
  const parsed = parseReviewRequest(text, "DEEPSEEK");

  assert.equal(parsed?.target, "ref");
  if (!parsed || parsed.target !== "ref") throw new Error("se esperaba target ref");
  assert.equal(parsed.ref, "main");
  assert.equal(parsed.requestedHead, "d4e1d15bf53d518aa1f3c2ca606a2a0a3dfc52ce");
  assert.equal(parsed.instructions, text);
});

test("una mención narrativa a PR sin línea PR ni TARGET no crea un handoff ambiguo", () => {
  const text =
    "DEEPSEEK — ACCIÓN REQUERIDA\nRevisión post-PR #61\nHEAD: d4e1d15bf53d518aa1f3c2ca606a2a0a3dfc52ce";
  assert.equal(parseReviewRequest(text, "DEEPSEEK"), null);
});

test("solo una revisión publicada por el bot cuenta como respuesta", () => {
  assert.equal(
    isReviewResponse(
      { text: "DEEPSEEK — REVISIÓN\n\nMUST: ninguno", botId: "B123" },
      "DEEPSEEK"
    ),
    true
  );
  assert.equal(
    isReviewResponse(
      { text: "DEEPSEEK — ACCIÓN REQUERIDA\n\nPR #60", botId: "BOTHER" },
      "DEEPSEEK"
    ),
    false
  );
  assert.equal(
    isReviewResponse({ text: "DEEPSEEK — REVISIÓN\n\ntexto humano" }, "DEEPSEEK"),
    false
  );
});

test("solo acepta mensajes humanos del canal configurado", () => {
  const text = "DEEPSEEK — ACCIÓN REQUERIDA\nPR #54\nHEAD: `ab87ab8`";
  const base = {
    type: "event_callback",
    event: {
      type: "message",
      channel: "C0BT661FYLW",
      text,
      user: "U123",
      ts: "1788677431.036519",
    },
  };

  const request = extractReviewRequest(base, "C0BT661FYLW", "DEEPSEEK");
  assert.equal(request?.target, "pr");
  if (!request || request.target !== "pr") throw new Error("se esperaba target PR");
  assert.equal(request.prNumber, 54);
  assert.equal(request.requestedHead, "ab87ab8");
  assert.equal(
    extractReviewRequest(
      { ...base, event: { ...base.event, bot_id: "B123" } },
      "C0BT661FYLW",
      "DEEPSEEK"
    ),
    null
  );
  assert.equal(extractReviewRequest(base, "COTHER", "DEEPSEEK"), null);
  assert.deepEqual(extractHumanMessage(base, "C0BT661FYLW"), {
    channel: "C0BT661FYLW",
    text,
    user: "U123",
    ts: "1788677431.036519",
    threadTs: undefined,
  });
});
