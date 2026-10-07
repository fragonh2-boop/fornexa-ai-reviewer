import { supportsLegacyOnboarding } from "./providers.js";
import { createDiagnosticReporter } from "./request-diagnostics.js";
import { processImplementation } from "./implementation-runner.js";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config.js";
import { createReviewProcessor } from "./review-processor.js";
import {
  readRecentHistory,
  findPendingHandoffWithThreadState,
  postToChannel,
  postToThread,
  readThread,
  getEffectiveSlackClient,
  type SlackMessage,
} from "./tools/slack.js";
import { getPRContext, getRefContext } from "./tools/github.js";
import {
  answerSlackConversation,
  reviewPR,
  reviewRepository,
  runContextOnboarding,
} from "./agent.js";
import {
  sidecarManager,
  handleSidecarPoll,
  handleSidecarResponse,
  sendJson,
  readRawBody,
  verifySidecarAuth,
} from "./tools/external-services.js";
import {
  extractHumanMessage,
  extractReviewRequest,
  parseSlackEnvelope,
  type SlackHumanMessageEvent,
  verifySlackSignature,
} from "./slack-events.js";
import { MeshBridge, MeshBridgeError } from "./mesh-bridge.js";
import { isMeshControlAuthorized, parseMeshPingTarget } from "./mesh-control.js";
import { reconcilePolledMesh } from "./mesh-poll.js";
import { verifySlackPublisherIdentity } from "./slack-publisher-identity.js";
import {
  buildContextFromThread,
  containsPotentialSecret,
  contextAuthorKey,
  CONTEXT_MARKER,
  CONTEXT_RESPONSE_MARKER,
  isContextReadyMessage,
  isContextThreadRoot,
} from "./context-onboarding.js";
import { acquireLock, ownsLock, releaseLock } from "./reliability.js";
import { isCannotReplyToMessageError } from "./slack-errors.js";
import {
  buildMentionConversation,
  containsBotMention,
  formatMentionFailure,
  formatMentionResponse,
  formatMentionResponseParts,
  isDelegatedAgentMessage,
  isMentionTerminalResponse,
  MAX_MENTION_TURNS,
  mentionTurnLimitReached,
  parseMentionPrompt,
  selectPendingMentionTurn,
  type SlackMentionTurn,
} from "./slack-mentions.js";

const MAX_REMEMBERED_EVENT_IDS = 1000;
const inFlightContextThreads = new Map<string, number>();
const inFlightMentions = new Map<string, number>();
const nonReplyableMentionRequestTs = new Set<string>();
const processedEventIds = new Set<string>();
let meshBridge: MeshBridge | null = null;
const botReviewRequestOptions = {
  allowedBotIds: config.slack.allowedBotIds,
  ownBotId: config.slack.ownBotId,
  ownUserId: config.slack.mentions.botUserId,
};
const reportMalformed = createDiagnosticReporter(
  config.slack.agentLabel,
  postToThread,
  Date.now,
  botReviewRequestOptions
);
const staleLockMs = config.staleLockMinutes * 60 * 1000;

const { processReviewRequest, notifyFailure } = createReviewProcessor({
  agentLabel: config.slack.agentLabel,
  staleLockMs,
  getPRContext,
  getRefContext,
  reviewPR: (ctx, instructions) => reviewPR(ctx, "SEGUNDA_REVISION", undefined, instructions),
  reviewRepository,
  postToChannel,
  postToThread,
});

function createMeshBridge(): MeshBridge {
  return new MeshBridge(
    {
      channelId: config.slack.channelId,
      localLabel: config.slack.agentLabel,
      peers: config.slack.agentNetwork.peers,
    },
    {
      async postToChannel(text) {
        return { ts: await postToChannel(text) };
      },
      async postToThread(text, threadTs) {
        await postToThread(text, threadTs);
      },
    }
  );
}

function rememberEvent(eventId: string): boolean {
  if (processedEventIds.has(eventId)) return false;
  processedEventIds.add(eventId);

  if (processedEventIds.size > MAX_REMEMBERED_EVENT_IDS) {
    const oldest = processedEventIds.values().next().value;
    if (oldest) processedEventIds.delete(oldest);
  }

  return true;
}

function rememberNonReplyableMention(requestTs: string): void {
  nonReplyableMentionRequestTs.add(requestTs);
  if (nonReplyableMentionRequestTs.size > MAX_REMEMBERED_EVENT_IDS) {
    const oldest = nonReplyableMentionRequestTs.values().next().value;
    if (oldest) nonReplyableMentionRequestTs.delete(oldest);
  }
}

