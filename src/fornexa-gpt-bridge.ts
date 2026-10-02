import "dotenv/config";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { WebClient } from "@slack/web-api";
import { isAgentNetworkLabel, parseAgentNetworkPeers, type AgentNetworkPeer } from "./agent-network.js";
import { MeshBridge, MeshBridgeError, type MeshBridgePublisher } from "./mesh-bridge.js";
import {
  extractMeshControllerRequest,
  formatMeshControllerFailureReceipt,
  formatMeshControllerReceipt,
  isMeshControllerAuthorized,
  MeshController,
  MeshControllerError,
  parseMeshControllerOrigins,
  parseMeshControllerPing,
  type MeshControllerOrigin,
} from "./mesh-controller.js";
import { reconcilePolledMesh, type PolledMeshMessage } from "./mesh-poll.js";
import { parseSlackEnvelope, verifySlackSignature } from "./slack-events.js";
import { verifySlackPublisherIdentity } from "./slack-publisher-identity.js";
import { isMeshControlAuthorized, parseMeshPingTarget } from "./mesh-control.js";

const DEFAULT_CHANNEL_ID = "C0BT661FYLW";
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1_000;
const MAX_MESH_ROOTS_PER_POLL = 20;
const MAX_MESH_MESSAGES_PER_THREAD = 20;

export interface FornexaGptBridgeConfig {
  enabled: boolean;
  channelId: string;
  agentLabel: string;
  peers: AgentNetworkPeer[];
  botToken: string | null;
  signingSecret: string | null;
  botUserId: string | null;
  botId: string | null;
  controlToken: string | null;
  controllerEnabled: boolean;
  controllerToken: string | null;
  controllerOrigins: MeshControllerOrigin[];
  pollIntervalMs: number;
}

export interface FornexaGptBridgeSlackClient {
  conversations: {
    history(options: { channel: string; limit: number }): Promise<{ messages?: SlackApiMessage[] }>;
    replies(options: { channel: string; ts: string; limit: number }): Promise<{ messages?: SlackApiMessage[] }>;
  };
}

interface SlackApiMessage {
  ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  thread_ts?: string;
  reply_count?: number;
}

function readOptional(env: NodeJS.ProcessEnv, name: string): string | null {
  return env[name]?.trim() || null;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = readOptional(env, name);
  if (!value) throw new Error(`Falta ${name} para activar el bridge de FornexaGPT.`);
  return value;
}

function parseBoolean(value: string | null, fallback: boolean): boolean {
  if (!value) return fallback;
  if (/^(?:1|true|yes)$/i.test(value)) return true;
  if (/^(?:0|false|no)$/i.test(value)) return false;
  throw new Error("SLACK_AGENT_NETWORK_ENABLED debe ser true o false.");
}

function readPollIntervalMs(value: string | null): number {
  if (!value) return DEFAULT_POLL_INTERVAL_MS;
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 1) {
    throw new Error("POLL_INTERVAL_MINUTES debe ser un número de al menos 1.");
  }
  return minutes * 60 * 1_000;
}

