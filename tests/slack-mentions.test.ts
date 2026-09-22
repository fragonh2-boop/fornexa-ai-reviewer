import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMentionConversation,
  containsBotMention,
  formatMentionFailure,
  formatMentionResponse,
  isMentionTerminalResponse,
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
