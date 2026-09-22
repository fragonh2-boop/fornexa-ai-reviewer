import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMentionConversation,
  containsBotMention,
  formatMentionFailure,
  formatMentionResponse,
  formatMentionResponseParts,
  isDelegatedAgentMessage,
  isMentionTerminalResponse,
  MAX_MENTION_TURNS,
  mentionTurnLimitReached,
  parseMentionPrompt,
  selectPendingMentionTurn,
} from "../src/slack-mentions.js";

const botUserId = "U0C362TR8HG";
const channel = "C0BT661FYLW";

test("una mención exacta crea una consulta y elimina solo la identidad del bot", () => {
  assert.equal(containsBotMention(`<@${botUserId}> hola`, botUserId), true);
  assert.equal(containsBotMention("@GeminiFornexa hola", botUserId), false);
  assert.deepEqual(
    parseMentionPrompt(`<@${botUserId}|GeminiFornexa> compara GPT y Claude`, botUserId),
    { ok: true, prompt: "compara GPT y Claude" }
  );
  assert.equal(parseMentionPrompt(`<@${botUserId}>`, botUserId).ok, false);
  assert.equal(
    parseMentionPrompt(`<@${botUserId}> token xoxb-${"a".repeat(30)}`, botUserId).ok,
    false
  );
  assert.equal(
    parseMentionPrompt(`<@${botUserId}> clave AIzaSy${"A".repeat(33)}`, botUserId).ok,
    false
  );
});

test("la conversación empieza por @ y continúa en el mismo hilo sin repetir la mención", () => {
  const root = {
    ts: "1000.000001",
    text: `<@${botUserId}> ¿qué puedes hacer?`,
    user: "UFRAN",
  };
  const first = selectPendingMentionTurn({
    channel,
    threadTs: root.ts,
    messages: [root],
    botUserId,
    agentLabel: "GEMINI",
  });
  assert.equal(first?.prompt, "¿qué puedes hacer?");

  const answer = {
    ts: "1000.000002",
    threadTs: root.ts,
    botId: "B-GEMINI",
    text: formatMentionResponse("GEMINI", root.ts, "Puedo conversar en este hilo."),
  };
  const followup = {
    ts: "1000.000003",
    threadTs: root.ts,
    user: "UFRAN",
    text: "¿y puedes desplegar?",
  };
  const turn = selectPendingMentionTurn({
    channel,
    threadTs: root.ts,
    messages: [followup, answer, root],
    botUserId,
    agentLabel: "GEMINI",
  });
  assert.equal(turn?.ts, followup.ts);
  assert.equal(turn?.prompt, followup.text);

  const conversation = buildMentionConversation({
    messages: [root, answer, followup],
    turn: turn!,
    botUserId,
    agentLabel: "GEMINI",
  });
  assert.deepEqual(conversation, [
    { role: "user", content: "¿qué puedes hacer?" },
    { role: "assistant", content: "Puedo conversar en este hilo." },
    { role: "user", content: "¿y puedes desplegar?" },
  ]);
});

test("cada mensaje queda cerrado únicamente por una respuesta terminal con su ts", () => {
  const success = {
    ts: "1000.2",
    botId: "B1",
    text: formatMentionResponse("CLAUDE", "1000.1", "respuesta"),
  };
  const failure = {
    ts: "1000.3",
    botId: "B1",
    text: formatMentionFailure("CLAUDE", "1000.4", "fallo"),
  };
  assert.equal(isMentionTerminalResponse(success, "CLAUDE", "1000.1"), true);
  assert.equal(isMentionTerminalResponse(success, "CLAUDE", "1000.4"), false);
  assert.equal(isMentionTerminalResponse(failure, "CLAUDE", "1000.4"), true);
  assert.equal(isMentionTerminalResponse({ ...success, botId: undefined }, "CLAUDE", "1000.1"), false);
});

test("un hilo dirigido a otra identidad no se procesa", () => {
  const turn = selectPendingMentionTurn({
    channel,
    threadTs: "1000.1",
    messages: [
      {
        ts: "1000.1",
        text: "<@UOTHER> responde",
        user: "UFRAN",
      },
    ],
    botUserId,
    agentLabel: "GEMINI",
  });
  assert.equal(turn, null);
});

test("ignora mensajes delegados por otra IA aunque Slack los atribuya al usuario", () => {
  const delegated = `<@${botUserId}> revisa esto\n\n*Enviado usando* <@U-CLAUDE>`;
  assert.equal(isDelegatedAgentMessage(delegated), true);
  assert.equal(isDelegatedAgentMessage("_Enviado usando Claude_"), true);
  assert.equal(isDelegatedAgentMessage("El usuario escribió: enviado usando palabras simples"), false);

  const turn = selectPendingMentionTurn({
    channel,
    threadTs: "1000.1",
    messages: [{ ts: "1000.1", text: delegated, user: "UFRAN" }],
    botUserId,
    agentLabel: "GEMINI",
  });
  assert.equal(turn, null);
});

