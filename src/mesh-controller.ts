import { isAgentNetworkLabel, type AgentNetworkPeer } from "./agent-network.js";
import { isMeshControlAuthorized } from "./mesh-control.js";
import type { SlackEventsEnvelope } from "./slack-events.js";

const TRACE = /^[A-Z0-9][A-Z0-9._-]{7,79}$/;
const MAX_TRACKED_REQUESTS = 1_000;
const REMOTE_TIMEOUT_MS = 10_000;

export interface MeshControllerRequest {
  traceId: string;
  from: string;
  to: string;
  channel: string;
  ts: string;
}

export interface MeshControllerOrigin {
  label: string;
  url: string;
  token: string;
}

export interface MeshControllerPingResult {
  traceId: string;
  rootTs: string;
}

export class MeshControllerError extends Error {
  constructor(
    readonly code: "invalid_origin" | "invalid_target" | "origin_unavailable" | "origin_rejected",
    message: string
  ) {
    super(message);
  }
}

function oneField(lines: string[], field: string): string | null {
  const matches = lines.filter((line) => line.startsWith(`${field}: `));
  return matches.length === 1 ? matches[0].slice(field.length + 2) : null;
}

/**
 * This is deliberately a separate protocol from MESH/1. It requests one
 * bounded PING; it cannot carry text, review work, code, or an action other
 * than an availability check.
 */
export function parseMeshControllerRequest(text: string): Omit<MeshControllerRequest, "channel" | "ts"> | null {
  if (text.length > 1_000) return null;
  const lines = text.trim().split(/\r?\n/);
  if (lines.length !== 5 || lines[0] !== "MESH-CONTROL/1") return null;

  const type = oneField(lines, "TYPE");
  const traceId = oneField(lines, "TRACE");
  const from = oneField(lines, "FROM");
  const to = oneField(lines, "TO");
  if (
    type !== "PING_REQUEST" ||
    !traceId || !TRACE.test(traceId) ||
    !from || !isAgentNetworkLabel(from) ||
    !to || !isAgentNetworkLabel(to) ||
    from === to
  ) {
    return null;
  }
  return { traceId, from, to };
}

export function parseMeshControllerPing(rawBody: string): Pick<MeshControllerRequest, "from" | "to"> | null {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed);
    if (entries.length !== 2) return null;
    const from = (parsed as Record<string, unknown>).from;
    const to = (parsed as Record<string, unknown>).to;
    if (
      typeof from !== "string" || typeof to !== "string" ||
      !isAgentNetworkLabel(from) || !isAgentNetworkLabel(to) || from === to
    ) {
      return null;
    }
    return { from, to };
  } catch {
    return null;
  }
}

function parseStringMap(raw: string | null, name: string): Record<string, string> {
  if (!raw) throw new Error(`Falta ${name} para activar el controlador MESH.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} debe ser un objeto JSON válido.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} debe ser un objeto JSON.`);
  }
  const values: Record<string, string> = {};
  for (const [label, value] of Object.entries(parsed)) {
    if (!isAgentNetworkLabel(label) || typeof value !== "string" || !value.trim()) {
      throw new Error(`${name} contiene una entrada no válida.`);
    }
    values[label] = value.trim();
  }
  return values;
}

function isSafeMeshPingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname === "/mesh/ping" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/**
 * Remote control material is parsed only in process memory. It is never
 * returned, logged, committed, or included in a Slack receipt.
 */
export function parseMeshControllerOrigins(params: {
  urls: string | null;
  tokens: string | null;
  peers: AgentNetworkPeer[];
}): MeshControllerOrigin[] {
  const urls = parseStringMap(params.urls, "MESH_CONTROLLER_ORIGIN_URLS");
  const tokens = parseStringMap(params.tokens, "MESH_CONTROLLER_ORIGIN_TOKENS");
  const expected = new Set(params.peers.map((peer) => peer.label));
  const urlLabels = Object.keys(urls);
  const tokenLabels = Object.keys(tokens);
  if (
    urlLabels.length !== expected.size || tokenLabels.length !== expected.size ||
    urlLabels.some((label) => !expected.has(label)) ||
    tokenLabels.some((label) => !expected.has(label))
  ) {
    throw new Error("El controlador MESH exige una URL y un secreto por cada par declarado.");
  }
  return params.peers.map((peer) => {
    const url = urls[peer.label];
    const token = tokens[peer.label];
    if (!isSafeMeshPingUrl(url) || !token) {
      throw new Error("El controlador MESH recibió un origen remoto no válido.");
    }
    return { label: peer.label, url, token };
  });
}

export function extractMeshControllerRequest(params: {
  envelope: SlackEventsEnvelope;
  channelId: string;
  localIdentity: { label: string; userId: string; botId: string };
  peers: AgentNetworkPeer[];
}): MeshControllerRequest | null {
  const event = params.envelope.event;
  const isBotMessage = event?.subtype === "bot_message";
  if (
    params.envelope.type !== "event_callback" ||
    !event || event.type !== "message" ||
    (event.subtype !== undefined && !isBotMessage) ||
    event.channel !== params.channelId ||
    !event.bot_id ||
    (!event.user && !isBotMessage) ||
    !event.ts ||
    event.thread_ts !== undefined ||
    typeof event.text !== "string"
  ) {
    return null;
  }
  const request = parseMeshControllerRequest(event.text);
  if (!request) return null;
  const sender = request.from === params.localIdentity.label
    ? params.localIdentity
    : params.peers.find((peer) => peer.label === request.from);
  if (!sender || sender.botId !== event.bot_id || (event.user !== undefined && sender.userId !== event.user)) {
    return null;
  }
  const labels = new Set([params.localIdentity.label, ...params.peers.map((peer) => peer.label)]);
  if (!labels.has(request.to)) return null;
  return { ...request, channel: event.channel, ts: event.ts };
}