async function publishNonReplyableMentionFailure(
  turn: SlackMentionTurn,
  detail: string
): Promise<void> {
  const message = `${formatMentionFailure(
    config.slack.agentLabel,
    turn.ts,
    detail
  )}\n\nTHREAD_TS: ${turn.threadTs}\n_Respuesta publicada en el canal porque Slack no admite respuestas en ese mensaje._`;
  await postToChannel(message);
  rememberNonReplyableMention(turn.ts);
  console.warn(
    `[${new Date().toISOString()}] Slack no permite responder al hilo ${turn.threadTs}; ` +
      `la solicitud ${turn.ts} quedó cerrada en el canal.`
  );
}

async function processContextThread(threadTs: string): Promise<void> {
  if (!supportsLegacyOnboarding(config.model.provider)) return;
  const lock = acquireLock(inFlightContextThreads, threadTs, staleLockMs);
  if (!lock.acquired) {
    console.log(`[${new Date().toISOString()}] Contexto ${threadTs} ya está en curso; se omite.`);
    return;
  }
  if (lock.recoveredStaleLock) {
    console.warn(
      `[${new Date().toISOString()}] Contexto ${threadTs} atascado durante más de ${config.staleLockMinutes} minuto(s); se reintenta.`
    );
  }

  try {
    const messages = await readThread(threadTs);
    const root = messages.find((message) => message.ts === threadTs);
    const authorKey = root ? contextAuthorKey(root) : null;
    if (!authorKey) {
      if (!ownsLock(inFlightContextThreads, threadTs, lock.startedAt)) return;
      await postToThread(
        `${config.slack.agentLabel} — CONTEXTO NO PROCESADO\n\nNo se ha podido verificar el autor de Slack del mensaje raíz.`,
        threadTs
      );
      return;
    }
    if (messages.some((message) => message.text.startsWith(CONTEXT_RESPONSE_MARKER))) {
      console.log(`[${new Date().toISOString()}] El contexto ${threadTs} ya tiene respuesta.`);
      return;
    }

    const built = buildContextFromThread(messages, authorKey);
    if (!built.ok) {
      if (!ownsLock(inFlightContextThreads, threadTs, lock.startedAt)) return;
      await postToThread(
        `${config.slack.agentLabel} — CONTEXTO NO PROCESADO\n\n${built.error}`,
        threadTs
      );
      console.log(`[${new Date().toISOString()}] Contexto ${threadTs} rechazado: ${built.error}`);
      return;
    }

    console.log(
      `[${new Date().toISOString()}] Procesando ${built.packageCount} paquetes de contexto del hilo ${threadTs}.`
    );
    const response = await runContextOnboarding(built.context);
    if (!ownsLock(inFlightContextThreads, threadTs, lock.startedAt)) return;
    await postToThread(response, threadTs);
    console.log(`[${new Date().toISOString()}] Preguntas de contexto publicadas en ${threadTs}.`);
  } catch (err) {
    if (ownsLock(inFlightContextThreads, threadTs, lock.startedAt)) {
      await notifyFailure(`El procesamiento del contexto ${threadTs} falló antes de completarse.`);
    }
    throw err;
  } finally {
    releaseLock(inFlightContextThreads, threadTs, lock.startedAt);
  }
}

