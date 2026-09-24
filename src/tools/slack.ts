import { WebClient } from "@slack/web-api";
import { config } from "../config.js";
import { splitSlackText } from "../context-onboarding.js";
import { formatMentionResponseParts } from "../slack-mentions.js";
import {
  isReviewResponseForRequest,
  parseReviewRequest,
  type ReviewRequest,
} from "../review-request.js";

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
 * Protocolos admitidos:
 *   PR:   "DEEPSEEK — ACCIÓN REQUERIDA" + línea "PR #<numero>" + HEAD
 *   main: "DEEPSEEK — ACCIÓN REQUERIDA" + línea "TARGET: main" + HEAD
 *
 * Los mensajes de Slack llegan en orden inverso (más nuevo primero).
 */
export function findPendingHandoff(
  messages: SlackMessage[],
  agentLabel: string
): (ReviewRequest & { raw: SlackMessage }) | null {
  const requestMarker = `${agentLabel} — ACCIÓN REQUERIDA`;

  for (const msg of messages) {
    if (msg.botId || !msg.user || (msg.threadTs && msg.threadTs !== msg.ts)) continue;
    if (msg.text.includes(requestMarker)) {
      const parsed = parseReviewRequest(msg.text, agentLabel);
      if (!parsed) continue;
      // ¿Hay ya una respuesta de esta IA con timestamp posterior?
      const alreadyAnswered = messages.some(
        (other) =>
          other.ts > msg.ts && isReviewResponseForRequest(other, agentLabel, parsed)
      );
      if (alreadyAnswered) continue;

      const request = parseReviewRequest(msg.text, agentLabel);
      if (!request) continue;

      return { ...request, raw: msg };
    }
  }
  return null;
}

import { getBotPublisherClient } from "./slack-bot-publisher.js";

export function getEffectiveSlackClient(): WebClient {
  return getBotPublisherClient() ?? slack;
}

export async function postToChannelSmart(text: string): Promise<void> {
  const client = getEffectiveSlackClient();
  await client.chat.postMessage({
    channel: config.slack.channelId,
    text,
    unfurl_links: false,
  });
}

export async function postToChannel(text: string): Promise<void> {
  await postToChannelSmart(text);
}

export async function postToThreadSmart(text: string | string[], threadTs: string): Promise<void> {
  const client = getEffectiveSlackClient();
  let chunks: string[];
  if (Array.isArray(text)) {
    chunks = text;
  } else {
    const mentionMatch = text.match(
      /^([A-Z]+ — RESPUESTA)\n(SLACK_REQUEST_TS: [^\n]+)\n\n([\s\S]*)$/
    );
    if (mentionMatch && text.length > 3800) {
      const agentLabel = mentionMatch[1].replace(" — RESPUESTA", "").trim();
      const requestTs = mentionMatch[2].replace("SLACK_REQUEST_TS:", "").trim();
      chunks = formatMentionResponseParts(agentLabel, requestTs, mentionMatch[3]);
    } else {
      const rawChunks = splitSlackText(text);
      chunks = rawChunks.map((chunk, index) => {
        const suffix = rawChunks.length > 1 ? `\n\n_Respuesta ${index + 1}/${rawChunks.length}_` : "";
        return `${chunk}${suffix}`;
      });
    }
  }
  for (const chunk of chunks) {
    await client.chat.postMessage({
      channel: config.slack.channelId,
      thread_ts: threadTs,
      text: chunk,
      unfurl_links: false,
    });
  }
}

export async function postToThread(text: string | string[], threadTs: string): Promise<void> {
  await postToThreadSmart(text, threadTs);
}

export async function postToThreadWithBlocks(text: string, blocks: object[], threadTs: string): Promise<void> {
  const client = getEffectiveSlackClient();
  await client.chat.postMessage({
    channel: config.slack.channelId,
    thread_ts: threadTs,
    text,
    blocks: blocks as never[],
    unfurl_links: false,
  });
}