export function loadFornexaGptBridgeConfig(
  env: NodeJS.ProcessEnv = process.env
): FornexaGptBridgeConfig {
  const enabled = parseBoolean(readOptional(env, "SLACK_AGENT_NETWORK_ENABLED"), false);
  const controllerEnabled = parseBoolean(readOptional(env, "MESH_CONTROLLER_ENABLED"), false);
  const config: FornexaGptBridgeConfig = {
    enabled,
    channelId: readOptional(env, "SLACK_CHANNEL_ID") ?? DEFAULT_CHANNEL_ID,
    agentLabel: readOptional(env, "SLACK_AGENT_LABEL") ?? "GPT",
    peers: enabled ? parseAgentNetworkPeers(env.SLACK_AGENT_NETWORK_PEERS) : [],
    botToken: readOptional(env, "SLACK_BOT_TOKEN"),
    signingSecret: readOptional(env, "SLACK_SIGNING_SECRET"),
    botUserId: readOptional(env, "SLACK_BOT_USER_ID"),
    botId: readOptional(env, "SLACK_BOT_ID"),
    controlToken: readOptional(env, "MESH_CONTROL_TOKEN"),
    controllerEnabled,
    controllerToken: readOptional(env, "MESH_CONTROLLER_TOKEN"),
    controllerOrigins: [],
    pollIntervalMs: readPollIntervalMs(readOptional(env, "POLL_INTERVAL_MINUTES")),
  };
  if (!enabled) {
    if (controllerEnabled) throw new Error("El controlador MESH exige SLACK_AGENT_NETWORK_ENABLED=true.");
    return config;
  }

  required(env, "SLACK_BOT_TOKEN");
  required(env, "SLACK_SIGNING_SECRET");
  required(env, "MESH_CONTROL_TOKEN");
  if (config.agentLabel !== "GPT") {
    throw new Error("El bridge de FornexaGPT exige SLACK_AGENT_LABEL=GPT.");
  }
  if (!isAgentNetworkLabel(config.agentLabel)) {
    throw new Error("El bridge requiere una etiqueta MESH/1 válida.");
  }
  if (!/^U[A-Z0-9]+$/.test(config.botUserId ?? "") || !/^B[A-Z0-9]+$/.test(config.botId ?? "")) {
    throw new Error("El bridge exige SLACK_BOT_USER_ID y SLACK_BOT_ID válidos.");
  }
  if (config.peers.length === 0) {
    throw new Error("El bridge exige pares MESH/1 explícitos.");
  }
  if (config.peers.some(
    (peer) => peer.label === config.agentLabel || peer.userId === config.botUserId || peer.botId === config.botId
  )) {
    throw new Error("El bridge no admite su propia identidad entre los pares MESH/1.");
  }
  if (controllerEnabled) {
    required(env, "MESH_CONTROLLER_TOKEN");
    config.controllerOrigins = parseMeshControllerOrigins({
      urls: readOptional(env, "MESH_CONTROLLER_ORIGIN_URLS"),
      tokens: readOptional(env, "MESH_CONTROLLER_ORIGIN_TOKENS"),
      peers: config.peers,
    });
  }
  return config;
}

export function readRawBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        reject(new Error("request_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readPingTarget(req: IncomingMessage): Promise<string | null> {
  const rawBody = await readRawBody(req);
  return parseMeshPingTarget(rawBody);
}

async function readControllerPing(req: IncomingMessage): Promise<{ from: string; to: string } | null> {
  const rawBody = await readRawBody(req);
  return parseMeshControllerPing(rawBody);
}

function createPublisher(client: WebClient, channelId: string): MeshBridgePublisher {
  return {
    async postToChannel(text) {
      const result = await client.chat.postMessage({ channel: channelId, text, unfurl_links: false });
      if (!result.ts) throw new Error("Slack no devolvió ts al publicar un PING MESH/1.");
      return { ts: result.ts };
    },
    async postToThread(text, threadTs) {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text, unfurl_links: false });
    },
  };
}

function toPolledMeshMessage(message: SlackApiMessage): PolledMeshMessage {
  return {
    ts: message.ts ?? "",
    text: message.text ?? "",
    user: message.user,
    botId: message.bot_id,
    threadTs: message.thread_ts,
    replyCount: message.reply_count,
  };
}

/**
 * Reconciles the same bounded MESH/1 view used by the full reviewers. This is
 * strictly a delayed-delivery fallback when Slack Events are absent or late.
 */