async function processSlackMention(
  event: SlackHumanMessageEvent,
  prefetchedThread?: SlackMessage[]
): Promise<boolean> {
  if (!config.slack.mentions.enabled || !config.slack.mentions.botUserId) return false;
  if (isDelegatedAgentMessage(event.text)) return false;
  const threadTs = event.threadTs ?? event.ts;
  const messages = prefetchedThread ?? (await readThread(threadTs));
  if (!messages.some((message) => message.ts === event.ts)) {
    messages.push({
      ts: event.ts,
      text: event.text,
      user: event.user,
      threadTs: event.threadTs,
    });
  }

  const turn = selectPendingMentionTurn({
    channel: event.channel,
    threadTs,
    messages,
    botUserId: config.slack.mentions.botUserId,
    agentLabel: config.slack.agentLabel,
  });

  if (!turn) {
    const root = messages.find((message) => message.ts === threadTs);
    const belongsToMentionThread = Boolean(
      root && containsBotMention(root.text, config.slack.mentions.botUserId)
    );
    if (!belongsToMentionThread) return false;
    if (
      messages.some((message) =>
        isMentionTerminalResponse(message, config.slack.agentLabel, event.ts)
      )
    ) {
      return false;
    }
    if (
      mentionTurnLimitReached({
        messages,
        threadTs,
        requestTs: event.ts,
        botUserId: config.slack.mentions.botUserId,
      })
    ) {
      await postToThread(
        formatMentionFailure(
          config.slack.agentLabel,
          event.ts,
          `El hilo alcanzó el máximo de ${MAX_MENTION_TURNS} turnos humanos. Abre uno nuevo mencionando al bot.`
        ),
        threadTs
      );
      return true;
    }
    const parsed = parseMentionPrompt(event.text, config.slack.mentions.botUserId);
    if (parsed.ok) return false;
    await postToThread(
      formatMentionFailure(config.slack.agentLabel, event.ts, parsed.error),
      threadTs
    );
    return true;
  }

  const key = `mention:${turn.ts}`;
  if (nonReplyableMentionRequestTs.has(turn.ts)) return false;
  const lock = acquireLock(inFlightMentions, key, staleLockMs);
  if (!lock.acquired) return false;

  try {
    const latest = await readThread(turn.threadTs);
    if (
      latest.some((message) =>
        isMentionTerminalResponse(message, config.slack.agentLabel, turn.ts)
      )
    ) {
      return false;
    }
    const conversation = buildMentionConversation({
      messages: latest,
      turn,
      botUserId: config.slack.mentions.botUserId,
      agentLabel: config.slack.agentLabel,
    });
    const response = await answerSlackConversation(conversation, { threadTs: turn.threadTs });
    if (!ownsLock(inFlightMentions, key, lock.startedAt)) return false;
    await postToThread(
      formatMentionResponseParts(config.slack.agentLabel, turn.ts, response),
      turn.threadTs
    );
    console.log(
      `[${new Date().toISOString()}] Respuesta de ${config.slack.agentLabel} publicada para Slack ${turn.ts}.`
    );
    return true;
  } catch (err) {
    if (ownsLock(inFlightMentions, key, lock.startedAt)) {
      const rawError = (err as Error)?.message || String(err);
      const safeError = containsPotentialSecret(rawError)
        ? "error del proveedor"
        : rawError.replace(/\s+/g, " ").trim().slice(0, 300);
      const detail = `No se ha podido completar la consulta: ${safeError}. Vuelve a mencionar al bot para reintentarlo.`;
      if (isCannotReplyToMessageError(err)) {
        await publishNonReplyableMentionFailure(turn, detail);
        return true;
      }
      try {
        await postToThread(
          formatMentionFailure(config.slack.agentLabel, turn.ts, detail),
          turn.threadTs
        );
      } catch (notificationError) {
        if (!isCannotReplyToMessageError(notificationError)) throw notificationError;
        await publishNonReplyableMentionFailure(turn, detail);
        console.error(
          `[${new Date().toISOString()}] La consulta ${turn.ts} falló antes del fallback de Slack:`,
          err
        );
        return true;
      }
    }
    throw err;
  } finally {
    releaseLock(inFlightMentions, key, lock.startedAt);
  }
}

async function findPendingMention(messages: SlackMessage[]): Promise<{
  turn: SlackMentionTurn;
  thread: SlackMessage[];
} | null> {
  if (!config.slack.mentions.enabled || !config.slack.mentions.botUserId) return null;
  const roots = messages
    .filter(
      (message) =>
        !message.botId &&
        Boolean(message.user) &&
        !isDelegatedAgentMessage(message.text) &&
        (!message.threadTs || message.threadTs === message.ts) &&
        containsBotMention(message.text, config.slack.mentions.botUserId!)
    )
    .slice(0, 50);

  for (const root of roots) {
    const thread = await readThread(root.ts);
    const turn = selectPendingMentionTurn({
      channel: config.slack.channelId,
      threadTs: root.ts,
      messages: thread,
      terminalMessages: messages,
      botUserId: config.slack.mentions.botUserId,
      agentLabel: config.slack.agentLabel,
    });
    if (turn && !nonReplyableMentionRequestTs.has(turn.ts)) return { turn, thread };
  }
  return null;
}

async function findPendingContextThread(messages: SlackMessage[]): Promise<{
  threadTs: string;
} | null> {
  if (!supportsLegacyOnboarding(config.model.provider)) return null;
  const roots = messages.filter(
    (message) =>
      !message.botId &&
      Boolean(message.user) &&
      message.text.startsWith(CONTEXT_MARKER) &&
      isContextThreadRoot(message)
  );

  for (const root of roots) {
    const thread = await readThread(root.ts);
    if (thread.some((message) => message.text.startsWith(CONTEXT_RESPONSE_MARKER))) continue;
    const built = buildContextFromThread(thread, contextAuthorKey(root)!);
    if (built.ok) return { threadTs: root.ts };
  }

  return null;
}

