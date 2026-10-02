import type { MeshBridge, MeshInboundResult } from "./mesh-bridge.js";
import type { SlackEventsEnvelope } from "./slack-events.js";
import {
  parseAgentNetworkMessage,
  type ParsedAgentNetworkMessage,
} from "./agent-network.js";

export interface PolledMeshMessage {
  ts: string;
  text: string;
  user?: string;
  botId?: string;
  threadTs?: string;
  replyCount?: number;
}

export interface MeshPollOptions {
  bridge: Pick<MeshBridge, "receive">;
  channelId: string;
  localLabel: string;
  localBotId: string | null;
  messages: PolledMeshMessage[];
  readThread: (threadTs: string, maxMessages: number) => Promise<PolledMeshMessage[]>;
  onResult?: (result: Exclude<MeshInboundResult, "ignored">) => void;
  nowMs?: number;
}

const MAX_MESH_ROOTS_PER_POLL = 20;
const MAX_MESH_MESSAGES_PER_THREAD = 20;
const PING_TTL_MS = 15 * 60 * 1000;

function parseMeshRoot(message: PolledMeshMessage): ParsedAgentNetworkMessage | null {
  if (message.threadTs && message.threadTs !== message.ts) return null;
  const parsed = parseAgentNetworkMessage(message.text);
  return parsed?.type === "PING" ? parsed : null;
}

function isFreshRoot(message: PolledMeshMessage, nowMs: number): boolean {
  const timestampMs = Number(message.ts) * 1000;
  return Number.isFinite(timestampMs) && timestampMs >= nowMs - PING_TTL_MS && timestampMs <= nowMs;
}

function hasDurableLocalAck(
  root: PolledMeshMessage,
  ping: ParsedAgentNetworkMessage,
  replies: PolledMeshMessage[],
  localLabel: string,
  localBotId: string | null
): boolean {
  if (!localBotId) return false;
  return replies.some((reply) => {
    if (reply.ts === root.ts || reply.threadTs !== root.ts || reply.botId !== localBotId) return false;
    const ack = parseAgentNetworkMessage(reply.text);
    return Boolean(
      ack &&
        ack.type === "ACK" &&
        ack.traceId === ping.traceId &&
        ack.from === localLabel &&
        ack.to === ping.from
    );
  });
}

function toEnvelope(message: PolledMeshMessage, channelId: string): SlackEventsEnvelope {
  return {
    type: "event_callback",
    event: {
      type: "message",
      channel: channelId,
      text: message.text,
      ...(message.user ? { user: message.user } : {}),
      ...(message.botId ? { bot_id: message.botId, subtype: "bot_message" } : {}),
      ts: message.ts,
      ...(message.threadTs ? { thread_ts: message.threadTs } : {}),
    },
  };
}

async function deliver(
  bridge: Pick<MeshBridge, "receive">,
  message: PolledMeshMessage,
  channelId: string,
  onResult: MeshPollOptions["onResult"]
): Promise<void> {
  const result = await bridge.receive(toEnvelope(message, channelId));
  if (result !== "ignored") onResult?.(result);
}

/**
 * Reconciles only canonical MESH/1-looking roots through the existing signed
 * identity validator. It is a delayed delivery fallback for Slack Events and
 * cannot interpret arbitrary channel text as an instruction.
 */
export async function reconcilePolledMesh(options: MeshPollOptions): Promise<void> {
  const nowMs = options.nowMs ?? Date.now();
  const roots = options.messages
    .map((message) => ({ message, ping: parseMeshRoot(message) }))
    .filter((candidate): candidate is { message: PolledMeshMessage; ping: ParsedAgentNetworkMessage } =>
      Boolean(candidate.ping) && isFreshRoot(candidate.message, nowMs)
    )
    .slice(0, MAX_MESH_ROOTS_PER_POLL);

  for (const { message: root, ping } of roots) {
    // Slack retains the ACK in the thread, unlike the in-memory trace cache.
    // Inspect it before delivery so a free-plan restart cannot re-ACK a PING.
    const thread = await options.readThread(root.ts, MAX_MESH_MESSAGES_PER_THREAD);
    if (hasDurableLocalAck(root, ping, thread, options.localLabel, options.localBotId)) continue;

    await deliver(options.bridge, root, options.channelId, options.onResult);
    for (const reply of thread) {
      if (reply.ts === root.ts) continue;
      await deliver(options.bridge, reply, options.channelId, options.onResult);
    }
  }
}