export function formatMeshControllerReceipt(
  request: MeshControllerRequest,
  result: MeshControllerPingResult,
  controllerLabel: string
): string {
  return [
    "MESH-CONTROL/1",
    "TYPE: PING_ACCEPTED",
    `REQUEST_TRACE: ${request.traceId}`,
    `FROM: ${controllerLabel}`,
    `ORIGIN: ${request.from}`,
    `TARGET: ${request.to}`,
    `PING_TRACE: ${result.traceId}`,
    `ROOT_TS: ${result.rootTs}`,
  ].join("\n");
}

export function formatMeshControllerFailureReceipt(
  request: MeshControllerRequest,
  controllerLabel: string,
  reason: MeshControllerError["code"]
): string {
  return [
    "MESH-CONTROL/1",
    "TYPE: PING_REJECTED",
    `REQUEST_TRACE: ${request.traceId}`,
    `FROM: ${controllerLabel}`,
    `ORIGIN: ${request.from}`,
    `TARGET: ${request.to}`,
    `REASON: ${reason}`,
  ].join("\n");
}

type LocalPing = (to: string) => Promise<MeshControllerPingResult>;
type RemotePing = (origin: MeshControllerOrigin, to: string) => Promise<MeshControllerPingResult>;

async function postRemoteMeshPing(origin: MeshControllerOrigin, to: string): Promise<MeshControllerPingResult> {
  const signal = AbortSignal.timeout(REMOTE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(origin.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${origin.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ to }),
      signal,
    });
  } catch {
    throw new MeshControllerError("origin_unavailable", "El origen MESH no respondió.");
  }
  if (response.status !== 202) {
    throw new MeshControllerError("origin_rejected", "El origen MESH rechazó el PING controlado.");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new MeshControllerError("origin_rejected", "El origen MESH devolvió una respuesta inválida.");
  }
  const traceId = (body as Record<string, unknown>)?.traceId;
  const rootTs = (body as Record<string, unknown>)?.rootTs;
  if (typeof traceId !== "string" || !TRACE.test(traceId) || typeof rootTs !== "string" || !/^\d+\.\d+$/.test(rootTs)) {
    throw new MeshControllerError("origin_rejected", "El origen MESH no confirmó un PING válido.");
  }
  return { traceId, rootTs };
}

/**
 * A controller can initiate only MESH PINGs through configured origins. It
 * never receives model, GitHub, deployment, or free-text authority.
 */
export class MeshController {
  private readonly inFlight = new Map<string, Promise<MeshControllerPingResult>>();
  private readonly completed = new Map<string, MeshControllerPingResult>();

  constructor(
    private readonly config: {
      localLabel: string;
      peers: AgentNetworkPeer[];
      origins: MeshControllerOrigin[];
    },
    private readonly localPing: LocalPing,
    private readonly remotePing: RemotePing = postRemoteMeshPing
  ) {}

  private remember(key: string, result: MeshControllerPingResult): void {
    this.completed.set(key, result);
    while (this.completed.size > MAX_TRACKED_REQUESTS) {
      const oldest = this.completed.keys().next().value;
      if (oldest) this.completed.delete(oldest);
    }
  }

  async ping(params: Pick<MeshControllerRequest, "from" | "to"> & { requestTrace?: string }): Promise<MeshControllerPingResult> {
    const labels = new Set([this.config.localLabel, ...this.config.peers.map((peer) => peer.label)]);
    if (!labels.has(params.from)) {
      throw new MeshControllerError("invalid_origin", "El origen MESH no está declarado.");
    }
    if (!labels.has(params.to) || params.from === params.to) {
      throw new MeshControllerError("invalid_target", "El destino MESH no está declarado.");
    }
    const durableKey = params.requestTrace;
    const inFlightKey = durableKey ?? `${params.from}:${params.to}`;
    const completed = durableKey ? this.completed.get(durableKey) : undefined;
    if (completed) return completed;
    let pending = this.inFlight.get(inFlightKey);
    if (!pending) {
      pending = params.from === this.config.localLabel
        ? this.localPing(params.to)
        : this.invokeRemote(params.from, params.to);
      this.inFlight.set(inFlightKey, pending);
    }
    try {
      const result = await pending;
      if (durableKey) this.remember(durableKey, result);
      return result;
    } finally {
      if (this.inFlight.get(inFlightKey) === pending) this.inFlight.delete(inFlightKey);
    }
  }

  private async invokeRemote(from: string, to: string): Promise<MeshControllerPingResult> {
    const origin = this.config.origins.find((candidate) => candidate.label === from);
    if (!origin) {
      throw new MeshControllerError("invalid_origin", "El origen MESH no tiene control remoto configurado.");
    }
    return this.remotePing(origin, to);
  }
}

export function isMeshControllerAuthorized(
  authorization: string | undefined,
  expectedToken: string | null
): boolean {
  return isMeshControlAuthorized(authorization, expectedToken);
}