async function tick(): Promise<void> {
  const messages = await readRecentHistory();
  if (meshBridge) {
    await reconcilePolledMesh({
      bridge: meshBridge,
      channelId: config.slack.channelId,
      localLabel: config.slack.agentLabel,
      localBotId: config.slack.ownBotId,
      messages,
      readThread,
      onResult(result) {
        console.log(`[${new Date().toISOString()}] MESH/1 ${result} por sondeo en ${config.slack.agentLabel}.`);
      },
    });
  }
  for (const message of messages) {
    if (await reportMalformed(message)) continue;
    if (message.botId) continue;
    if (await processImplementation(message)) break;
  }
  const pending = await findPendingHandoffWithThreadState(
    messages,
    config.slack.agentLabel,
    botReviewRequestOptions,
    readThread
  );

  if (pending) {
    await processReviewRequest(pending, {
      requestTs: pending.raw.ts,
      threadTs: pending.raw.threadTs ?? pending.raw.ts,
    }).catch(() => {
      // The processor has attempted the correlated terminal and released its
      // lock; do not forward arbitrary provider/tool errors to polling logs.
      throw new Error("Fallo procesando una revisión durante el sondeo.");
    });
    return;
  }

  const pendingContext = await findPendingContextThread(messages);
  if (pendingContext) {
    await processContextThread(pendingContext.threadTs);
    return;
  }

  const pendingMention = await findPendingMention(messages);
  if (pendingMention) {
    await processSlackMention(
      {
        channel: pendingMention.turn.channel,
        text: pendingMention.turn.prompt,
        user: pendingMention.turn.user,
        ts: pendingMention.turn.ts,
        threadTs: pendingMention.turn.threadTs,
      },
      pendingMention.thread
    );
    return;
  }

  console.log(`[${new Date().toISOString()}] Sin handoffs pendientes para ${config.slack.agentLabel}.`);
}

async function handleSlackEvents(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!config.slack.signingSecret) {
    sendJson(res, 503, { ok: false, error: "slack_events_not_configured" });
    return;
  }

  let rawBody: string;
  try {
    rawBody = await readRawBody(req);
  } catch {
    sendJson(res, 413, { ok: false, error: "request_too_large" });
    return;
  }

  const isAuthentic = verifySlackSignature({
    rawBody,
    timestamp: req.headers["x-slack-request-timestamp"] as string | undefined,
    signature: req.headers["x-slack-signature"] as string | undefined,
    signingSecret: config.slack.signingSecret,
  });
  if (!isAuthentic) {
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

  if (meshBridge) {
    try {
      const result = await meshBridge.receive(envelope);
      if (result !== "ignored") {
        console.log(`[${new Date().toISOString()}] MESH/1 ${result} en ${config.slack.agentLabel}.`);
        sendJson(res, 200, { ok: true });
        return;
      }
    } catch (error) {
      console.error("Error entregando MESH/1:", error);
      sendJson(res, 503, { ok: false, error: "mesh_delivery_failed" });
      return;
    }
  }

  sendJson(res, 200, { ok: true });

  if (envelope.event_id && !rememberEvent(envelope.event_id)) return;

  const reviewSenderMessage = extractHumanMessage(
    envelope,
    config.slack.channelId,
    botReviewRequestOptions
  );
  if (reviewSenderMessage && await reportMalformed(reviewSenderMessage)) return;

  const humanMessage = extractHumanMessage(envelope, config.slack.channelId);
  if (humanMessage && /^MODE:\s*IMPLEMENT\s*$/m.test(humanMessage.text)) {
    setImmediate(() => { processImplementation(humanMessage).catch(() => console.error('Implementation failed; checkpoint retained')); });
    return;
  }
  if (supportsLegacyOnboarding(config.model.provider) && humanMessage && isContextReadyMessage(humanMessage.text)) {
    const threadTs = humanMessage.threadTs ?? humanMessage.ts;
    setImmediate(() => {
      processContextThread(threadTs).catch((err) =>
        console.error("Error procesando el contexto de Slack:", err)
      );
    });
    return;
  }

  const request = extractReviewRequest(
    envelope,
    config.slack.channelId,
    config.slack.agentLabel,
    botReviewRequestOptions
  );
  if (request) {
    setImmediate(() => {
      processReviewRequest(request, {
        requestTs: reviewSenderMessage?.ts ?? envelope.event?.ts ?? "unknown",
        threadTs:
          reviewSenderMessage?.threadTs ??
          envelope.event?.thread_ts ??
          reviewSenderMessage?.ts ??
          envelope.event?.ts ??
          "unknown",
      }).catch(() => console.error("Fallo procesando la revisión del evento de Slack."));
    });
    return;
  }

  if (humanMessage && config.slack.mentions.enabled) {
    setImmediate(() => {
      processSlackMention(humanMessage).catch((err) =>
        console.error("Error procesando la mención de Slack:", err)
      );
    });
  }
}

