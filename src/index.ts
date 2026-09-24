import { supportsLegacyOnboarding } from "./providers.js";
import { createDiagnosticReporter } from "./request-diagnostics.js";
import { processImplementation } from "./implementation-runner.js";
import {
  deployApprovalReady,
  getControlledDeployStatus,
  parseDeployRequest,
  renderDeployApproverAuthorized,
  triggerControlledDeploy,
} from "./controlled-deploy.js";
import {
  getVercelDeployStatus,
  parseVercelDeploy,
  triggerVercelDeploy,
  vercelDeployApprovalReady,
  vercelDeployApproverAuthorized,
} from "./controlled-vercel.js";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { config } from "./config.js";
import {
  readRecentHistory,
  findPendingHandoff,
  postToChannel,
  postToThread,
  postToThreadWithBlocks,
  readThread,
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
import type { ReviewRequest } from "./review-request.js";
import {
  buildContextFromThread,
  contextAuthorKey,
  CONTEXT_MARKER,
  CONTEXT_RESPONSE_MARKER,
  isContextReadyMessage,
  isContextThreadRoot,
} from "./context-onboarding.js";
import { acquireLock, ownsLock, releaseLock } from "./reliability.js";
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
import {
  APPROVAL_ACTION_IDS,
  createDeploymentApprovalToken,
  deploymentApprovalBlocks,
  hashSidecarTask,
  parseSignedApprovalToken,
  parseSlackDeploymentInteraction,
  sidecarApprovalBlocks,
  type DeploymentApproval,
  type SidecarApproval,
} from "./deployment-approval.js";
import { parseDirectSidecarPrompt, sidecarApprovalReady, sidecarApproverAuthorized } from "./local-sidecar-policy.js";

const MAX_REMEMBERED_EVENT_IDS = 1000;
const inFlightReviews = new Map<string, number>();
const inFlightContextThreads = new Map<string, number>();
const inFlightMentions = new Map<string, number>();
const inFlightDeploys = new Set<string>();
const inFlightSidecars = new Set<string>();
const processedEventIds = new Set<string>();
const reportMalformed = createDiagnosticReporter(config.slack.agentLabel, postToThread);
const staleLockMs = config.staleLockMinutes * 60 * 1000;
const APPROVAL_TTL_MS = 2 * 60 * 60 * 1000;

function rememberEvent(eventId: string): boolean {
  if (processedEventIds.has(eventId)) return false;
  processedEventIds.add(eventId);

  if (processedEventIds.size > MAX_REMEMBERED_EVENT_IDS) {
    const oldest = processedEventIds.values().next().value;
    if (oldest) processedEventIds.delete(oldest);
  }

  return true;
}

async function processDeploy(message: { text: string; ts: string; user?: string; botId?: string; threadTs?: string }): Promise<boolean> {
  const request = parseDeployRequest(message, config.slack.agentLabel);
  if (!request) return false;
  const prior = await readThread(request.ts);
  if (prior.some(entry => entry.botId && / — DEPLOY (?:COMPLETADO|FALLIDO|YA LIVE|BLOQUEADO|NO AUTORIZADO)/.test(entry.text))) return false;

  const started = prior.find(entry => entry.botId && entry.text.startsWith(`${config.slack.agentLabel} — DEPLOY INICIADO\n`) &&
    entry.text.includes(`HEAD: ${request.head}\n`));
  const startedId = started ? /^DEPLOY_ID: (dep-[a-z0-9]+)$/m.exec(started.text)?.[1] : undefined;
  if (startedId && process.env.DEPLOY_RENDER_API_KEY) {
    await reportRenderDeployStatus(request.ts, request.head, startedId);
    return false;
  }
  if (prior.some(entry => entry.botId && entry.text.startsWith(`${config.slack.agentLabel} — DEPLOY PENDIENTE DE APROBACIÓN\n`))) return false;

  if (config.model.provider !== 'gemini' || !deployApprovalReady()) {
    // Do not disclose which credential or identity gate failed.
    await postToThread(`${config.slack.agentLabel} — DEPLOY NO AUTORIZADO\nLa capacidad de despliegue no está activa para esta identidad.`, request.ts);
    return true;
  }
  const approval: DeploymentApproval = { mode: 'render', head: request.head, threadTs: request.ts, expiresAt: Date.now() + APPROVAL_TTL_MS };
  const token = createDeploymentApprovalToken(approval, process.env.APPROVAL_HMAC_SECRET!);
  const text = `${config.slack.agentLabel} — DEPLOY PENDIENTE DE APROBACIÓN\n` +
    `TARGET: fornexa-ai-reviewer-gemini\nHEAD: ${request.head}\n` +
    `Una persona autorizada debe confirmar en Slack. La aprobación caduca en dos horas.`;
  await postToThreadWithBlocks(text, deploymentApprovalBlocks({ mode: 'render', token, target: 'fornexa-ai-reviewer-gemini', head: request.head }), request.ts);
  return true;
}

async function processVercelDeploy(message: { text: string; ts: string; user?: string; botId?: string; threadTs?: string }): Promise<boolean> {
  const request = parseVercelDeploy(message, config.slack.agentLabel);
  if (!request) return false;
  const prior = await readThread(request.ts);
  if (prior.some(entry => entry.botId && / — VERCEL (?:COMPLETADO|FALLIDO|YA READY|DEPLOY BLOQUEADO|NO AUTORIZADO)/.test(entry.text))) return false;

  const started = prior.find(entry => entry.botId && entry.text.startsWith(`${config.slack.agentLabel} — VERCEL DEPLOY INICIADO\n`) &&
    entry.text.includes(`HEAD: ${request.head}\n`));
  const startedId = started ? /^DEPLOY_ID: (dpl_[a-zA-Z0-9]+)$/m.exec(started.text)?.[1] : undefined;
  if (startedId && process.env.VERCEL_DEPLOY_API_TOKEN) {
    await reportVercelDeployStatus(request.ts, request.head, startedId);
    return false;
  }
  if (prior.some(entry => entry.botId && entry.text.startsWith(`${config.slack.agentLabel} — VERCEL PENDIENTE DE APROBACIÓN\n`))) return false;

  if (config.model.provider !== 'gemini' || !vercelDeployApprovalReady()) {
    await postToThread(`${config.slack.agentLabel} — VERCEL NO AUTORIZADO\nLa capacidad no está activa para esta identidad.`, request.ts);
    return true;
  }
  const approval: DeploymentApproval = { mode: 'vercel', head: request.head, threadTs: request.ts, expiresAt: Date.now() + APPROVAL_TTL_MS };
  const token = createDeploymentApprovalToken(approval, process.env.APPROVAL_HMAC_SECRET!);
  const text = `${config.slack.agentLabel} — VERCEL PENDIENTE DE APROBACIÓN\n` +
    `TARGET: fornexa\nHEAD: ${request.head}\n` +
    `Una persona autorizada debe confirmar en Slack. La aprobación caduca en dos horas.`;
  await postToThreadWithBlocks(text, deploymentApprovalBlocks({ mode: 'vercel', token, target: 'fornexa', head: request.head }), request.ts);
  return true;
}

async function reportRenderDeployStatus(threadTs: string, head: string, deployId: string): Promise<'pending' | 'terminal'> {
  try {
    const status = await getControlledDeployStatus({
      head,
      deployId,
      renderApiKey: process.env.DEPLOY_RENDER_API_KEY!,
    });
    if (status === 'pending') return 'pending';
    await postToThread(`${config.slack.agentLabel} — DEPLOY ${status === 'live' ? 'COMPLETADO' : 'FALLIDO'}\n` +
      `TARGET: fornexa-ai-reviewer-gemini\nHEAD: ${head}\nDEPLOY_ID: ${deployId}\n` +
      `${status === 'live' ? 'Render confirma estado Live para el commit aprobado.' : 'Render confirma un estado terminal fallido; no se declara desplegado.'}`,
      threadTs);
    return 'terminal';
  } catch {
    return 'pending';
  }
}

async function reportVercelDeployStatus(threadTs: string, head: string, deploymentId: string): Promise<'pending' | 'terminal'> {
  try {
    const status = await getVercelDeployStatus({
      head,
      deploymentId,
      vercelToken: process.env.VERCEL_DEPLOY_API_TOKEN!,
    });
    if (status === 'pending') return 'pending';
    await postToThread(`${config.slack.agentLabel} — VERCEL ${status === 'ready' ? 'COMPLETADO' : 'FALLIDO'}\n` +
      `TARGET: fornexa\nHEAD: ${head}\nDEPLOY_ID: ${deploymentId}\n` +
      `${status === 'ready' ? 'Vercel confirma READY para el commit aprobado.' : 'Vercel confirma un estado terminal fallido; no se declara desplegado.'}`,
      threadTs);
    return 'terminal';
  } catch {
    return 'pending';
  }
}

async function monitorDeployment(mode: 'render' | 'vercel', threadTs: string, head: string, deploymentId: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10_000));
    const result = mode === 'render'
      ? await reportRenderDeployStatus(threadTs, head, deploymentId)
      : await reportVercelDeployStatus(threadTs, head, deploymentId);
    if (result === 'terminal') return;
  }
}

