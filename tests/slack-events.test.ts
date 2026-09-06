import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { parseReviewRequest } from "../src/review-request.js";
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

test("extrae una solicitud solo cuando incluye PR y HEAD", () => {
  const text =
    "DEEPSEEK — ACCIÓN REQUERIDA\n\nPR #54\nRepo: fragonh2-boop/Fornexa\nHEAD: `ab87ab8a6807386069ee2324988d40f58e0861c7`";
  assert.deepEqual(parseReviewRequest(text, "DEEPSEEK"), {
    prNumber: 54,
    requestedHead: "ab87ab8a6807386069ee2324988d40f58e0861c7",
  });
  assert.equal(parseReviewRequest("DEEPSEEK — ACCIÓN REQUERIDA\nPR #54", "DEEPSEEK"), null);
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

  assert.deepEqual(extractReviewRequest(base, "C0BT661FYLW", "DEEPSEEK"), {
    prNumber: 54,
    requestedHead: "ab87ab8",
  });
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
