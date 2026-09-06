import { WebClient } from "@slack/web-api";
import { config } from "../config.js";
import { splitSlackText } from "../context-onboarding.js";
import { parseReviewRequest } from "../review-request.js";

const slack = new WebClient(config.slack.botToken);

export interface SlackMessage {
  ts: string;
  text: string;
  user?: string;
  botId?: string;
  threadTs?: string;
  replyCount?: number;
}

function toSlackMessage(message: {
  ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  thread_ts?: string;
  reply_count?: number;
}): SlackMessage {
  return {
    ts: message.ts ?? "",
    text: message.text ?? "",
    user: message.user,
    botId: message.bot_id,
    threadTs: message.thread_ts,
    replyCount: message.reply_count,
  };
}

/** Lee hasta maxMessages raíces recientes, paginando para recuperar handoffs antiguos. */
export async function readRecentHistory(maxMessages = 1000): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;

  do {
    const result = await slack.conversations.history({
      channel: config.slack.channelId,
      limit: Math.min(200, maxMessages - messages.length),
      cursor,
    });
    messages.push(...(result.messages ?? []).map(toSlackMessage));
    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor && messages.length < maxMessages);

  return messages.slice(0, maxMessages);
}

export async function readThread(threadTs: string): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;

  do {
    const result = await slack.conversations.replies({
      channel: config.slack.channelId,
      ts: threadTs,
      limit: 200,
      cursor,
    });
    messages.push(...(result.messages ?? []).map(toSlackMessage));
    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return messages;
}

/**
 * Busca el handoff más reciente dirigido a esta IA que todavía no tiene
 * respuesta posterior con la misma etiqueta.
 *
 * Convención (a acordar con GPT/Claude, igual que ya usan entre ellos):
 *   "DEEPSEEK — ACCIÓN REQUERIDA" ... "PR #<numero>" ... HEAD `<sha>`
 *
 * Los mensajes de Slack llegan en orden inverso (más nuevo primero).
 */
export function findPendingHandoff(
  messages: SlackMessage[],
  agentLabel: string
): { prNumber: number; requestedHead: string; raw: SlackMessage } | null {
  const requestMarker = `${agentLabel} — ACCIÓN REQUERIDA`;
  const responseMarker = `${agentLabel} — `;

  for (const msg of messages) {
    if (msg.text.includes(requestMarker)) {
      // ¿Hay ya una respuesta de esta IA con timestamp posterior?
      const alreadyAnswered = messages.some(
        (other) => other.ts > msg.ts && other.text.startsWith(responseMarker)
      );
      if (alreadyAnswered) continue;

      const request = parseReviewRequest(msg.text, agentLabel);
      if (!request) continue;

      return { ...request, raw: msg };
    }
  }
  return null;
}

export async function postToChannel(text: string): Promise<void> {
  await slack.chat.postMessage({
    channel: config.slack.channelId,
    text,
    unfurl_links: false,
  });
}

export async function postToThread(text: string, threadTs: string): Promise<void> {
  const chunks = splitSlackText(text);
  for (let index = 0; index < chunks.length; index++) {
    const suffix = chunks.length > 1 ? `\n\n_Respuesta ${index + 1}/${chunks.length}_` : "";
    await slack.chat.postMessage({
      channel: config.slack.channelId,
      thread_ts: threadTs,
      text: `${chunks[index]}${suffix}`,
      unfurl_links: false,
    });
  }
}