async function processDeploymentApproval(params: {
  userId: string;
  actionId: string;
  approval: DeploymentApproval;
}): Promise<void> {
  const { approval, userId, actionId } = params;
  if (actionId !== APPROVAL_ACTION_IDS[approval.mode]) return;
  const key = `${approval.mode}:${approval.threadTs}`;
  if (inFlightDeploys.has(key)) return;

  const thread = await readThread(approval.threadTs);
  const root = thread.find(message => message.ts === approval.threadTs);
  if (!root || !thread.some(message => message.botId &&
      message.text.includes('PENDIENTE DE APROBACIÓN') && message.text.includes(`HEAD: ${approval.head}`))) return;
  if (thread.some(message => message.botId && / — (?:DEPLOY|VERCEL) (?:COMPLETADO|FALLIDO|YA LIVE|YA READY)/.test(message.text))) return;

  const started = thread.find(message => message.botId && message.text.includes(`HEAD: ${approval.head}\n`) &&
    (approval.mode === 'render'
      ? message.text.startsWith(`${config.slack.agentLabel} — DEPLOY INICIADO\n`)
      : message.text.startsWith(`${config.slack.agentLabel} — VERCEL DEPLOY INICIADO\n`)));
  const startedId = started
    ? (approval.mode === 'render'
      ? /^DEPLOY_ID: (dep-[a-z0-9]+)$/m.exec(started.text)?.[1]
      : /^DEPLOY_ID: (dpl_[a-zA-Z0-9]+)$/m.exec(started.text)?.[1])
    : undefined;
  if (startedId) {
    if (approval.mode === 'render') await reportRenderDeployStatus(approval.threadTs, approval.head, startedId);
    else await reportVercelDeployStatus(approval.threadTs, approval.head, startedId);
    return;
  }

  inFlightDeploys.add(key);
  try {
    if (approval.mode === 'render') {
      const request = parseDeployRequest(root, config.slack.agentLabel);
      if (!request || request.head !== approval.head || !renderDeployApproverAuthorized(userId)) {
        await postToThread(`${config.slack.agentLabel} — APROBACIÓN RECHAZADA\nLa identidad o el contexto de la aprobación no está autorizado.`, approval.threadTs);
        return;
      }
      const result = await triggerControlledDeploy({
        head: approval.head,
        githubToken: process.env.DEPLOY_GITHUB_TOKEN!,
        renderApiKey: process.env.DEPLOY_RENDER_API_KEY!,
      });
      if (result.status === 'already_live') {
        await postToThread(`${config.slack.agentLabel} — DEPLOY YA LIVE\nTARGET: fornexa-ai-reviewer-gemini\nHEAD: ${approval.head}\nDEPLOY_ID: ${result.deployId}\nAprobación verificada en Slack; Render ya servía el commit exacto.`, approval.threadTs);
        return;
      }
      await postToThread(`${config.slack.agentLabel} — DEPLOY INICIADO\nTARGET: fornexa-ai-reviewer-gemini\nHEAD: ${approval.head}\nDEPLOY_ID: ${result.deployId}\nAprobado por <@${userId}>. Se verificará el estado terminal incluso después de un reinicio.`, approval.threadTs);
      void monitorDeployment('render', approval.threadTs, approval.head, result.deployId);
      return;
    }

    const request = parseVercelDeploy(root, config.slack.agentLabel);
    if (!request || request.head !== approval.head || !vercelDeployApproverAuthorized(userId)) {
      await postToThread(`${config.slack.agentLabel} — APROBACIÓN RECHAZADA\nLa identidad o el contexto de la aprobación no está autorizado.`, approval.threadTs);
      return;
    }
    const result = await triggerVercelDeploy({
      head: approval.head,
      githubToken: process.env.VERCEL_DEPLOY_GITHUB_TOKEN!,
      vercelToken: process.env.VERCEL_DEPLOY_API_TOKEN!,
    });
    if (result.status === 'already_ready') {
      await postToThread(`${config.slack.agentLabel} — VERCEL YA READY\nTARGET: fornexa\nHEAD: ${approval.head}\nDEPLOY_ID: ${result.deploymentId}\nAprobación verificada en Slack; Vercel ya servía el commit exacto.`, approval.threadTs);
      return;
    }
    await postToThread(`${config.slack.agentLabel} — VERCEL DEPLOY INICIADO\nTARGET: fornexa\nHEAD: ${approval.head}\nDEPLOY_ID: ${result.deploymentId}\nAprobado por <@${userId}>. Se verificará el estado terminal de forma recuperable.`, approval.threadTs);
    void monitorDeployment('vercel', approval.threadTs, approval.head, result.deploymentId);
  } catch (error) {
    const reason = (error as Error).message;
    const allowed = /^(main HEAD differs|main changed|Required validate check|Check list may|Render service identity|A deployment is already in progress|Fornexa main HEAD differs|Fornexa main changed|Fornexa CI validate|Vercel project identity|A Vercel deployment is already in progress)/.test(reason);
    const prefix = approval.mode === 'render' ? 'DEPLOY BLOQUEADO' : 'VERCEL DEPLOY BLOQUEADO';
    await postToThread(`${config.slack.agentLabel} — ${prefix}\n${allowed ? reason : 'La comprobación o la API falló; consultar los registros del servicio.'}`, approval.threadTs);
  } finally {
    inFlightDeploys.delete(key);
  }
}

