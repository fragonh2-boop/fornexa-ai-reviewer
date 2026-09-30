import { randomUUID } from "node:crypto";
import {
  buildAgentNetworkAck,
  extractAgentNetworkMessage,
  formatAgentNetworkMessage,
  isAgentNetworkLabel,
  type AgentNetworkPeer,
} from "./agent-network.js";
import type { SlackEventsEnvelope } from "./slack-events.js";

const MAX_TRACKED_TRACES = 1_000;
const PING_TTL_MS = 15 * 60 * 1000;
const PING_COOLDOWN_MS = 60 * 1000;

export class MeshBridgeError extends Error {
  constructor(
    readonly code: "invalid_target" | "ping_rate_limited",
    message: string
  ) {
    super(message);
  }
}

export interface MeshBridgePublisher {
  postToChannel(text: string): Promise<{ ts: string }>;
  postToThread(text: string, threadTs: string): Promise<void>;
}

export interface MeshBridgeConfig {
  channelId: string;
  localLabel: string;
  peers: AgentNetworkPeer[];
}

interface PendingPing {
  to: string;
  rootTs: string;
  createdAt: number;
}

export type MeshInboundResult = "ignored" | "acknowledged" | "ack_received";

/**
 * State machine for the dedicated FornexaGPT MESH/1 bridge. It deliberately
 * has no model, GitHub, deployment, arbitrary text, or command capability.
 */
export class MeshBridge {
  private readonly processedInboundTraces = new Set<string>();
  private readonly inFlightInboundTraces = new Map<string, Promise<void>>();
  private readonly inFlightOutboundPeers = new Set<string>();
  private readonly pendingPings = new Map<string, PendingPing>();
  private readonly lastOutboundPingAt = new Map<string, number>();

  constructor(
    private readonly config: MeshBridgeConfig,
    private readonly publisher: MeshBridgePublisher,
    private readonly now: () => number = Date.now
  ) {
    if (!isAgentNetworkLabel(config.localLabel)) {
      throw new Error("El bridge MESH/1 requiere una etiqueta local válida.");
    }
  }

  private remember(set: Set<string>, value: string): void {
    set.add(value);
    if (set.size > MAX_TRACKED_TRACES) {
      const oldest = set.values().next().value;
      if (oldest) set.delete(oldest);
    }
  }

  private expirePending(): void {
    const cutoff = this.now() - PING_TTL_MS;
    for (const [traceId, pending] of this.pendingPings) {
      if (pending.createdAt < cutoff) this.pendingPings.delete(traceId);
    }
    while (this.pendingPings.size > MAX_TRACKED_TRACES) {
      const oldest = this.pendingPings.keys().next().value;
      if (oldest) this.pendingPings.delete(oldest);
    }
  }

  async receive(envelope: SlackEventsEnvelope): Promise<MeshInboundResult> {
    this.expirePending();
    const message = extractAgentNetworkMessage({
      envelope,
      channelId: this.config.channelId,
      localLabel: this.config.localLabel,
      peers: this.config.peers,
    });
    if (!message) return "ignored";

    if (message.type === "ACK") {
      const pending = this.pendingPings.get(message.traceId);
      if (
        !pending ||
        pending.to !== message.from ||
        message.threadTs !== pending.rootTs
      ) {
        return "ignored";
      }
      this.pendingPings.delete(message.traceId);
      return "ack_received";
    }

    if (this.processedInboundTraces.has(message.traceId)) return "ignored";

    let delivery = this.inFlightInboundTraces.get(message.traceId);
    if (!delivery) {
      delivery = this.publisher.postToThread(
        buildAgentNetworkAck(message, this.config.localLabel),
        message.threadTs ?? message.ts
      ).then(() => {
        this.remember(this.processedInboundTraces, message.traceId);
      });
      this.inFlightInboundTraces.set(message.traceId, delivery);
    }
    try {
      // Slack retries can overlap. Every duplicate waits for this same delivery:
      // success is confirmed only after the ACK is posted; failure remains 5xx.
      await delivery;
      return "acknowledged";
    } finally {
      if (this.inFlightInboundTraces.get(message.traceId) === delivery) {
        this.inFlightInboundTraces.delete(message.traceId);
      }
    }
  }

  async ping(to: string): Promise<{ traceId: string; rootTs: string }> {
    this.expirePending();
    const peer = this.config.peers.find((candidate) => candidate.label === to);
    if (!peer) {
      throw new MeshBridgeError("invalid_target", "El destino MESH/1 no es un par declarado.");
    }
    if ([...this.pendingPings.values()].some((pending) => pending.to === peer.label)) {
      throw new MeshBridgeError("ping_rate_limited", "Ya hay un PING MESH/1 pendiente para este par.");
    }
    if (this.inFlightOutboundPeers.has(peer.label)) {
      throw new MeshBridgeError("ping_rate_limited", "Ya hay un PING MESH/1 en envío para este par.");
    }
    const lastPingAt = this.lastOutboundPingAt.get(peer.label);
    if (lastPingAt !== undefined && this.now() - lastPingAt < PING_COOLDOWN_MS) {
      throw new MeshBridgeError("ping_rate_limited", "El límite de PING MESH/1 para este par sigue activo.");
    }

    this.inFlightOutboundPeers.add(peer.label);
    try {
      const traceId = `MESH-${randomUUID().toUpperCase()}`;
      const text = formatAgentNetworkMessage({
        type: "PING",
        traceId,
        from: this.config.localLabel,
        to: peer.label,
        hop: 0,
      });
      const result = await this.publisher.postToChannel(text);
      if (!result.ts) throw new Error("Slack no devolvió el timestamp del PING MESH/1.");

      this.pendingPings.set(traceId, {
        to: peer.label,
        rootTs: result.ts,
        createdAt: this.now(),
      });
      this.lastOutboundPingAt.set(peer.label, this.now());
      return { traceId, rootTs: result.ts };
    } finally {
      this.inFlightOutboundPeers.delete(peer.label);
    }
  }

  pendingCount(): number {
    this.expirePending();
    return this.pendingPings.size;
  }
}
