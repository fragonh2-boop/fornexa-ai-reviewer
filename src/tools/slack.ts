import { WebClient } from "@slack/web-api";
import { config } from "../config.js";
import { formatSlackMessageParts, isCorrelatedReviewResponse } from "../slack-message-parts.js";
import {
  isReviewResponseForRequest,
  isReviewThreadComplete,
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

export async function readThread(threadTs: string, maxMessages = 1000): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;

  do {
    const result = await slack.conversations.replies({
      channel: config.slack.channelId,
      ts: threadTs,
      limit: Math.min(200, maxMessages - messages.length),
      cursor,
    });
    messages.push(...(result.messages ?? []).map(toSlackMessage));
    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor && messages.length < maxMessages);

  return messages.slice(0, maxMessages);
}

import { isSenderAllowed, type BotAllowlistOptions } from "../slack-events.js";

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
  agentLabel: string,
  options: BotAllowlistOptions = {}
): (ReviewRequest & { raw: SlackMessage }) | null {
  const requestMarker = `${agentLabel} — ACCIÓN REQUERIDA`;

  for (const msg of messages) {
    if (!isSenderAllowed({ botId: msg.botId, user: msg.user }, options)) continue;
    if (msg.threadTs && msg.threadTs !== msg.ts) continue;
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

/**
 * The channel history endpoint only returns thread roots. A terminal review is
 * deliberately posted in the request thread, so polling must inspect that
 * durable thread state after a restart before deciding to run the review again.
 */
export async function findPendingHandoffWithThreadState(
  messages: SlackMessage[],
  agentLabel: string,
  options: BotAllowlistOptions,
  readThreadState: (threadTs: string, maxMessages: number) => Promise<SlackMessage[]>
): Promise<(ReviewRequest & { raw: SlackMessage }) | null> {
  const requestMarker = `${agentLabel} — ACCIÓN REQUERIDA`;
  let inspectedThreads = 0;

  for (const msg of messages) {
    if (inspectedThreads >= 50) break;
    if (!isSenderAllowed({ botId: msg.botId, user: msg.user }, options)) continue;
    if (msg.threadTs && msg.threadTs !== msg.ts) continue;
    if (!msg.text.includes(requestMarker)) continue;

    const request = parseReviewRequest(msg.text, agentLabel);
    if (!request) continue;

    const legacyTerminal = messages.some(
      (other) => other.ts > msg.ts && isReviewResponseForRequest(other, agentLabel, request)
    );
    if (legacyTerminal) continue;

    inspectedThreads += 1;
    const thread = await readThreadState(msg.ts, 100);
    const terminalInThread = isReviewThreadComplete(thread, agentLabel, request, msg.ts);
    if (terminalInThread) continue;

    return { ...request, raw: msg };
  }

  return null;
}

import { getBotPublisherClient } from "./slack-bot-publisher.js";

export function getEffectiveSlackClient(): WebClient {
  return getBotPublisherClient() ?? slack;
}

export async function postToChannelSmart(text: string): Promise<string> {
  const client = getEffectiveSlackClient();
  // Dispatch requests must remain one root so no instructions are detached.
  const chunks = isCorrelatedReviewResponse(text) ? formatSlackMessageParts(text) : [text];
  let firstTs: string | undefined;
  for (const chunk of chunks) {
    const result = await client.chat.postMessage({
      channel: config.slack.channelId,
      text: chunk,
      unfurl_links: false,
    });
    if (!result.ts) throw new Error("Slack no devolvió ts al publicar un mensaje.");
    firstTs ??= result.ts;
  }
  if (!firstTs) throw new Error("Slack no devolvió ts al publicar un mensaje.");
  return firstTs;
}

export async function postToChannel(text: string): Promise<string> {
  return postToChannelSmart(text);
}

export async function postToThreadSmart(text: string | string[], threadTs: string): Promise<void> {
  if (typeof text === "string" && text.trim().length === 0) return;
  const client = getEffectiveSlackClient();
  const chunks = Array.isArray(text) ? text : formatSlackMessageParts(text);
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
