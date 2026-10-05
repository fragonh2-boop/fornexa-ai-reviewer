import assert from "node:assert/strict";
import test from "node:test";

process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
process.env.SLACK_BOT_TOKEN = "xoxb-test-bot-token";
process.env.GITHUB_TOKEN = "test-github-token";

const { getEffectiveSlackClient, postToThreadSmart, postToChannelSmart, findPendingHandoffWithThreadState } = await import("../src/tools/slack.js");
const { formatSlackMessageParts } = await import("../src/slack-message-parts.js");
const { formatMentionResponseParts } = await import("../src/slack-mentions.js");
const { isReviewResponseForRequest, isReviewThreadComplete } = await import("../src/review-request.js");

const requestTs = "1000.000001";
const head = "a".repeat(40);
const scope = `TARGET: main\nHEAD revisado: \`${head}\``;
const longBody = Array.from({ length: 9 }, (_, i) => `SECTION-${i}: ${"verified evidence ".repeat(80)}`).join("\n\n");
const review = `CLAUDE — REVISIÓN\nSLACK_REQUEST_TS: ${requestTs}\n\n${scope}\n\n${longBody}`;
const mainRequest = { target: "ref" as const, ref: "main", requestedHead: head, instructions: "" };

function messages(parts: string[]) {
  return parts.map((text, i) => ({ text, ts: `2000.${String(i + 1).padStart(6, "0")}`, threadTs: requestTs, botId: "BREVIEWER" }));
}

test("el publicador no envía strings vacíos ni compuestos solo por whitespace", async (t) => {
  let calls = 0;
  t.mock.method(getEffectiveSlackClient().chat, "postMessage", async () => {
    calls += 1;
    return { ok: true, ts: "2000.1" };
  });
  for (const text of ["", " ", "\t", "\n \t\r\n"]) {
    await postToThreadSmart(text, requestTs);
  }
  assert.equal(calls, 0);
});

test("el publicador conserva un string corto no vacío sin recortar su texto", async (t) => {
  const sent: Array<{ text: string; thread_ts: string }> = [];
  t.mock.method(getEffectiveSlackClient().chat, "postMessage", async (message: { text: string; thread_ts: string }) => {
    sent.push(message);
    return { ok: true, ts: "2000.1" };
  });
  const text = " \nRespuesta corta\t ";
  await postToThreadSmart(text, requestTs);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, text);
  assert.equal(sent[0].thread_ts, requestTs);
});

test("cada fragmento publicado conserva correlación, SHA y ámbito en el mismo hilo", async (t) => {
  const sent: Array<{ text: string; thread_ts: string }> = [];
  t.mock.method(getEffectiveSlackClient().chat, "postMessage", async (message: { text: string; thread_ts: string }) => {
    sent.push(message);
    return { ok: true, ts: "2000.1" };
  });
  await postToThreadSmart(review, requestTs);
  assert.ok(sent.length > 1);
  for (const [index, message] of sent.entries()) {
    assert.equal(message.thread_ts, requestTs);
    assert.ok(message.text.startsWith(`CLAUDE — REVISIÓN\nSLACK_REQUEST_TS: ${requestTs}\n\n`));
    assert.ok(message.text.includes(scope));
    assert.ok(message.text.length <= 3800);
    assert.ok(message.text.endsWith(`_Respuesta ${index + 1}/${sent.length}_`));
  }
});

for (const agent of ["CLAUDE", "GEMINI", "DEEPSEEK"]) {
  for (const marker of ["REVISIÓN", "REVISIÓN NO INICIADA", "REVISIÓN FALLIDA"]) {
    test(`${agent}: ${marker} conserva ámbito PR, SHA y cuerpo sin truncar`, () => {
      const prScope = `PR #89: synthetic review\nHEAD revisado: \`${head}\``;
      const header = `${agent} — ${marker}\nSLACK_REQUEST_TS: ${requestTs}\n\n${prScope}\n\n`;
      const parts = formatSlackMessageParts(header + longBody);
      assert.ok(parts.length > 1);
      const reconstructed = parts.map((part, i) => {
        assert.ok(part.startsWith(header));
        assert.ok(part.length <= 3800);
        return part.slice(header.length).replace(new RegExp(`\\n\\n_Respuesta ${i + 1}/${parts.length}_$`), "");
      }).join("\n\n");
      assert.equal(reconstructed, longBody);
    });
  }
}

