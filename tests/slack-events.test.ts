import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  isReviewResponse,
  isReviewResponseForRequest,
  parseReviewRequest,
} from "../src/review-request.js";
import {
  extractHumanMessage,
  extractReviewRequest,
  isSenderAllowed,
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
    "DEEPSEEK — ACCIÓN REQUERIDA\nPR #54\nRepo: fragonh2-boop/Fornexa\nHEAD: `ab87ab8a6807386069ee2324988d40f58e0861c7`";
  const request = parseReviewRequest(text, "DEEPSEEK");
  assert.equal(request?.target, "pr");
  if (!request || request.target !== "pr") throw new Error("se esperaba target PR");
  assert.equal(request.prNumber, 54);
  assert.equal(request.requestedHead, "ab87ab8a6807386069ee2324988d40f58e0861c7");
  assert.equal(request.instructions, text);
});

test("acepta una mención con HEAD exacto como los triggers de Slack", () => {
  const text =
    "<@U08SF47R6P4> DEEPSEEK — ACCIÓN REQUERIDA\nPR #54\nHEAD exacto: ab87ab8a6807386069ee2324988d40f58e0861c7";
  const request = parseReviewRequest(text, "DEEPSEEK");
  assert.equal(request?.target, "pr");
  if (!request || request.target !== "pr") throw new Error("se esperaba target PR");
  assert.equal(request.prNumber, 54);
  assert.equal(request.requestedHead, "ab87ab8a6807386069ee2324988d40f58e0861c7");
});

test("TARGET main gana sobre referencias narrativas a PRs históricas", () => {
  const text =
    "DEEPSEEK — ACCIÓN REQUERIDA\nTARGET: main\nRepo: fragonh2-boop/Fornexa\nHEAD: `8894fa30fa011a68132e4975ba69d3e8e19e1ff0`\nContexto: post-PR #61";
  const request = parseReviewRequest(text, "DEEPSEEK");
  assert.equal(request?.target, "ref");
  if (!request || request.target !== "ref") throw new Error("se esperaba target ref");
  assert.equal(request.ref, "main");
  assert.equal(request.requestedHead, "8894fa30fa011a68132e4975ba69d3e8e19e1ff0");
});

test("MODE MAIN y BRANCH main seleccionan revisión global sin depender de PR", () => {
  const modeMain =
    "DEEPSEEK — ACCIÓN REQUERIDA\nMODE: MAIN\nHEAD: `8894fa30fa011a68132e4975ba69d3e8e19e1ff0`";
  const requestMode = parseReviewRequest(modeMain, "DEEPSEEK");
  assert.equal(requestMode?.target, "ref");
  if (!requestMode || requestMode.target !== "ref") throw new Error("se esperaba target ref");
  assert.equal(requestMode.ref, "main");

  const branchMain =
    "DEEPSEEK — ACCIÓN REQUERIDA\nBRANCH: main\nHEAD: `8894fa30fa011a68132e4975ba69d3e8e19e1ff0`";
  const requestBranch = parseReviewRequest(branchMain, "DEEPSEEK");
  assert.equal(requestBranch?.target, "ref");
  if (!requestBranch || requestBranch.target !== "ref") throw new Error("se esperaba target ref");
  assert.equal(requestBranch.ref, "main");
});

test("MODE PR exige línea PR explícita", () => {
  const invalid =
    "DEEPSEEK — ACCIÓN REQUERIDA\nMODE: PR\nHEAD: `8894fa30fa011a68132e4975ba69d3e8e19e1ff0`";
  assert.equal(parseReviewRequest(invalid, "DEEPSEEK"), null);

  const valid =
    "DEEPSEEK — ACCIÓN REQUERIDA\nMODE: PR\nPR #62\nHEAD: `8894fa30fa011a68132e4975ba69d3e8e19e1ff0`";
  const request = parseReviewRequest(valid, "DEEPSEEK");
  assert.equal(request?.target, "pr");
  if (!request || request.target !== "pr") throw new Error("se esperaba target PR");
  assert.equal(request.prNumber, 62);
});