test("corta un hilo después de ocho turnos humanos", () => {
  const root = {
    ts: "1000.000001",
    text: `<@${botUserId}> turno 1`,
    user: "UFRAN",
  };
  const messages = [root];
  for (let index = 0; index < MAX_MENTION_TURNS; index += 1) {
    const requestTs = `1000.${String(index * 2 + 1).padStart(6, "0")}`;
    if (index > 0) {
      messages.push({
        ts: requestTs,
        text: `turno ${index + 1}`,
        user: "UFRAN",
        threadTs: root.ts,
      });
    }
    messages.push({
      ts: `1000.${String(index * 2 + 2).padStart(6, "0")}`,
      text: formatMentionResponse("GEMINI", requestTs, `respuesta ${index + 1}`),
      botId: "B-GEMINI",
      threadTs: root.ts,
    });
  }
  const ninth = {
    ts: "1000.000017",
    text: "turno 9",
    user: "UFRAN",
    threadTs: root.ts,
  };
  messages.push(ninth);
  assert.equal(
    mentionTurnLimitReached({
      messages,
      threadTs: root.ts,
      requestTs: ninth.ts,
      botUserId,
    }),
    true
  );

  const turn = selectPendingMentionTurn({
    channel,
    threadTs: root.ts,
    messages,
    botUserId,
    agentLabel: "GEMINI",
  });
  assert.equal(turn, null);
});

test("preserva y reconstruye íntegramente respuestas divididas (>3800 caracteres) en el siguiente turno", () => {
  const p1 = "Primera parte explicativa detallada sobre arquitectura y diseño de sistemas. ".repeat(30).trim();
  const p2 = "Segunda parte técnica profunda con código, ejemplos y casos límite. ".repeat(30).trim();
  const longAnswer = `${p1}\n\n${p2}`;
  assert.equal(longAnswer.length > 3800, true);

  const root = {
    ts: "1000.000001",
    text: `<@${botUserId}> genera un informe extenso`,
    user: "UFRAN",
  };

  const parts = formatMentionResponseParts("GEMINI", root.ts, longAnswer);
  assert.equal(parts.length >= 2, true);
  assert.equal(parts.every((p) => p.length <= 3800), true);
  assert.equal(parts[0].includes("GEMINI — RESPUESTA"), true);
  assert.equal(parts[1].includes("GEMINI — RESPUESTA"), true);
  assert.equal(parts[0].includes(`SLACK_REQUEST_TS: ${root.ts}`), true);
  assert.equal(parts[1].includes(`SLACK_REQUEST_TS: ${root.ts}`), true);
  assert.equal(parts[0].includes("_Respuesta 1/"), true);
  assert.equal(parts[1].includes("_Respuesta 2/"), true);

  const botPart1 = {
    ts: "1000.000002",
    threadTs: root.ts,
    botId: "B-GEMINI",
    text: parts[0],
  };
  const botPart2 = {
    ts: "1000.000003",
    threadTs: root.ts,
    botId: "B-GEMINI",
    text: parts[1],
  };
  const followup = {
    ts: "1000.000004",
    threadTs: root.ts,
    user: "UFRAN",
    text: "¿puedes resumir los puntos clave de ese informe?",
  };

  const turn = selectPendingMentionTurn({
    channel,
    threadTs: root.ts,
    messages: [root, botPart1, botPart2, followup],
    botUserId,
    agentLabel: "GEMINI",
  });
  assert.equal(turn?.ts, followup.ts);
  assert.equal(turn?.prompt, followup.text);

  const conversation = buildMentionConversation({
    messages: [root, botPart1, botPart2, followup],
    turn: turn!,
    botUserId,
    agentLabel: "GEMINI",
  });

  assert.equal(conversation.length, 3);
  assert.deepEqual(conversation[0], {
    role: "user",
    content: "genera un informe extenso",
  });
  assert.equal(conversation[1].role, "assistant");
  assert.equal(conversation[1].content, longAnswer.trim());
  assert.equal(conversation[1].content.includes("GEMINI — RESPUESTA"), false);
  assert.equal(conversation[1].content.includes("SLACK_REQUEST_TS:"), false);
  assert.equal(conversation[1].content.includes("_Respuesta 1/"), false);
  assert.equal(conversation[1].content.includes("_Respuesta 2/"), false);
  assert.deepEqual(conversation[2], {
    role: "user",
    content: "¿puedes resumir los puntos clave de ese informe?",
  });
});

test("no confunde las partes de la respuesta con mensajes de otros agentes en el hilo", () => {
  const root = {
    ts: "1000.000001",
    text: `<@${botUserId}> consulta para Gemini`,
    user: "UFRAN",
  };
  const geminiPart1 = {
    ts: "1000.000002",
    threadTs: root.ts,
    botId: "B-GEMINI",
    text: formatMentionResponse("GEMINI", root.ts, "Parte uno de Gemini."),
  };
  const claudeInterference = {
    ts: "1000.000003",
    threadTs: root.ts,
    botId: "B-CLAUDE",
    text: formatMentionResponse("CLAUDE", root.ts, "Interferencia de Claude en el mismo hilo."),
  };
  const geminiPart2 = {
    ts: "1000.000004",
    threadTs: root.ts,
    botId: "B-GEMINI",
    text: formatMentionResponse("GEMINI", root.ts, "Parte dos de Gemini."),
  };
  const followup = {
    ts: "1000.000005",
    threadTs: root.ts,
    user: "UFRAN",
    text: "pregunta posterior",
  };

  const conversation = buildMentionConversation({
    messages: [root, geminiPart1, claudeInterference, geminiPart2, followup],
    turn: {
      channel,
      ts: followup.ts,
      threadTs: root.ts,
      user: "UFRAN",
      prompt: followup.text,
    },
    botUserId,
    agentLabel: "GEMINI",
  });

  assert.equal(conversation.length, 3);
  assert.deepEqual(conversation[0], { role: "user", content: "consulta para Gemini" });
  assert.deepEqual(conversation[1], {
    role: "assistant",
    content: "Parte uno de Gemini.\n\nParte dos de Gemini.",
  });
  assert.equal(conversation[1].content.includes("Interferencia de Claude"), false);
  assert.deepEqual(conversation[2], { role: "user", content: "pregunta posterior" });
});
