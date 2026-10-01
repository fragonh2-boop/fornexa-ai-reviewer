import "dotenv/config";
import { endpoints, type ProviderName } from "./providers.js";
import { isAgentNetworkLabel, parseAgentNetworkPeers } from "./agent-network.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Falta la variable de entorno obligatoria: ${name}. Revisa .env / .env.example.`
    );
  }
  return value;
}

function positiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} debe ser un número positivo.`);
  }
  return value;
}

function booleanValue(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") return fallback;
  if (/^(?:1|true|yes)$/i.test(raw)) return true;
  if (/^(?:0|false|no)$/i.test(raw)) return false;
  throw new Error(`${name} debe ser true o false.`);
}

const provider = (process.env.AI_PROVIDER ?? 'deepseek') as ProviderName;
if (!Object.hasOwn(endpoints, provider)) throw new Error('Unsupported AI_PROVIDER');
const prefix = { gpt: 'OPENAI', claude: 'ANTHROPIC', gemini: 'GEMINI', deepseek: 'DEEPSEEK' }[provider];
const mentionsEnabled = booleanValue("SLACK_MENTIONS_ENABLED", false);
const botUserId = process.env.SLACK_BOT_USER_ID?.trim() || null;
if (mentionsEnabled && !/^U[A-Z0-9]+$/.test(botUserId ?? "")) {
  throw new Error("SLACK_BOT_USER_ID debe contener el ID U… de la identidad de este bot.");
}
const agentNetworkEnabled = booleanValue("SLACK_AGENT_NETWORK_ENABLED", false);
const agentNetworkPeers = parseAgentNetworkPeers(process.env.SLACK_AGENT_NETWORK_PEERS);
const meshControlToken = process.env.MESH_CONTROL_TOKEN?.trim() || null;
const ownBotId = process.env.SLACK_BOT_ID?.trim() || null;
const signingSecret = process.env.SLACK_SIGNING_SECRET?.trim() || null;
const agentLabel = process.env.SLACK_AGENT_LABEL?.trim() || provider.toUpperCase();
if (agentNetworkEnabled && (!/^U[A-Z0-9]+$/.test(botUserId ?? "") || !/^B[A-Z0-9]+$/.test(ownBotId ?? ""))) {
  throw new Error("MESH/1 exige SLACK_BOT_USER_ID y SLACK_BOT_ID de la identidad propia.");
}
if (agentNetworkEnabled && agentNetworkPeers.length === 0) {
  throw new Error("MESH/1 exige pares explícitos en SLACK_AGENT_NETWORK_PEERS.");
}
if (agentNetworkEnabled && !meshControlToken) {
  throw new Error("MESH/1 exige MESH_CONTROL_TOKEN para emitir PINGs controlados.");
}
if (agentNetworkEnabled && !signingSecret) {
  throw new Error("MESH/1 exige SLACK_SIGNING_SECRET para verificar PINGs y ACKs.");
}
if (agentNetworkEnabled && !isAgentNetworkLabel(agentLabel)) {
  throw new Error("MESH/1 exige un SLACK_AGENT_LABEL válido (A-Z, 2-31 caracteres).");
}
if (agentNetworkEnabled && agentNetworkPeers.some(
  (peer) => peer.label === agentLabel || peer.userId === botUserId || peer.botId === ownBotId
)) {
  throw new Error("MESH/1 no admite que la identidad propia aparezca entre sus pares.");
}
export const config = {
  model: { provider, apiKey: required(`${prefix}_API_KEY`),
    name: process.env[`${prefix}_MODEL`] ?? (provider === 'deepseek' ? 'deepseek-v4-pro' : required(`${prefix}_MODEL`)),
    timeout: positiveNumber('AI_REQUEST_TIMEOUT_MS', positiveNumber('DEEPSEEK_REQUEST_TIMEOUT_MS', 180_000)) },
  slack: {
    botToken: required("SLACK_BOT_TOKEN"),
    channelId: process.env.SLACK_CHANNEL_ID ?? "C0BT661FYLW",
    agentLabel,
    signingSecret,
    mentions: {
      enabled: mentionsEnabled,
      botUserId,
    },
    botChannelToken: process.env.SLACK_BOT_CHANNEL_TOKEN?.trim() || null,
    agentNetwork: {
      enabled: agentNetworkEnabled,
      peers: agentNetworkPeers,
      controlToken: meshControlToken,
    },
    ownBotId,
  },
  github: {
    token: required("GITHUB_TOKEN"),
    owner: process.env.GITHUB_OWNER ?? "fragonh2-boop",
    repo: process.env.GITHUB_REPO ?? "Fornexa",
  },
  pollIntervalMinutes: positiveNumber("POLL_INTERVAL_MINUTES", 5),
  staleLockMinutes: positiveNumber("STALE_LOCK_MINUTES", 15),
  sidecarToken: process.env.SIDECAR_AUTH_TOKEN?.trim() || null,
};