test("solo el fragmento final correlacionado cierra la revisión exacta", () => {
  const parts = formatSlackMessageParts(review);
  for (const [i, text] of parts.entries()) {
    assert.equal(isReviewResponseForRequest({ text, botId: "BREVIEWER" }, "CLAUDE", mainRequest, requestTs), i === parts.length - 1);
  }
  const last = parts.at(-1)!;
  assert.equal(isReviewResponseForRequest({ text: last, botId: "BREVIEWER" }, "CLAUDE", mainRequest, "1000.999999"), false);
  assert.equal(isReviewResponseForRequest({ text: last.replaceAll(head, "b".repeat(40)), botId: "BREVIEWER" }, "CLAUDE", mainRequest, requestTs), false);
  assert.equal(isReviewResponseForRequest({ text: last, botId: undefined }, "CLAUDE", mainRequest, requestTs), false);
  assert.equal(isReviewResponseForRequest({ text: last.replace(/_Respuesta \d+\/\d+_$/, "_Respuesta 0/3_"), botId: "BREVIEWER" }, "CLAUDE", mainRequest, requestTs), false);
  assert.equal(isReviewResponseForRequest({ text: last.replace(/_Respuesta \d+\/\d+_$/, "_Respuesta invalid/3_"), botId: "BREVIEWER" }, "CLAUDE", mainRequest, requestTs), false);
});

test("la correlación exige el TS exacto del encabezado, no un prefijo ni una cita en el cuerpo", () => {
  const last = formatSlackMessageParts(review).at(-1)!;
  assert.equal(isReviewResponseForRequest({ text: last.replace(requestTs, `${requestTs}0`), botId: "BREVIEWER" }, "CLAUDE", mainRequest, requestTs), false);
  const foreignHeader = last.replace(requestTs, "1000.999999") + `\n\nSLACK_REQUEST_TS: ${requestTs}`;
  assert.equal(isReviewResponseForRequest({ text: foreignHeader, botId: "BREVIEWER" }, "CLAUDE", mainRequest, requestTs), false);
});

test("el sondeo no cierra una revisión moderna incompleta y sí la completa", async () => {
  const root = { ts: requestTs, botId: "BDISPATCHER", text: `CLAUDE — ACCIÓN REQUERIDA\nMODE: MAIN\nTARGET: main\nHEAD: ${head}` };
  const parts = messages(formatSlackMessageParts(review));
  const options = { allowedBotIds: [root.botId] };
  const partial = await findPendingHandoffWithThreadState([root], "CLAUDE", options, async () => parts.slice(0, -1));
  assert.equal(partial?.raw.ts, requestTs);
  const complete = await findPendingHandoffWithThreadState([root], "CLAUDE", options, async () => parts);
  assert.equal(complete, null);
});

const legacyParts = messages([
  `CLAUDE — REVISIÓN\nSLACK_REQUEST_TS: ${requestTs}\n\n${scope}\n\nfirst\n\n_Respuesta 1/3_`,
  "middle\n\n_Respuesta 2/3_",
  "terminal\n\n_Respuesta 3/3_",
]);

test("una secuencia histórica completa evita reejecutar revisiones ya entregadas", () => {
  assert.equal(isReviewThreadComplete(legacyParts.slice().reverse(), "CLAUDE", mainRequest, requestTs), true);
});