export async function reconcileFornexaGptBridgePolling(options: {
  client: FornexaGptBridgeSlackClient;
  bridge: MeshBridge;
  config: Pick<FornexaGptBridgeConfig, "channelId" | "agentLabel" | "botId">;
  onResult?: (result: "acknowledged" | "ack_received") => void;
  nowMs?: number;
}): Promise<void> {
  const history = await options.client.conversations.history({
    channel: options.config.channelId,
    limit: MAX_MESH_ROOTS_PER_POLL,
  });
  await reconcilePolledMesh({
    bridge: options.bridge,
    channelId: options.config.channelId,
    localLabel: options.config.agentLabel ?? "GPT",
    localBotId: options.config.botId ?? null,
    messages: (history.messages ?? []).map(toPolledMeshMessage),
    async readThread(threadTs, maxMessages) {
      const replies = await options.client.conversations.replies({
        channel: options.config.channelId,
        ts: threadTs,
        limit: Math.min(maxMessages, MAX_MESH_MESSAGES_PER_THREAD),
      });
      return (replies.messages ?? []).map(toPolledMeshMessage);
    },
    onResult: options.onResult,
    nowMs: options.nowMs,
  });
}

function startFornexaGptBridgePolling(
  client: FornexaGptBridgeSlackClient,
  bridge: MeshBridge,
  config: Pick<FornexaGptBridgeConfig, "channelId" | "pollIntervalMs" | "agentLabel" | "botId">
): void {
  const poll = () => reconcileFornexaGptBridgePolling({
    client,
    bridge,
    config,
    onResult(result) {
      console.log(`[${new Date().toISOString()}] MESH/1 ${result} por sondeo en ${config.agentLabel}.`);
    },
  }).catch((error) => {
    console.error("Error en el sondeo de respaldo MESH/1 de FornexaGPT:", error);
  });

  const interval = setInterval(poll, config.pollIntervalMs);
  interval.unref();
  void poll();
}

