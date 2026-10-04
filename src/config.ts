import "dotenv/config";
import { endpoints, type ProviderName } from "./providers.js";
import {
  isAgentNetworkLabel,
  parseAgentNetworkPeers,
  peerIdentityAllowlist,
} from "./agent-network.js";

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

function trustedSlackIdentities(name: string, raw: string | undefined): string[] {
  if (!raw?.trim()) return [];

  const identities = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (identities.some((value) => !/^[UB][A-Z0-9]+$/.test(value))) {
    throw new Error(`${name} debe contener IDs Slack U… o B… explícitos, sin comodines.`);
  }

  return [...new Set(identities)];
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
// The dedicated FornexaGPT dispatcher may submit read-only review handoffs
// even while MESH/1 is disabled. Keep this narrow and explicit: this is not
// a permission for implementation, deployment, or arbitrary bot messages.
// SLACK_ALLOWED_BOT_IDS is accepted only as a migration alias for the prior
// Blueprint key; it intentionally has no wildcard mode.
const configuredReviewBotIds = trustedSlackIdentities(
  "SLACK_REVIEW_ALLOWED_BOT_IDS",
  process.env.SLACK_REVIEW_ALLOWED_BOT_IDS ?? process.env.SLACK_ALLOWED_BOT_IDS
);
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
    // Explicit MESH peers and the narrow review dispatcher allowlist are the
    // only bot identities eligible to submit a review handoff. Human-only
    // flows (implementation, context and mentions) do not consume this list.
    allowedBotIds: [
      ...new Set([...peerIdentityAllowlist(agentNetworkPeers), ...configuredReviewBotIds]),
    ],
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
