import type { MeshBridge, MeshInboundResult } from "./mesh-bridge.js";
import type { SlackEventsEnvelope } from "./slack-events.js";

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
  messages: PolledMeshMessage[];
  readThread: (threadTs: string, maxMessages: number) => Promise<PolledMeshMessage[]>;
  onResult?: (result: Exclude<MeshInboundResult, "ignored">) => void;
}

const MAX_MESH_ROOTS_PER_POLL = 20;
const MAX_MESH_MESSAGES_PER_THREAD = 20;

function isMeshRoot(message: PolledMeshMessage): boolean {
  return (
    message.text.startsWith("MESH/1\n") &&
    (!message.threadTs || message.threadTs === message.ts)
  );
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
  const roots = options.messages.filter(isMeshRoot).slice(0, MAX_MESH_ROOTS_PER_POLL);

  for (const root of roots) {
    await deliver(options.bridge, root, options.channelId, options.onResult);
    if (!root.replyCount || root.replyCount < 1) continue;

    const thread = await options.readThread(root.ts, MAX_MESH_MESSAGES_PER_THREAD);
    for (const reply of thread) {
      if (reply.ts === root.ts) continue;
      await deliver(options.bridge, reply, options.channelId, options.onResult);
    }
  }
}