async function processSidecarApproval(params: {
  userId: string;
  actionId: string;
  approval: SidecarApproval;
}): Promise<void> {
  const { approval, userId, actionId } = params;
  if (actionId !== APPROVAL_ACTION_IDS.sidecar) return;
  if (!sidecarApproverAuthorized(userId)) {
    await postToThread(
      `${config.slack.agentLabel} — SIDECAR APROBACIÓN RECHAZADA\n` +
      `SLACK_REQUEST_TS: ${approval.requestTs}\nLa identidad de la aprobación no está autorizada.`,
      approval.threadTs
    );
    return;
  }
  const key = `sidecar:${approval.requestTs}`;
  if (inFlightSidecars.has(key)) return;

  const thread = await readThread(approval.threadTs);
  if (thread.some(message => message.botId &&
      message.text.startsWith(`${config.slack.agentLabel} — SIDECAR RESULTADO\n`) &&
      message.text.includes(`SLACK_REQUEST_TS: ${approval.requestTs}`))) return;
  const root = thread.find(message => message.ts === approval.threadTs);
  const request = thread.find(message => message.ts === approval.requestTs);
  if (!root || !request || request.botId || !request.user ||
      !containsBotMention(root.text, config.slack.mentions.botUserId ?? "") ||
      (request.ts !== approval.threadTs && request.threadTs !== approval.threadTs) ||
      !thread.some(message => message.botId &&
        message.text.includes(`SLACK_REQUEST_TS: ${approval.requestTs}`) &&
        message.text.includes("SIDECAR PENDIENTE DE APROBACIÓN"))) return;
  const parsed = parseMentionPrompt(request.text, config.slack.mentions.botUserId ?? "");
  const task = parsed.ok ? parseDirectSidecarPrompt(parsed.prompt) : null;
  if (!task || hashSidecarTask(task) !== approval.taskHash) return;

  inFlightSidecars.add(key);
  try {
    const result = await sidecarManager.dispatchTask(task);
    await postToThread(
      `${config.slack.agentLabel} — SIDECAR RESULTADO\n` +
      `SLACK_REQUEST_TS: ${approval.requestTs}\nAPROBADO_POR: <@${userId}>\n\n${result}`,
      approval.threadTs
    );
  } catch {
    await postToThread(
      `${config.slack.agentLabel} — SIDECAR FALLIDO\n` +
      `SLACK_REQUEST_TS: ${approval.requestTs}\nLa operación local aprobada no pudo completarse.`,
      approval.threadTs
    );
  } finally {
    inFlightSidecars.delete(key);
  }
}