async function handleMeshPing(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!meshBridge || !config.slack.agentNetwork.enabled) {
    sendJson(res, 503, { ok: false, error: "mesh_disabled" });
    return;
  }
  if (!isMeshControlAuthorized(req.headers.authorization, config.slack.agentNetwork.controlToken)) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return;
  }

  let rawBody: string;
  try {
    rawBody = await readRawBody(req, 64 * 1024);
  } catch {
    sendJson(res, 413, { ok: false, error: "request_too_large" });
    return;
  }
  const to = parseMeshPingTarget(rawBody);
  if (!to) {
    sendJson(res, 400, { ok: false, error: "invalid_target" });
    return;
  }

  try {
    const result = await meshBridge.ping(to);
    sendJson(res, 202, { ok: true, ...result });
  } catch (error) {
    if (error instanceof MeshBridgeError) {
      sendJson(res, error.code === "invalid_target" ? 422 : 429, { ok: false, error: error.code });
      return;
    }
    console.error("Error emitiendo MESH/1:", error);
    sendJson(res, 503, { ok: false, error: "mesh_ping_failed" });
  }
}

function handleMeshStatus(req: IncomingMessage, res: ServerResponse): void {
  if (!isMeshControlAuthorized(req.headers.authorization, config.slack.agentNetwork.controlToken)) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    mesh: config.slack.agentNetwork.enabled ? "enabled" : "disabled",
    pendingPings: meshBridge?.pendingCount() ?? 0,
  });
}

function startHttpServer(): void {
  const port = Number(process.env.PORT) || 10000;
  http
    .createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

      if (req.method === "GET" && pathname === "/") {
        const mode = config.slack.signingSecret
          ? "Slack Events + polling de respaldo"
          : "polling";
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(
          `fornexa-ai-reviewer: vivo, provider=${config.model.provider}, model=${config.model.name}, modo ${mode}.\n`
        );
        return;
      }

      if (req.method === "POST" && pathname === "/slack/events") {
        handleSlackEvents(req, res).catch((err) => {
          console.error("Error atendiendo Slack Events:", err);
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: "internal_error" });
        });
        return;
      }

      if (req.method === "POST" && pathname === "/mesh/ping") {
        handleMeshPing(req, res).catch((err) => {
          console.error("Error en /mesh/ping:", err);
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: "internal_error" });
        });
        return;
      }

      if (req.method === "GET" && pathname === "/mesh/status") {
        handleMeshStatus(req, res);
        return;
      }

      if (req.method === "GET" && pathname === "/sidecar/status") {
        const isAuthorized = config.sidecarToken
          ? verifySidecarAuth(req, config.sidecarToken)
          : false;
        sendJson(res, 200, {
          ok: true,
          online: isAuthorized ? sidecarManager.isOnline() : false,
        });
        return;
      }

      if (req.method === "POST" && pathname === "/sidecar/poll") {
        handleSidecarPoll(req, res, config.sidecarToken).catch((err) => {
          console.error("Error en /sidecar/poll:", err);
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: "internal_error" });
        });
        return;
      }

      if (req.method === "POST" && pathname === "/sidecar/response") {
        handleSidecarResponse(req, res, config.sidecarToken).catch((err) => {
          console.error("Error en /sidecar/response:", err);
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: "internal_error" });
        });
        return;
      }

      sendJson(res, 404, { ok: false, error: "not_found" });
    })
    .listen(port, () => {
      console.log(`Servidor HTTP escuchando en el puerto ${port}.`);
    });
}

async function main(): Promise<void> {
  const runOnce = process.argv.includes("--once");

  if (config.slack.agentNetwork.enabled) {
    await verifySlackPublisherIdentity({
      client: getEffectiveSlackClient(),
      expectedUserId: config.slack.mentions.botUserId!,
      expectedBotId: config.slack.ownBotId!,
    });
    meshBridge = createMeshBridge();
    console.log("MESH/1: identidad del token publicador verificada.");
  }

  if (runOnce) {
    await tick();
    return;
  }

  startHttpServer();

  tick().catch((err) => console.error("Error en el primer ciclo de sondeo:", err));

  const intervalMs = config.pollIntervalMinutes * 60 * 1000;
  console.log(`Sondeando #fornexa cada ${config.pollIntervalMinutes} minuto(s) como respaldo...`);
  setInterval(() => {
    tick().catch((err) => console.error("Error en el ciclo de sondeo:", err));
  }, intervalMs);
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