test("los comentarios ajenos intercalados no reabren una secuencia histórica completa", () => {
  const interleaved = [
    legacyParts[0],
    { ts: "2000.0000015", text: "human comment", threadTs: requestTs },
    legacyParts[1],
    { ts: "2000.0000025", text: "other bot comment", threadTs: requestTs, botId: "BOTHER" },
    legacyParts[2],
  ];
  assert.equal(isReviewThreadComplete(interleaved, "CLAUDE", mainRequest, requestTs), true);
});

test("una secuencia histórica incompleta, mezclada o fuera de orden nunca cierra", () => {
  const variants = [
    legacyParts.slice(0, 2),
    [legacyParts[0], legacyParts[2]],
    legacyParts.map((part, i) => i === 1 ? { ...part, botId: "BOTHER" } : part),
    legacyParts.map((part, i) => i === 2 ? { ...part, threadTs: "1000.999999" } : part),
    legacyParts.map((part, i) => i === 1 ? { ...part, text: part.text.replace("2/3", "3/3") } : part),
    legacyParts.map((part, i) => i === 0 ? { ...part, text: part.text.replace(requestTs, "1000.999999") } : part),
    legacyParts.map((part, i) => i === 0 ? { ...part, text: part.text.replace(head, "b".repeat(40)) } : part),
    legacyParts.map((part, i) => i === 0 ? { ...part, text: part.text.replace("TARGET: main", "TARGET: other") } : part),
  ];
  for (const parts of variants) assert.equal(isReviewThreadComplete(parts, "CLAUDE", mainRequest, requestTs), false);
});

test("no mezcla una continuación moderna de otra solicitud con la secuencia histórica", () => {
  const mixed = legacyParts.map((part, i) => i === 1 ? {
    ...part,
    text: `CLAUDE — REVISIÓN\nSLACK_REQUEST_TS: 1000.999999\n\n${scope}\n\nother\n\n_Respuesta 2/3_`,
  } : part);
  assert.equal(isReviewThreadComplete(mixed, "CLAUDE", mainRequest, requestTs), false);
});

test("un fragmento final moderno de otra solicitud no cierra aunque comparta bot e hilo", () => {
  const parts = messages(formatSlackMessageParts(review));
  const mixed = parts.map((part, i) => i === parts.length - 1 ? {
    ...part,
    text: part.text.replace(requestTs, "1000.999999"),
  } : part);
  assert.ok(mixed.every((part) => part.botId === "BREVIEWER" && part.threadTs === requestTs));
  assert.equal(isReviewThreadComplete(mixed, "CLAUDE", mainRequest, requestTs), false);
});

test("la recuperación histórica puede cerrar con una continuación ajena sin metadatos del mismo bot e hilo", () => {
  // El formato antiguo no conserva la solicitud de las continuaciones: si la
  // primera parte de otra secuencia falta, estos datos no permiten distinguirla.
  const ambiguous = [
    legacyParts[0],
    { ...legacyParts[1], text: "unheaded continuation from another sequence\n\n_Respuesta 2/3_" },
    { ...legacyParts[2], text: "unheaded final from another sequence\n\n_Respuesta 3/3_" },
  ];
  assert.equal(isReviewThreadComplete(ambiguous, "CLAUDE", mainRequest, requestTs), true);
});

for (const size of [3799, 3800, 3801, 7600]) {
  test(`un mensaje genérico de ${size} caracteres no inventa correlación ni excede el límite`, () => {
    const text = "x".repeat(size);
    const parts = formatSlackMessageParts(text);
    assert.ok(parts.every((part) => part.length <= 3800 && !part.includes("SLACK_REQUEST_TS")));
    assert.equal(parts.map((part) => part.replace(/\n\n_Respuesta \d+\/\d+_$/, "")).join(""), text);
    if (size <= 3800) assert.deepEqual(parts, [text]);
  });
}