async function processReviewRequest(request: ReviewRequest): Promise<void> {
  const targetLabel = request.target === "pr" ? `pr:${request.prNumber}` : `ref:${request.ref}`;
  const reviewKey = `${targetLabel}:${request.requestedHead}`;
  const lock = acquireLock(inFlightReviews, reviewKey, staleLockMs);
  if (!lock.acquired) {
    console.log(`[${new Date().toISOString()}] Revisión ${reviewKey} ya está en curso; se omite.`);
    return;
  }
  if (lock.recoveredStaleLock) {
    console.warn(
      `[${new Date().toISOString()}] Revisión ${reviewKey} atascada durante más de ${config.staleLockMinutes} minuto(s); se reintenta.`
    );
  }

  try {
    if (request.target === "pr") {
      console.log(
        `[${new Date().toISOString()}] Handoff detectado: PR #${request.prNumber}, HEAD ${request.requestedHead}. Revisando...`
      );

      const ctx = await getPRContext(request.prNumber);
      if (ctx.headSha.toLowerCase() !== request.requestedHead) {
        if (!ownsLock(inFlightReviews, reviewKey, lock.startedAt)) return;
        await postToChannel(
          `${config.slack.agentLabel} — REVISIÓN NO INICIADA\n\nPR #${ctx.number}: el HEAD solicitado \`${request.requestedHead}\` ya no coincide con el HEAD actual \`${ctx.headSha}\`.\n\n_Publicad una nueva acción requerida con el SHA actual; no se ha revisado un diff distinto del solicitado._`
        );
        console.log(
          `[${new Date().toISOString()}] Revisión omitida por HEAD desactualizado en PR #${request.prNumber}.`
        );
        return;
      }

      const verdict = await reviewPR(ctx, "SEGUNDA_REVISION", undefined, request.instructions);
      if ((await getPRContext(request.prNumber)).headSha !== ctx.headSha) throw new Error('HEAD changed during review');
      const body = `${config.slack.agentLabel} — REVISIÓN\n\nPR #${ctx.number}: ${ctx.title}\nHEAD revisado: \`${ctx.headSha}\`\n\n${verdict}\n\n_No se ha implementado, fusionado ni desplegado nada. Turno de vuelta a GPT/Claude._`;

      if (!ownsLock(inFlightReviews, reviewKey, lock.startedAt)) return;
      await postToChannel(body);
      console.log(`[${new Date().toISOString()}] Veredicto publicado en Slack para PR #${request.prNumber}.`);
      return;
    }

    console.log(
      `[${new Date().toISOString()}] Handoff detectado: TARGET ${request.ref}, HEAD ${request.requestedHead}. Revisando estado del repositorio...`
    );

    const ctx = await getRefContext(request.ref);
    if (ctx.headSha.toLowerCase() !== request.requestedHead) {
      if (!ownsLock(inFlightReviews, reviewKey, lock.startedAt)) return;
      await postToChannel(
        `${config.slack.agentLabel} — REVISIÓN NO INICIADA\n\nTARGET: ${request.ref}\nHEAD \`${request.requestedHead}\`: ya no coincide con el HEAD actual \`${ctx.headSha}\`.\n\n_Publicad una nueva acción requerida con TARGET: ${request.ref} y el SHA actual; no se ha revisado un estado distinto del solicitado._`
      );
      console.log(
        `[${new Date().toISOString()}] Revisión omitida por HEAD desactualizado en TARGET ${request.ref}.`
      );
      return;
    }

    const verdict = await reviewRepository(ctx, request.instructions);
    const body = `${config.slack.agentLabel} — REVISIÓN\n\nTARGET: ${ctx.ref}\nHEAD revisado: \`${ctx.headSha}\`\n\n${verdict}\n\n_No se ha implementado, fusionado ni desplegado nada. Turno de vuelta a GPT/Claude._`;
    if (!ownsLock(inFlightReviews, reviewKey, lock.startedAt)) return;
    await postToChannel(body);
    console.log(`[${new Date().toISOString()}] Revisión de estado publicada para TARGET ${ctx.ref}.`);
  } catch (err) {
    if (ownsLock(inFlightReviews, reviewKey, lock.startedAt)) {
      const scope =
        request.target === "pr"
          ? `PR #${request.prNumber}: la revisión del HEAD \`${request.requestedHead}\` falló antes de completarse.`
          : `TARGET: ${request.ref}\nHEAD \`${request.requestedHead}\`: la revisión falló antes de completarse.`;
      await notifyFailure(scope);
    }
    throw err;
  } finally {
    releaseLock(inFlightReviews, reviewKey, lock.startedAt);
  }
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
    const directSidecarTask = parseDirectSidecarPrompt(turn.prompt);
    if (directSidecarTask) {
      if (!sidecarApprovalReady()) {
        await postToThread(
          formatMentionResponse(config.slack.agentLabel, turn.ts,
            "El puente local requiere aprobación humana interactiva y no está activado para esta identidad."),
          turn.threadTs
        );
        return true;
      }
      const approval: SidecarApproval = {
        mode: "sidecar",
        threadTs: turn.threadTs,
        requestTs: turn.ts,
        taskHash: hashSidecarTask(directSidecarTask),
        expiresAt: Date.now() + APPROVAL_TTL_MS,
      };
      const token = createDeploymentApprovalToken(approval, process.env.APPROVAL_HMAC_SECRET!);
      const text = formatMentionResponse(
        config.slack.agentLabel,
        turn.ts,
        "SIDECAR PENDIENTE DE APROBACIÓN\nUna persona autorizada debe confirmar la operación local en Slack. La aprobación caduca en dos horas."
      );
      await postToThreadWithBlocks(
        text,
        sidecarApprovalBlocks({ token, task: directSidecarTask }),
        turn.threadTs
      );
      return true;
    }
    const conversation = buildMentionConversation({
      messages: latest,
      turn,
      botUserId: config.slack.mentions.botUserId,
      agentLabel: config.slack.agentLabel,
    });
    const response = await answerSlackConversation(conversation);
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
      await postToThread(
        formatMentionFailure(
          config.slack.agentLabel,
          turn.ts,
          "No se ha podido completar la consulta. Vuelve a mencionar al bot para reintentarlo."
        ),
        turn.threadTs
      );
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
      botUserId: config.slack.mentions.botUserId,
      agentLabel: config.slack.agentLabel,
    });
    if (turn) return { turn, thread };
  }
  return null;
}

