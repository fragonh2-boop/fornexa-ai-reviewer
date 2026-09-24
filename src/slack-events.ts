import { createHmac, timingSafeEqual } from "node:crypto";
import { parseReviewRequest, type ReviewRequest } from "./review-request.js";

const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

export interface SlackEventsEnvelope {
  type?: string;
  challenge?: string;
  event_id?: string;
  event?: {
    type?: string;
    subtype?: string;
    channel?: string;
    text?: string;
    bot_id?: string;
    user?: string;
    ts?: string;
    thread_ts?: string;
  };
}

export interface SlackHumanMessageEvent {
  channel: string;
  text: string;
  user: string;
  ts: string;
  threadTs?: string;
}

export function verifySlackSignature(params: {
  rawBody: string;
  timestamp: string | undefined;
  signature: string | undefined;
  signingSecret: string;
  nowMs?: number;
}): boolean {
  const { rawBody, timestamp, signature, signingSecret, nowMs = Date.now() } = params;
  if (!timestamp || !signature || !/^v0=[0-9a-f]{64}$/i.test(signature)) return false;

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  const nowSeconds = Math.floor(nowMs / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > MAX_TIMESTAMP_SKEW_SECONDS) return false;

  const expected = `v0=${createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex")}`;
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(signature, "utf8");
  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

export function parseSlackEnvelope(rawBody: string): SlackEventsEnvelope | null {
  try {
    const parsed = JSON.parse(rawBody);
    return parsed && typeof parsed === "object" ? (parsed as SlackEventsEnvelope) : null;
  } catch {
    return null;
  }
}

export interface BotAllowlistOptions {
  allowedBotIds?: string[];
  ownBotId?: string | null;
  ownUserId?: string | null;
}

export function isSenderAllowed(
  sender: { botId?: string; user?: string },
  options: BotAllowlistOptions = {}
): boolean {
  if (!sender.botId) return Boolean(sender.user);

  const { allowedBotIds = [], ownBotId, ownUserId } = options;

  // Never allow the bot itself to trigger requests (strict anti-loop prevention)
  if (ownBotId && sender.botId === ownBotId) return false;
  if (ownUserId && sender.user === ownUserId) return false;

  if (allowedBotIds.length === 0) return false;
  if (allowedBotIds.includes("*") || allowedBotIds.includes("all")) return true;

  if (sender.botId && allowedBotIds.includes(sender.botId)) return true;
  if (sender.user && allowedBotIds.includes(sender.user)) return true;

  return false;
}

export function extractReviewRequest(
  envelope: SlackEventsEnvelope,
  expectedChannel: string,
  agentLabel: string,
  options: BotAllowlistOptions = {}
): ReviewRequest | null {
  const event = extractHumanMessage(envelope, expectedChannel, options);
  return event ? parseReviewRequest(event.text, agentLabel) : null;
}

export function extractHumanMessage(
  envelope: SlackEventsEnvelope,
  expectedChannel: string,
  options: BotAllowlistOptions = {}
): SlackHumanMessageEvent | null {
  if (envelope.type !== "event_callback") return null;
  const event = envelope.event;
  const hasSender = Boolean(event?.user || event?.bot_id);
  if (
    !event ||
    (event.type !== "message" && event.type !== "app_mention") ||
    event.subtype ||
    !isSenderAllowed({ botId: event.bot_id, user: event.user }, options) ||
    event.channel !== expectedChannel ||
    typeof event.text !== "string" ||
    !hasSender ||
    typeof event.ts !== "string"
  ) {
    return null;
  }

  return {
    channel: event.channel,
    text: event.text,
    user: event.user ?? event.bot_id!,
    ...(event.bot_id ? { botId: event.bot_id } : {}),
    ts: event.ts,
    threadTs: event.thread_ts,
  };
}