test("una mención narrativa a PR sin línea PR ni TARGET no crea un handoff ambiguo", () => {
  const text =
    "DEEPSEEK — ACCIÓN REQUERIDA\nHEAD: `8894fa30fa011a68132e4975ba69d3e8e19e1ff0`\nContexto: tras PR #61";
  assert.equal(parseReviewRequest(text, "DEEPSEEK"), null);
});

test("solo una revisión publicada por el bot cuenta como respuesta", () => {
  assert.equal(
    isReviewResponse(
      { text: "DEEPSEEK — REVISIÓN\nPR #54: ok", botId: "B01" },
      "DEEPSEEK"
    ),
    true
  );
  assert.equal(
    isReviewResponse(
      { text: "DEEPSEEK — REVISIÓN NO INICIADA\nPR #54: no coincide HEAD", botId: "B01" },
      "DEEPSEEK"
    ),
    true
  );
  assert.equal(
    isReviewResponse(
      { text: "DEEPSEEK — REVISIÓN FALLIDA\nPR #54: timeout", botId: "B01" },
      "DEEPSEEK"
    ),
    true
  );
  assert.equal(
    isReviewResponse({ text: "DEEPSEEK — REVISIÓN\nPR #54: ok" }, "DEEPSEEK"),
    false
  );
  assert.equal(
    isReviewResponse(
      { text: "otra cosa\nDEEPSEEK — REVISIÓN", botId: "B01" },
      "DEEPSEEK"
    ),
    false
  );
});

test("un aviso terminal canónico cierra solo el handoff exacto de PR o main", () => {
  const prRequest = parseReviewRequest(
    "GEMINI — ACCIÓN REQUERIDA\nPR #70\nHEAD: `ab87ab8a6807386069ee2324988d40f58e0861c7`",
    "GEMINI"
  );
  assert.ok(prRequest);

  const matchedPr = {
    botId: "B01",
    text: "GEMINI — REVISIÓN NO INICIADA\n\nPR #70: el HEAD solicitado `ab87ab8a6807386069ee2324988d40f58e0861c7` ya no coincide con el HEAD actual `1111111111111111111111111111111111111111`.",
  };
  assert.equal(isReviewResponseForRequest(matchedPr, "GEMINI", prRequest), true);

  const otherShaPr = {
    botId: "B01",
    text: "GEMINI — REVISIÓN NO INICIADA\n\nPR #70: el HEAD solicitado `ffffffffffffffffffffffffffffffffffffffff` ya no coincide con el HEAD actual `1111111111111111111111111111111111111111`.",
  };
  assert.equal(isReviewResponseForRequest(otherShaPr, "GEMINI", prRequest), false);

  const mainRequest = parseReviewRequest(
    "GEMINI — ACCIÓN REQUERIDA\nMODE: MAIN\nTARGET: main\nHEAD: `ab87ab8a6807386069ee2324988d40f58e0861c7`",
    "GEMINI"
  );
  assert.ok(mainRequest);

  const matchedMain = {
    botId: "B01",
    text: "GEMINI — REVISIÓN NO INICIADA\n\nTARGET: main\nHEAD `ab87ab8a6807386069ee2324988d40f58e0861c7`: ya no coincide con el HEAD actual `1111111111111111111111111111111111111111`.",
  };
  assert.equal(isReviewResponseForRequest(matchedMain, "GEMINI", mainRequest), true);

  const staleMain = {
    botId: "B01",
    text: "GEMINI — REVISIÓN NO INICIADA\n\nTARGET: main\nHEAD `2222222222222222222222222222222222222222`: ya no coincide con el HEAD actual `1111111111111111111111111111111111111111`.",
  };
  assert.equal(isReviewResponseForRequest(staleMain, "GEMINI", mainRequest), false);

  const freshMainRequest = parseReviewRequest(
    "GEMINI — ACCIÓN REQUERIDA\nMODE: MAIN\nTARGET: main\nHEAD: `3333333333333333333333333333333333333333`",
    "GEMINI"
  );
  assert.ok(freshMainRequest);
  assert.equal(isReviewResponseForRequest(staleMain, "GEMINI", freshMainRequest), false);
});

