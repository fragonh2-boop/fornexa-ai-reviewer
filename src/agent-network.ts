import type { SlackEventsEnvelope } from "./slack-events.js";

const LABEL = /^[A-Z][A-Z0-9_-]{1,30}$/;
const TRACE = /^[A-Z0-9][A-Z0-9._-]{7,79}$/;

export type AgentNetworkType = "PING" | "ACK";

export interface AgentNetworkPeer {
  label: string;
  userId: string;
  botId: string;
}

export interface AgentNetworkMessage {
  type: AgentNetworkType;
  traceId: string;
  from: string;
  to: string;
  hop: number;
  maxHops: number;
  channel: string;
  ts: string;
  threadTs?: string;
  sender: AgentNetworkPeer;
}

export interface ParsedAgentNetworkMessage {
  type: AgentNetworkType;
  traceId: string;
  from: string;
  to: string;
  hop: number;
  maxHops: number;
}

export function parseAgentNetworkPeers(raw: string | undefined): AgentNetworkPeer[] {
  if (!raw?.trim()) return [];

  const peers = raw.split(",").map((entry) => {
    const parts = entry.trim().split(":");
    if (parts.length !== 3) throw new Error("SLACK_AGENT_NETWORK_PEERS debe usar LABEL:U…:B…");
    const [label, userId, botId] = parts;
    if (!LABEL.test(label) || !/^U[A-Z0-9]+$/.test(userId) || !/^B[A-Z0-9]+$/.test(botId)) {
      throw new Error("SLACK_AGENT_NETWORK_PEERS contiene una identidad no válida");
    }
    return { label, userId, botId };
  });

  const labels = new Set<string>();
  const users = new Set<string>();
  const bots = new Set<string>();
  for (const peer of peers) {
    if (labels.has(peer.label) || users.has(peer.userId) || bots.has(peer.botId)) {
      throw new Error("SLACK_AGENT_NETWORK_PEERS no admite identidades duplicadas");
    }
    labels.add(peer.label);
    users.add(peer.userId);
    bots.add(peer.botId);
  }
  return peers;
}

function oneField(lines: string[], field: string): string | null {
  const matches = lines.filter((line) => line.startsWith(`${field}: `));
  return matches.length === 1 ? matches[0].slice(field.length + 2) : null;
}

export function parseAgentNetworkMessage(text: string): ParsedAgentNetworkMessage | null {
  if (text.length > 1_000) return null;
  const lines = text.trim().split(/\r?\n/);
  if (lines.length !== 7 || lines[0] !== "MESH/1") return null;

  const type = oneField(lines, "TYPE");
  const traceId = oneField(lines, "TRACE");
  const from = oneField(lines, "FROM");
  const to = oneField(lines, "TO");
  const hop = oneField(lines, "HOP");
  const maxHops = oneField(lines, "MAX_HOPS");
  if (
    (type !== "PING" && type !== "ACK") ||
    !traceId || !TRACE.test(traceId) ||
    !from || !LABEL.test(from) ||
    !to || !LABEL.test(to) ||
    !hop || !/^(?:0|1)$/.test(hop) ||
    maxHops !== "1"
  ) {
    return null;
  }

  const parsed = { type, traceId, from, to, hop: Number(hop), maxHops: 1 } as ParsedAgentNetworkMessage;
  if ((parsed.type === "PING" && parsed.hop !== 0) || (parsed.type === "ACK" && parsed.hop !== 1)) {
    return null;
  }
  return parsed;
}

export function formatAgentNetworkMessage(message: Omit<ParsedAgentNetworkMessage, "maxHops">): string {
  if (!LABEL.test(message.from) || !LABEL.test(message.to) || !TRACE.test(message.traceId)) {
    throw new Error("MESH/1 requiere etiquetas y trace válidos");
  }
  if ((message.type === "PING" && message.hop !== 0) || (message.type === "ACK" && message.hop !== 1)) {
    throw new Error("MESH/1 solo permite PING inicial o ACK terminal");
  }
  return [
    "MESH/1",
    `TYPE: ${message.type}`,
    `TRACE: ${message.traceId}`,
    `FROM: ${message.from}`,
    `TO: ${message.to}`,
    `HOP: ${message.hop}`,
    "MAX_HOPS: 1",
  ].join("\n");
}

export function buildAgentNetworkAck(message: AgentNetworkMessage, localLabel: string): string {
  if (message.type !== "PING" || message.hop !== 0 || !LABEL.test(localLabel)) {
    throw new Error("Solo un PING MESH/1 válido puede recibir ACK");
  }
  return formatAgentNetworkMessage({
    type: "ACK",
    traceId: message.traceId,
    from: localLabel,
    to: message.from,
    hop: 1,
  });
}

export function extractAgentNetworkMessage(params: {
  envelope: SlackEventsEnvelope;
  channelId: string;
  localLabel: string;
  peers: AgentNetworkPeer[];
}): AgentNetworkMessage | null {
  const { envelope, channelId, localLabel, peers } = params;
  const event = envelope.event;
  if (
    envelope.type !== "event_callback" ||
    !event ||
    event.type !== "message" ||
    event.subtype ||
    event.channel !== channelId ||
    !event.bot_id ||
    !event.user ||
    !event.ts ||
    typeof event.text !== "string"
  ) {
    return null;
  }

  const parsed = parseAgentNetworkMessage(event.text);
  if (!parsed || parsed.to !== localLabel || parsed.from === localLabel) return null;
  if (parsed.type === "PING" && event.thread_ts && event.thread_ts !== event.ts) return null;

  const sender = peers.find(
    (peer) => peer.label === parsed.from && peer.userId === event.user && peer.botId === event.bot_id
  );
  if (!sender) return null;

  return {
    ...parsed,
    channel: event.channel,
    ts: event.ts,
    ...(event.thread_ts ? { threadTs: event.thread_ts } : {}),
    sender,
  };
}
