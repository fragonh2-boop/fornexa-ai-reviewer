import { ReadEvidenceError } from "./read-evidence.js";
import { acquireLock, ownsLock, releaseLock } from "./reliability.js";
import { isCannotReplyToMessageError } from "./slack-errors.js";
import { isRepositoryAllowed, normalizeRepository, type ReviewRequest } from "./review-request.js";
import type { PRContext, RefContext } from "./tools/github.js";

const PUBLIC_READ_EVIDENCE_CODES = new Set<string>([
  "MISSING_READ", "READ_FAILED", "CONTENT_DISCREPANCY",
  "CROSS_REQUEST_CONTAMINATION", "BUDGET_EXCEEDED",
]);

export interface ReviewDelivery {
  requestTs: string;
  threadTs: string;
}

export interface ReviewProcessorDependencies {
  agentLabel: string;
  staleLockMs: number;
  locks?: Map<string, number>;
  now?: () => number;
  logger?: Pick<Console, "log" | "warn" | "error">;
  getPRContext: (prNumber: number, repo: string) => Promise<PRContext>;
  getRefContext: (ref: string, repo: string) => Promise<RefContext>;
  reviewPR: (ctx: PRContext, instructions: string) => Promise<string>;
  reviewRepository: (ctx: RefContext, instructions: string) => Promise<string>;
  postToChannel: (text: string) => Promise<unknown>;
  postToThread: (text: string, threadTs: string) => Promise<void>;
}

