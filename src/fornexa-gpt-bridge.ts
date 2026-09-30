import "dotenv/config";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebClient } from "@slack/web-api";
import { isAgentNetworkLabel, parseAgentNetworkPeers, type AgentNetworkPeer } from "./agent-network.js";
import { MeshBridge, MeshBridgeError, type MeshBridgePublisher } from "./mesh-bridge.js";
import { parseSlackEnvelope, verifySlackSignature } from "./slack-events.js";
import { verifySlackPublisherIdentity } from "./slack-publisher-identity.js";

const DEFAULT_CHANNEL_ID = "C0BT661FYLW";
const MAX_BODY_BYTES = 64 * 1024;

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

export function loadFornexaGptBridgeConfig(
  env: NodeJS.ProcessEnv = process.env
): FornexaGptBridgeConfig {
  const enabled = parseBoolean(readOptional(env, "SLACK_AGENT_NETWORK_ENABLED"), false);
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
  };
  if (!enabled) return config;

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

function authorized(req: IncomingMessage, expectedToken: string | null): boolean {
  if (!expectedToken) return false;
  const supplied = req.headers.authorization;
  if (!supplied?.startsWith("Bearer ")) return false;
  const received = Buffer.from(supplied.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function readPingTarget(req: IncomingMessage): Promise<string | null> {
  const rawBody = await readRawBody(req);
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed);
    if (entries.length !== 1 || entries[0][0] !== "to" || typeof entries[0][1] !== "string") return null;
    return entries[0][1].trim() || null;
  } catch {
    return null;
  }
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

export async function createFornexaGptBridgeServer(
  config = loadFornexaGptBridgeConfig()
): Promise<http.Server> {
  let bridge: MeshBridge | null = null;
  if (config.enabled) {
    const client = new WebClient(config.botToken!);
    await verifySlackPublisherIdentity({
      client,
      expectedUserId: config.botUserId!,
      expectedBotId: config.botId!,
    });
    bridge = new MeshBridge(
      { channelId: config.channelId, localLabel: config.agentLabel, peers: config.peers },
      createPublisher(client, config.channelId)
    );
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
          await bridge.receive(envelope);
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
      if (!authorized(req, config.controlToken)) {
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
      if (!authorized(req, config.controlToken)) {
        sendJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      sendJson(res, 200, { ok: true, mesh: config.enabled ? "enabled" : "disabled", pendingPings: bridge?.pendingCount() ?? 0 });
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