test("preserva revisiones cortas y el formateador conversacional existente", () => {
  const short = `CLAUDE — REVISIÓN\nSLACK_REQUEST_TS: ${requestTs}\n\n${scope}\n\nOK`;
  assert.deepEqual(formatSlackMessageParts(short), [short]);
  const mention = `GEMINI — RESPUESTA\nSLACK_REQUEST_TS: ${requestTs}\n\n${longBody}`;
  assert.deepEqual(formatSlackMessageParts(mention), formatMentionResponseParts("GEMINI", requestTs, longBody));
});

test("respeta palabras gigantes y calcula el presupuesto de metadatos antes de publicar", () => {
  const body = "Z".repeat(12000);
  const header = `CLAUDE — REVISIÓN\nSLACK_REQUEST_TS: ${requestTs}\n\n${scope}\n\n`;
  const parts = formatSlackMessageParts(header + body);
  assert.equal(parts.map((part) => part.slice(header.length).replace(/\n\n_Respuesta \d+\/\d+_$/, "")).join(""), body);
  assert.ok(parts.every((part) => part.length <= 3800));
  assert.throws(() => formatSlackMessageParts(header + body, 250), RangeError);
});

test("el fallback al canal también conserva metadatos y devuelve la raíz inicial", async (t) => {
  const sent: Array<{ text: string; thread_ts?: string }> = [];
  t.mock.method(getEffectiveSlackClient().chat, "postMessage", async (message: { text: string; thread_ts?: string }) => {
    sent.push(message);
    return { ok: true, ts: `2000.${sent.length}` };
  });
  const fallback = `${review}\n\nTHREAD_TS: ${requestTs}`;
  const rootTs = await postToChannelSmart(fallback);
  assert.equal(rootTs, "2000.1");
  assert.deepEqual(sent.map((message) => message.text), formatSlackMessageParts(fallback));
  assert.ok(sent.every((message) => message.thread_ts === undefined && message.text.length <= 3800));
  assert.ok(sent.at(-1)!.text.includes(`THREAD_TS: ${requestTs}`));
});

test("una solicitud larga al canal permanece en una sola raíz con todas sus instrucciones", async (t) => {
  const sent: string[] = [];
  t.mock.method(getEffectiveSlackClient().chat, "postMessage", async (message: { text: string }) => {
    sent.push(message.text);
    return { ok: true, ts: "2000.1" };
  });
  const action = `CLAUDE — ACCIÓN REQUERIDA\nMODE: MAIN\nTARGET: main\nHEAD: ${head}\n\n${longBody}`;
  assert.ok(action.length > 3800);
  assert.equal(await postToChannelSmart(action), "2000.1");
  assert.deepEqual(sent, [action]);
});

test("publica en orden y detiene la secuencia si una parte falla", async (t) => {
  let calls = 0;
  t.mock.method(getEffectiveSlackClient().chat, "postMessage", async () => {
    calls += 1;
    if (calls === 2) throw new Error("synthetic Slack failure");
    return { ok: true, ts: "2000.1" };
  });
  await assert.rejects(postToThreadSmart(review, requestTs), /synthetic Slack failure/);
  assert.equal(calls, 2);
});

test("los arrays previamente formateados no se fragmentan por segunda vez", async (t) => {
  const sent: string[] = [];
  t.mock.method(getEffectiveSlackClient().chat, "postMessage", async (message: { text: string }) => {
    sent.push(message.text);
    return { ok: true, ts: "2000.1" };
  });
  const parts = formatSlackMessageParts(review);
  await postToThreadSmart(parts, requestTs);
  assert.deepEqual(sent, parts);
});

test("el guard de strings vacíos conserva la semántica de los arrays preformateados", async (t) => {
  const sent: string[] = [];
  t.mock.method(getEffectiveSlackClient().chat, "postMessage", async (message: { text: string }) => {
    sent.push(message.text);
    return { ok: true, ts: "2000.1" };
  });
  const parts = ["", " \t\n", "preformatted reply"];
  await postToThreadSmart(parts, requestTs);
  assert.deepEqual(sent, parts);
});
