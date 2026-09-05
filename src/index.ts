import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config.js";
import { readRecentHistory, findPendingHandoff, postToChannel } from "./tools/slack.js";
import { getPRContext } from "./tools/github.js";
import { reviewPR } from "./deepseek.js";
import {
  extractReviewRequest,
  parseSlackEnvelope,
  verifySlackSignature,
} from "./slack-events.js";
import type { ReviewRequest } from "./review-request.js";

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_REMEMBERED_EVENT_IDS = 1000;
const inFlightReviews = new Set<string>();
const processedEventIds = new Set<string>();

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BODY_BYTES) {
      throw new Error("El cuerpo de la petición supera 1 MiB.");
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
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

async function processReviewRequest(request: ReviewRequest): Promise<void> {
  const reviewKey = `${request.prNumber}:${request.requestedHead}`;
  if (inFlightReviews.has(reviewKey)) {
    console.log(`[${new Date().toISOString()}] Revisión ${reviewKey} ya está en curso; se omite.`);
    return;
  }

  inFlightReviews.add(reviewKey);
  try {
    console.log(
      `[${new Date().toISOString()}] Handoff detectado: PR #${request.prNumber}, HEAD ${request.requestedHead}. Revisando...`
    );

    const ctx = await getPRContext(request.prNumber);
    if (!ctx.headSha.toLowerCase().startsWith(request.requestedHead)) {
      await postToChannel(
        `${config.slack.agentLabel} — REVISIÓN NO INICIADA\n\nPR #${ctx.number}: el HEAD solicitado \`${request.requestedHead}\` ya no coincide con el HEAD actual \`${ctx.headSha}\`.\n\n_Publicad una nueva acción requerida con el SHA actual; no se ha revisado un diff distinto del solicitado._`
      );
      console.log(
        `[${new Date().toISOString()}] Revisión omitida por HEAD desactualizado en PR #${request.prNumber}.`
      );
      return;
    }

    const verdict = await reviewPR(ctx, "SEGUNDA_REVISION");
    const body = `${config.slack.agentLabel} — REVISIÓN\n\nPR #${ctx.number}: ${ctx.title}\nHEAD revisado: \`${ctx.headSha}\`\n\n${verdict}\n\n_No se ha implementado, fusionado ni desplegado nada. Turno de vuelta a GPT/Claude._`;

    await postToChannel(body);
    console.log(`[${new Date().toISOString()}] Veredicto publicado en Slack para PR #${request.prNumber}.`);
  } finally {
    inFlightReviews.delete(reviewKey);
  }
}

async function tick(): Promise<void> {
  const messages = await readRecentHistory();
  const pending = findPendingHandoff(messages, config.slack.agentLabel);

  if (!pending) {
    console.log(`[${new Date().toISOString()}] Sin handoffs pendientes para ${config.slack.agentLabel}.`);
    return;
  }

  await processReviewRequest(pending);
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

  // Slack necesita el 2xx antes de tres segundos. La revisión lenta continúa
  // fuera del ciclo HTTP y Slack reintentará si el servicio gratuito estaba dormido.
  sendJson(res, 200, { ok: true });

  if (envelope.event_id && !rememberEvent(envelope.event_id)) return;
  const request = extractReviewRequest(
    envelope,
    config.slack.channelId,
    config.slack.agentLabel
  );
  if (!request) return;

  setImmediate(() => {
    processReviewRequest(request).catch((err) =>
      console.error("Error procesando el evento de Slack:", err)
    );
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
        res.end(`fornexa-ai-reviewer: vivo, modo ${mode}.\n`);
        return;
      }

      if (req.method === "POST" && pathname === "/slack/events") {
        handleSlackEvents(req, res).catch((err) => {
          console.error("Error atendiendo Slack Events:", err);
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

  if (runOnce) {
    await tick();
    return;
  }

  startHttpServer();

  // El ciclo inicial permite que un reintento de Slack despierte el Web Service
  // aunque el primer POST quede absorbido por el arranque en frío de Render.
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