async function notifyFailure(scope: string): Promise<void> {
  try {
    await postToChannel(
      `${config.slack.agentLabel} — REVISIÓN FALLIDA\n\n${scope}\n\n_El detalle técnico se conserva en el log del servicio. El candado se liberará para permitir un reintento seguro._`
    );
  } catch (notificationError) {
    console.error("No se pudo publicar el aviso de fallo en Slack:", notificationError);
  }
}

async function findPendingContextThread(messages: SlackMessage[]): Promise<{
  threadTs: string;
} | null> {
  if (!supportsLegacyOnboarding(config.model.provider)) return null;
  const roots = messages.filter(
    (message) =>
      message.text.startsWith(CONTEXT_MARKER) &&
      isContextThreadRoot(message) &&
      contextAuthorKey(message) !== null
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
  for (const message of messages) {
    if (await processVercelDeploy(message)) break;
    if (await processDeploy(message)) break;
    // Historical terminal/pending deploy requests are recognized but must not
    // starve newer work or fall through to the malformed-handoff diagnostic.
    if (parseVercelDeploy(message, config.slack.agentLabel) ||
        parseDeployRequest(message, config.slack.agentLabel)) continue;
    if (await reportMalformed(message)) continue;
    if (await processImplementation(message)) break;
  }
  const pending = findPendingHandoff(messages, config.slack.agentLabel);

  if (pending) {
    await processReviewRequest(pending);
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

  sendJson(res, 200, { ok: true });

  if (envelope.event_id && !rememberEvent(envelope.event_id)) return;
  const humanMessage = extractHumanMessage(envelope, config.slack.channelId);
  if (humanMessage && /^MODE:\s*DEPLOY_VERCEL\s*$/m.test(humanMessage.text)) {
    setImmediate(() => { processVercelDeploy(humanMessage).catch(() => console.error('Vercel deploy handling failed')); });
    return;
  }
  if (humanMessage && /^MODE:\s*DEPLOY\s*$/m.test(humanMessage.text)) {
    setImmediate(() => { processDeploy(humanMessage).catch(() => console.error('Controlled deploy handling failed')); });
    return;
  }
  if (humanMessage && await reportMalformed(humanMessage)) return;
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
    config.slack.agentLabel
  );
  if (request) {
    setImmediate(() => {
      processReviewRequest(request).catch((err) =>
        console.error("Error procesando el evento de Slack:", err)
      );
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

async function handleSlackInteractions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!config.slack.signingSecret) {
    sendJson(res, 503, { ok: false, error: "slack_interactions_not_configured" });
    return;
  }

  let rawBody: string;
  try {
    rawBody = await readRawBody(req);
  } catch {
    sendJson(res, 413, { ok: false, error: "request_too_large" });
    return;
  }
  if (!verifySlackSignature({
    rawBody,
    timestamp: req.headers["x-slack-request-timestamp"] as string | undefined,
    signature: req.headers["x-slack-signature"] as string | undefined,
    signingSecret: config.slack.signingSecret,
  })) {
    sendJson(res, 401, { ok: false, error: "invalid_signature" });
    return;
  }

  const interaction = parseSlackDeploymentInteraction(rawBody);
  if (!interaction || interaction.channelId !== config.slack.channelId) {
    sendJson(res, 400, { ok: false, error: "invalid_interaction" });
    return;
  }
  const approvalSecret = process.env.APPROVAL_HMAC_SECRET?.trim();
  if (!approvalSecret) {
    sendJson(res, 503, { ok: false, error: "approval_signing_not_configured" });
    return;
  }
  const approval = parseSignedApprovalToken(interaction.token, approvalSecret);
  if (!approval || interaction.actionId !== APPROVAL_ACTION_IDS[approval.mode]) {
    sendJson(res, 400, { ok: false, error: "invalid_or_expired_approval" });
    return;
  }

  sendJson(res, 200, { ok: true });
  setImmediate(() => {
    const work = approval.mode === "sidecar"
      ? processSidecarApproval({ userId: interaction.userId, actionId: interaction.actionId, approval })
      : processDeploymentApproval({ userId: interaction.userId, actionId: interaction.actionId, approval });
    work.catch(() => console.error('Signed approval handling failed'));
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

      if (req.method === "POST" && pathname === "/slack/interactions") {
        handleSlackInteractions(req, res).catch((err) => {
          console.error("Error atendiendo Slack Interactions:", err);
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: "internal_error" });
        });
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
