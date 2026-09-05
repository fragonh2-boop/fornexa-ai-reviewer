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
  };
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

export function extractReviewRequest(
  envelope: SlackEventsEnvelope,
  expectedChannel: string,
  agentLabel: string
): ReviewRequest | null {
  if (envelope.type !== "event_callback") return null;
  const event = envelope.event;
  if (
    !event ||
    event.type !== "message" ||
    event.subtype ||
    event.bot_id ||
    event.channel !== expectedChannel ||
    typeof event.text !== "string"
  ) {
    return null;
  }

  return parseReviewRequest(event.text, agentLabel);
}
