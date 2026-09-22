import type { ChatCompletionMessageParam } from "openai/resources/index.js";
import { containsPotentialSecret } from "./context-onboarding.js";

const MAX_MENTION_CHARS = 12 * 1024;
const MAX_HISTORY_CHARS = 64 * 1024;
const MAX_HISTORY_MESSAGES = 20;
export const MAX_MENTION_TURNS = 8;

export interface MentionSlackMessage {
  ts: string;
  text: string;
  user?: string;
  botId?: string;
  threadTs?: string;
}

export interface SlackMentionTurn {
  channel: string;
  ts: string;
  threadTs: string;
  user: string;
  prompt: string;
}

export type MentionPromptResult =
  | { ok: true; prompt: string }
  | { ok: false; error: string };

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mentionTokenPattern(botUserId: string): RegExp {
  return new RegExp(`<@${escaped(botUserId)}(?:\\|[^>]+)?>`, "gi");
}

export function containsBotMention(text: string, botUserId: string): boolean {
  return mentionTokenPattern(botUserId).test(text);
}

export function isDelegatedAgentMessage(text: string): boolean {
  return /(?:^|\n)\s*[*_]*Enviado usando[*_]*(?:\s|$)/i.test(text);
}

export function parseMentionPrompt(text: string, botUserId: string): MentionPromptResult {
  const prompt = text.replace(mentionTokenPattern(botUserId), "").trim();
  if (!prompt) {
    return { ok: false, error: "Escribe una pregunta después de la mención." };
  }
  if (prompt.length > MAX_MENTION_CHARS) {
    return { ok: false, error: "La consulta supera el máximo de 12 KiB." };
  }
  if (containsPotentialSecret(prompt)) {
    return {
      ok: false,
      error: "La consulta parece contener una credencial y no se enviará al modelo.",
    };
  }
  return { ok: true, prompt };
}

export function mentionResponseMarker(agentLabel: string): string {
  return `${agentLabel} — RESPUESTA`;
}

export function mentionFailureMarker(agentLabel: string): string {
  return `${agentLabel} — RESPUESTA FALLIDA`;
}

export function mentionRequestMarker(requestTs: string): string {
  return `SLACK_REQUEST_TS: ${requestTs}`;
}

export function isMentionTerminalResponse(
  message: MentionSlackMessage,
  agentLabel: string,
  requestTs: string
): boolean {
  if (!message.botId) return false;
  const firstLine = message.text.split("\n", 1)[0].trim();
  return (
    (firstLine === mentionResponseMarker(agentLabel) ||
      firstLine === mentionFailureMarker(agentLabel)) &&
    message.text.includes(mentionRequestMarker(requestTs))
  );
}

function isHuman(message: MentionSlackMessage): message is MentionSlackMessage & { user: string } {
  return Boolean(
    message.user &&
      !message.botId &&
      message.text.trim() &&
      !isDelegatedAgentMessage(message.text)
  );
}

function mentionTurns(
  messages: MentionSlackMessage[],
  threadTs: string
): Array<MentionSlackMessage & { user: string }> {
  return [...messages]
    .sort((left, right) => left.ts.localeCompare(right.ts))
    .filter(
      (message): message is MentionSlackMessage & { user: string } =>
        isHuman(message) &&
        (message.ts === threadTs || message.threadTs === threadTs)
    );
}

export function mentionTurnLimitReached(params: {
  messages: MentionSlackMessage[];
  threadTs: string;
  requestTs: string;
  botUserId: string;
}): boolean {
  const root = params.messages.find((message) => message.ts === params.threadTs);
  if (!root || !isHuman(root) || !containsBotMention(root.text, params.botUserId)) return false;
  return mentionTurns(params.messages, params.threadTs).findIndex(
    (message) => message.ts === params.requestTs
  ) >= MAX_MENTION_TURNS;
}

export function selectPendingMentionTurn(params: {
  channel: string;
  threadTs: string;
  messages: MentionSlackMessage[];
  botUserId: string;
  agentLabel: string;
}): SlackMentionTurn | null {
  const { channel, threadTs, botUserId, agentLabel } = params;
  const messages = [...params.messages].sort((left, right) => left.ts.localeCompare(right.ts));
  const root = messages.find((message) => message.ts === threadTs);
  if (!root || !isHuman(root) || !containsBotMention(root.text, botUserId)) return null;

  const rootAnswered = messages.some((message) =>
    isMentionTerminalResponse(message, agentLabel, root.ts)
  );
  const candidates = mentionTurns(messages, root.ts)
    .filter((message) => message.ts === root.ts || rootAnswered)
    .slice(0, MAX_MENTION_TURNS);

  for (const message of candidates) {
    if (messages.some((other) => isMentionTerminalResponse(other, agentLabel, message.ts))) {
      continue;
    }
    const parsed = parseMentionPrompt(message.text, botUserId);
    if (!parsed.ok) continue;
    return {
      channel,
      ts: message.ts,
      threadTs: root.ts,
      user: message.user!,
      prompt: parsed.prompt,
    };
  }

  return null;
}

function assistantContent(text: string, agentLabel: string): string | null {
  if (text.split("\n", 1)[0].trim() !== mentionResponseMarker(agentLabel)) return null;
  return text
    .split("\n")
    .slice(1)
    .filter((line) => !line.startsWith("SLACK_REQUEST_TS:"))
    .join("\n")
    .trim();
}

export function buildMentionConversation(params: {
  messages: MentionSlackMessage[];
  turn: SlackMentionTurn;
  botUserId: string;
  agentLabel: string;
}): ChatCompletionMessageParam[] {
  const { turn, botUserId, agentLabel } = params;
  const normalized: ChatCompletionMessageParam[] = [];

  for (const message of [...params.messages].sort((left, right) => left.ts.localeCompare(right.ts))) {
    if (message.ts > turn.ts) continue;
    if (isHuman(message)) {
      const parsed = parseMentionPrompt(message.text, botUserId);
      if (!parsed.ok) continue;
      normalized.push({ role: "user", content: parsed.prompt });
      continue;
    }
    if (message.botId) {
      const content = assistantContent(message.text, agentLabel);
      if (content) normalized.push({ role: "assistant", content });
    }
  }

  const bounded = normalized.slice(-MAX_HISTORY_MESSAGES);
  while (
    bounded.length > 1 &&
    Buffer.byteLength(JSON.stringify(bounded), "utf8") > MAX_HISTORY_CHARS
  ) {
    bounded.shift();
  }
  if (Buffer.byteLength(JSON.stringify(bounded), "utf8") > MAX_HISTORY_CHARS) {
    throw new Error("Mention conversation exceeds context budget");
  }
  return bounded;
}

export function formatMentionResponse(
  agentLabel: string,
  requestTs: string,
  response: string
): string {
  return `${mentionResponseMarker(agentLabel)}\n${mentionRequestMarker(requestTs)}\n\n${response.trim()}`;
}

export function formatMentionFailure(
  agentLabel: string,
  requestTs: string,
  error: string
): string {
  return `${mentionFailureMarker(agentLabel)}\n${mentionRequestMarker(requestTs)}\n\n${error}`;
}