/** The production request path, without boot/config effects; only I/O is injected. */
export function createReviewProcessor(deps: ReviewProcessorDependencies) {
  const locks = deps.locks ?? new Map<string, number>();
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? console;

  async function postReviewUpdate(text: string, delivery?: ReviewDelivery): Promise<void> {
    const [firstLine, ...rest] = text.split("\n");
    const correlated = delivery
      ? [firstLine, `SLACK_REQUEST_TS: ${delivery.requestTs}`, ...rest].join("\n")
      : text;
    if (!delivery) {
      await deps.postToChannel(correlated);
      return;
    }
    try {
      await deps.postToThread(correlated, delivery.threadTs);
    } catch (error) {
      if (!isCannotReplyToMessageError(error)) throw error;
      await deps.postToChannel(
        `${correlated}\n\nTHREAD_TS: ${delivery.threadTs}\n_Respuesta publicada en el canal porque Slack no admite respuestas en ese mensaje._`
      );
    }
  }

  async function notifyFailure(scope: string, delivery?: ReviewDelivery): Promise<void> {
    try {
      await postReviewUpdate(
        `${deps.agentLabel} — REVISIÓN FALLIDA\n\n${scope}\n\n_El candado se liberará para permitir un reintento seguro._`,
        delivery
      );
    } catch {
      // Do not copy arbitrary provider/Slack payloads to public messages or logs.
      logger.error("No se pudo publicar el aviso de fallo en Slack.");
    }
  }

  async function processReviewRequest(request: ReviewRequest, delivery?: ReviewDelivery): Promise<void> {
    const repo = normalizeRepository(request.repository);
    const targetLabel = request.target === "pr" ? `pr:${repo}:${request.prNumber}` : `ref:${repo}:${request.ref}`;
    const reviewKey = `${targetLabel}:${request.requestedHead}`;
    const lock = acquireLock(locks, reviewKey, deps.staleLockMs, now());
    if (!lock.acquired) {
      logger.log("Revisión ya en curso; se omite la entrega concurrente.");
      return;
    }
    if (lock.recoveredStaleLock) logger.warn("Se recuperó un candado de revisión caducado.");

    try {
      if (!isRepositoryAllowed(repo)) {
        const targetScope = request.target === "pr"
          ? `PR #${request.prNumber}: HEAD solicitado \`${request.requestedHead}\``
          : `TARGET: ${request.ref}\nHEAD \`${request.requestedHead}\``;
        await postReviewUpdate(
          `${deps.agentLabel} — REVISIÓN NO INICIADA\n\nRepo: ${repo}\n${targetScope}: repositorio no autorizado.\n\n_Solo se admiten repositorios autorizados en la allowlist cerrada._`, delivery
        );
        return;
      }

      await postReviewUpdate(
        `${deps.agentLabel} — REVISIÓN RECIBIDA\n\n` +
          `Solicitud aceptada para ${repo} (${request.target === "pr" ? `PR #${request.prNumber}` : `TARGET: ${request.ref}`}), HEAD \`${request.requestedHead}\`. ` +
          "Se publicará un resultado terminal en este hilo.", delivery
      );

      if (request.target === "pr") {
        const ctx = await deps.getPRContext(request.prNumber, repo);
        if (ctx.headSha.toLowerCase() !== request.requestedHead) {
          if (!ownsLock(locks, reviewKey, lock.startedAt)) return;
          await postReviewUpdate(
            `${deps.agentLabel} — REVISIÓN NO INICIADA\n\nRepo: ${repo}\n` +
              `PR #${ctx.number}: el HEAD solicitado \`${request.requestedHead}\` ya no coincide con el HEAD actual \`${ctx.headSha}\`.\n\n` +
              "_Publicad una nueva acción requerida con el SHA actual; no se ha revisado un diff distinto del solicitado._", delivery
          );
          return;
        }
        const verdict = await deps.reviewPR(ctx, request.instructions);
        const postReviewCtx = await deps.getPRContext(request.prNumber, repo);
        if (postReviewCtx.headSha !== ctx.headSha) throw new Error("HEAD changed during review");
        if (!ownsLock(locks, reviewKey, lock.startedAt)) return;
        await postReviewUpdate(
          `${deps.agentLabel} — REVISIÓN\n\nRepo: ${repo}\nPR #${ctx.number}: ${ctx.title}\n` +
            `HEAD revisado: \`${ctx.headSha}\`\n\n${verdict}\n\n` +
            "_No se ha implementado, fusionado ni desplegado nada. Turno de vuelta a GPT/Claude._", delivery
        );
        return;
      }

      const ctx = await deps.getRefContext(request.ref, repo);
      if (ctx.headSha.toLowerCase() !== request.requestedHead) {
        if (!ownsLock(locks, reviewKey, lock.startedAt)) return;
        await postReviewUpdate(
          `${deps.agentLabel} — REVISIÓN NO INICIADA\n\nRepo: ${repo}\nTARGET: ${request.ref}\n` +
            `HEAD \`${request.requestedHead}\`: ya no coincide con el HEAD actual \`${ctx.headSha}\`.\n\n` +
            `_Publicad una nueva acción requerida con TARGET: ${request.ref} y el SHA actual; no se ha revisado un estado distinto del solicitado._`, delivery
        );
        return;
      }
      const verdict = await deps.reviewRepository(ctx, request.instructions);
      if (!ownsLock(locks, reviewKey, lock.startedAt)) return;
      await postReviewUpdate(
        `${deps.agentLabel} — REVISIÓN\n\nRepo: ${repo}\nTARGET: ${ctx.ref}\n` +
          `HEAD revisado: \`${ctx.headSha}\`\n\n${verdict}\n\n` +
          "_No se ha implementado, fusionado ni desplegado nada. Turno de vuelta a GPT/Claude._", delivery
      );
    } catch (err) {
      if (ownsLock(locks, reviewKey, lock.startedAt)) {
        // TypeScript unions are not runtime validation of external exceptions.
        const publicCode = err instanceof ReadEvidenceError && PUBLIC_READ_EVIDENCE_CODES.has(err.code)
          ? err.code : "READ_EVIDENCE_ERROR";
        const safeReason = err instanceof ReadEvidenceError
          ? `la revisión del HEAD \`${request.requestedHead}\` falló por falta o discrepancia de evidencia de lectura (${publicCode})`
          : `la revisión del HEAD \`${request.requestedHead}\` falló antes de completarse`;
        const scope = request.target === "pr"
          ? `Repo: ${repo}\nPR #${request.prNumber}: ${safeReason}.`
          : `Repo: ${repo}\nTARGET: ${request.ref}\nHEAD \`${request.requestedHead}\`: ${safeReason}.`;
        await notifyFailure(scope, delivery);
      }
      throw err;
    } finally {
      releaseLock(locks, reviewKey, lock.startedAt);
    }
  }

  return { processReviewRequest, postReviewUpdate, notifyFailure };
}