test("solo acepta mensajes humanos del canal configurado", () => {
  const text = "DEEPSEEK — ACCIÓN REQUERIDA\nPR #54\nHEAD: `ab87ab8a6807386069ee2324988d40f58e0861c7`";
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
  assert.equal(request.requestedHead, "ab87ab8a6807386069ee2324988d40f58e0861c7");
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
  assert.deepEqual(
    extractHumanMessage(
      { ...base, event: { ...base.event, type: "app_mention" } },
      "C0BT661FYLW"
    ),
    {
      channel: "C0BT661FYLW",
      text,
      user: "U123",
      ts: "1788677431.036519",
      threadTs: undefined,
    }
  );
});

test("isSenderAllowed y extractReviewRequest soportan allowlist de bots y previenen bucles", () => {
  // 1. Humanos siempre permitidos
  assert.equal(isSenderAllowed({ user: "UHUMAN" }), true);
  assert.equal(isSenderAllowed({ user: "UHUMAN" }, { allowedBotIds: ["BOTHER"] }), true);

  // 2. Bots sin allowlist rechazados
  assert.equal(isSenderAllowed({ botId: "BBOT", user: "UBOT" }), false);
  assert.equal(isSenderAllowed({ botId: "BBOT", user: "UBOT" }, { allowedBotIds: [] }), false);

  // 3. Bot en allowlist permitido por botId o por user
  assert.equal(isSenderAllowed({ botId: "BGEMINI", user: "UGEMINI" }, { allowedBotIds: ["BGEMINI"] }), true);
  assert.equal(isSenderAllowed({ botId: "BGEMINI", user: "UGEMINI" }, { allowedBotIds: ["UGEMINI"] }), true);
  assert.equal(isSenderAllowed({ botId: "BOTHER", user: "UOTHER" }, { allowedBotIds: ["BGEMINI"] }), false);

  // 4. Comodín * permite bots externos
  assert.equal(isSenderAllowed({ botId: "BANY" }, { allowedBotIds: ["*"] }), true);
  assert.equal(isSenderAllowed({ botId: "BANY" }, { allowedBotIds: ["all"] }), true);

  // 5. Anti-loop: El propio bot siempre es rechazado aunque esté en allowlist o use comodín
  assert.equal(
    isSenderAllowed(
      { botId: "BSELF", user: "USELF" },
      { allowedBotIds: ["*"], ownBotId: "BSELF" }
    ),
    false
  );
  assert.equal(
    isSenderAllowed(
      { botId: "BSELF", user: "USELF" },
      { allowedBotIds: ["*"], ownUserId: "USELF" }
    ),
    false
  );

  // 6. extractReviewRequest con allowlist
  const text = "DEEPSEEK — ACCIÓN REQUERIDA\nPR #54\nHEAD: `ab87ab8a6807386069ee2324988d40f58e0861c7`";
  const envelope = {
    type: "event_callback",
    event: {
      type: "message",
      channel: "C0BT661FYLW",
      text,
      bot_id: "BGEMINI",
      user: "UGEMINI",
      ts: "1788677431.036519",
    },
  };

  // Sin allowlist => null
  assert.equal(extractReviewRequest(envelope, "C0BT661FYLW", "DEEPSEEK"), null);

  // Con allowlist para BGEMINI => procesado con éxito
  const reqAllowed = extractReviewRequest(envelope, "C0BT661FYLW", "DEEPSEEK", { allowedBotIds: ["BGEMINI"] });
  assert.ok(reqAllowed);
  assert.equal(reqAllowed.requestedHead, "ab87ab8a6807386069ee2324988d40f58e0861c7");

  // Con ownBotId coincidente => null (anti-bucle)
  assert.equal(
    extractReviewRequest(envelope, "C0BT661FYLW", "DEEPSEEK", { allowedBotIds: ["BGEMINI"], ownBotId: "BGEMINI" }),
    null
  );
});