export async function createFornexaGptBridgeServer(
  config = loadFornexaGptBridgeConfig()
): Promise<http.Server> {
  let bridge: MeshBridge | null = null;
  let controller: MeshController | null = null;
  let publisher: MeshBridgePublisher | null = null;
  if (config.enabled) {
    const client = new WebClient(config.botToken!);
    await verifySlackPublisherIdentity({
      client,
      expectedUserId: config.botUserId!,
      expectedBotId: config.botId!,
    });
    publisher = createPublisher(client, config.channelId);
    bridge = new MeshBridge(
      { channelId: config.channelId, localLabel: config.agentLabel, peers: config.peers },
      publisher
    );
    if (config.controllerEnabled) {
      controller = new MeshController(
        { localLabel: config.agentLabel, peers: config.peers, origins: config.controllerOrigins },
        (to) => bridge!.ping(to)
      );
    }
    startFornexaGptBridgePolling(client, bridge, config);
  }

  return http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (req.method === "GET" && pathname === "/") {
      sendJson(res, 200, { ok: true, service: "fornexa-gpt-bridge", mesh: config.enabled ? "enabled" : "disabled" });
      return;
    }

    if (req.method === "POST" && pathname === "/slack/events") {
      if (!config.enabled || !bridge || !config.signingSecret) {
        sendJson(res, 503, { ok: false, error: "mesh_disabled" });
        return;
      }
      readRawBody(req)
        .then(async (rawBody) => {
          const authentic = verifySlackSignature({
            rawBody,
            timestamp: req.headers["x-slack-request-timestamp"] as string | undefined,
            signature: req.headers["x-slack-signature"] as string | undefined,
            signingSecret: config.signingSecret!,
          });
          if (!authentic) {
            sendJson(res, 401, { ok: false, error: "invalid_signature" });
            return;
          }
          const envelope = parseSlackEnvelope(rawBody);
          if (!envelope) {
            sendJson(res, 400, { ok: false, error: "invalid_json" });
            return;
          }
          if (envelope.type === "url_verification") {
            sendJson(res, 200, { challenge: envelope.challenge ?? "" });
            return;
          }
          const meshResult = await bridge.receive(envelope);
          if (meshResult !== "ignored") {
            sendJson(res, 200, { ok: true });
            return;
          }
          if (controller && publisher) {
            const controlRequest = extractMeshControllerRequest({
              envelope,
              channelId: config.channelId,
              localIdentity: {
                label: config.agentLabel,
                userId: config.botUserId!,
                botId: config.botId!,
              },
              peers: config.peers,
            });
            if (controlRequest) {
              try {
                const result = await controller.ping({ ...controlRequest, requestTrace: controlRequest.traceId });
                await publisher.postToThread(
                  formatMeshControllerReceipt(controlRequest, result, config.agentLabel),
                  controlRequest.ts
                );
              } catch (error) {
                if (error instanceof MeshControllerError) {
                  await publisher.postToThread(
                    formatMeshControllerFailureReceipt(controlRequest, config.agentLabel, error.code),
                    controlRequest.ts
                  );
                } else {
                  throw error;
                }
              }
            }
          }
          sendJson(res, 200, { ok: true });
        })
        .catch((error: Error) => {
          const status = error.message === "request_too_large" ? 413 : 503;
          sendJson(res, status, { ok: false, error: status === 413 ? "request_too_large" : "mesh_delivery_failed" });
        });
      return;
    }

    if (req.method === "POST" && pathname === "/mesh/ping") {
      if (!config.enabled || !bridge) {
        sendJson(res, 503, { ok: false, error: "mesh_disabled" });
        return;
      }
      if (!isMeshControlAuthorized(req.headers.authorization, config.controlToken)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      readPingTarget(req)
        .then(async (to) => {
          if (!to) {
            sendJson(res, 400, { ok: false, error: "invalid_target" });
            return;
          }
          const result = await bridge!.ping(to);
          sendJson(res, 202, { ok: true, ...result });
        })
        .catch((error: unknown) => {
          if (error instanceof MeshBridgeError) {
            sendJson(res, error.code === "invalid_target" ? 422 : 429, { ok: false, error: error.code });
            return;
          }
          sendJson(res, 503, { ok: false, error: "mesh_ping_failed" });
        });
      return;
    }

    if (req.method === "GET" && pathname === "/mesh/status") {
      if (!isMeshControlAuthorized(req.headers.authorization, config.controlToken)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      sendJson(res, 200, { ok: true, mesh: config.enabled ? "enabled" : "disabled", pendingPings: bridge?.pendingCount() ?? 0 });
      return;
    }

    if (req.method === "POST" && pathname === "/mesh/controller/ping") {
      if (!config.controllerEnabled || !controller) {
        sendJson(res, 503, { ok: false, error: "controller_disabled" });
        return;
      }
      if (!isMeshControllerAuthorized(req.headers.authorization, config.controllerToken)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      readControllerPing(req)
        .then(async (request) => {
          if (!request) {
            sendJson(res, 400, { ok: false, error: "invalid_request" });
            return;
          }
          const result = await controller!.ping(request);
          sendJson(res, 202, { ok: true, ...result });
        })
        .catch((error: unknown) => {
          if (error instanceof MeshControllerError) {
            const status = error.code === "invalid_origin" || error.code === "invalid_target" ? 422 : 503;
            sendJson(res, status, { ok: false, error: error.code });
            return;
          }
          sendJson(res, 503, { ok: false, error: "controller_ping_failed" });
        });
      return;
    }

    if (req.method === "GET" && pathname === "/mesh/controller/status") {
      if (!config.controllerEnabled || !controller) {
        sendJson(res, 503, { ok: false, error: "controller_disabled" });
        return;
      }
      if (!isMeshControllerAuthorized(req.headers.authorization, config.controllerToken)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        controller: "enabled",
        localOrigin: config.agentLabel,
        remoteOrigins: config.controllerOrigins.map((origin) => origin.label),
      });
      return;
    }

    sendJson(res, 404, { ok: false, error: "not_found" });
  });
}

async function main(): Promise<void> {
  const server = await createFornexaGptBridgeServer();
  const port = Number(process.env.PORT) || 10000;
  server.listen(port, () => console.log(`Bridge FornexaGPT escuchando en el puerto ${port}.`));
}

if (/fornexa-gpt-bridge\.(?:js|ts)$/.test(process.argv[1] ?? "")) {
  main().catch((error) => {
    console.error("Error fatal del bridge FornexaGPT:", error);
    process.exit(1);
  });
}
