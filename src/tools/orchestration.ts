import { config } from "../config.js";
import { getPRContext, getRefContext } from "./github.js";
import { postToChannelSmart, postToThreadSmart } from "./slack.js";

export const CLAUDE_SLACK_USER_ID = process.env.CLAUDE_SLACK_USER_ID?.trim() || "U0C3L9US98D";
export const GPT_SLACK_USER_ID = process.env.GPT_SLACK_USER_ID?.trim() || "U0BTA39J97T";
export const DEEPSEEK_SLACK_USER_ID = process.env.DEEPSEEK_SLACK_USER_ID?.trim() || "U0BV95NCT89";

export interface OrchestrationDependencies {
  getPRContext: typeof getPRContext;
  getRefContext: typeof getRefContext;
  postToChannelSmart: typeof postToChannelSmart;
  postToThreadSmart: typeof postToThreadSmart;
}

const defaultDependencies: OrchestrationDependencies = {
  getPRContext,
  getRefContext,
  postToChannelSmart,
  postToThreadSmart,
};

export interface DeepSeekReviewDispatchParams {
  target: "main" | "pr";
  prNumber?: number;
  instructions?: string;
  repo?: string;
}

export interface DeepSeekReviewDispatchResult {
  ok: boolean;
  target: "main" | "pr";
  prNumber?: number;
  headSha: string;
  repo: string;
  messageText: string;
}

/**
 * Publica una orden formal de revisión para DeepSeek en el canal de Slack
 * resolviendo automáticamente el HEAD SHA exacto desde GitHub.
 */
export async function dispatchDeepSeekReview(
  params: DeepSeekReviewDispatchParams,
  deps: Partial<OrchestrationDependencies> = {}
): Promise<DeepSeekReviewDispatchResult> {
  const target = params.target || "main";
  const repoOwner = config.github.owner;
  const repoName = params.repo || config.github.repo;
  const fullRepo = `${repoOwner}/${repoName}`;

  const fetchPRContext = deps.getPRContext ?? defaultDependencies.getPRContext;
  const fetchRefContext = deps.getRefContext ?? defaultDependencies.getRefContext;
  const channelPublisher = deps.postToChannelSmart ?? defaultDependencies.postToChannelSmart;

  if (target === "pr") {
    if (!params.prNumber || !Number.isInteger(params.prNumber) || params.prNumber <= 0) {
      throw new Error("Se requiere un número de PR válido (prNumber) cuando target es 'pr'.");
    }

    const prCtx = await fetchPRContext(params.prNumber);
    const instructions =
      params.instructions?.trim() ||
      `Revisión solicitada por el orquestador Gemini para PR #${params.prNumber}.`;

    const messageText = [
      "DEEPSEEK — ACCIÓN REQUERIDA",
      "MODE: PR",
      `PR #${params.prNumber}`,
      `HEAD: ${prCtx.headSha}`,
      "",
      instructions,
    ].join("\n");

    await channelPublisher(messageText);

    return {
      ok: true,
      target: "pr",
      prNumber: params.prNumber,
      headSha: prCtx.headSha,
      repo: fullRepo,
      messageText,
    };
  }

  // target === "main"
  const refCtx = await fetchRefContext("main");
  const instructions =
    params.instructions?.trim() ||
    "Revisión de estado de repositorio solicitada por el orquestador Gemini.";

  const messageText = [
    "DEEPSEEK — ACCIÓN REQUERIDA",
    "MODE: MAIN",
    "TARGET: main",
    `Repo: ${fullRepo}`,
    `HEAD: ${refCtx.headSha}`,
    "",
    instructions,
  ].join("\n");

  await channelPublisher(messageText);

  return {
    ok: true,
    target: "main",
    headSha: refCtx.headSha,
    repo: fullRepo,
    messageText,
  };
}

export interface AgentMessageDispatchParams {
  agent: "claude" | "chatgpt";
  message: string;
  threadTs?: string;
}

export interface AgentMessageDispatchResult {
  ok: boolean;
  agent: "claude" | "chatgpt";
  targetUserId: string;
  postedTo: "channel" | "thread";
  messageText: string;
}

/**
 * Envía un mensaje en Slack mencionando a Claude o ChatGPT para solicitar su colaboración.
 */
export async function dispatchAgentMessage(
  params: AgentMessageDispatchParams,
  deps: Partial<OrchestrationDependencies> = {}
): Promise<AgentMessageDispatchResult> {
  const agent = params.agent;
  const prompt = params.message?.trim();
  if (!prompt) {
    throw new Error("El mensaje a enviar no puede estar vacío.");
  }

  let targetUserId: string;
  if (agent === "claude") {
    targetUserId = CLAUDE_SLACK_USER_ID;
  } else if (agent === "chatgpt") {
    targetUserId = GPT_SLACK_USER_ID;
  } else {
    throw new Error(`Agente no soportado: '${agent}'. Debe ser 'claude' o 'chatgpt'.`);
  }

  const messageText = `<@${targetUserId}> ${prompt}`;
  const channelPublisher = deps.postToChannelSmart ?? defaultDependencies.postToChannelSmart;
  const threadPublisher = deps.postToThreadSmart ?? defaultDependencies.postToThreadSmart;

  if (params.threadTs) {
    await threadPublisher(messageText, params.threadTs);
    return {
      ok: true,
      agent,
      targetUserId,
      postedTo: "thread",
      messageText,
    };
  }

  await channelPublisher(messageText);
  return {
    ok: true,
    agent,
    targetUserId,
    postedTo: "channel",
    messageText,
  };
}

export interface RepositoryStatusResult {
  ok: boolean;
  repo: string;
  ref: string;
  headSha: string;
  headMessage: string;
  recentCommits: Array<{ sha: string; message: string }>;
  checks: Array<{ name: string; status: string; conclusion: string | null }>;
}

/**
 * Consulta en GitHub el estado actual de una rama (por defecto 'main').
 */
export async function getRepositoryStatus(
  ref: string = "main",
  deps: Partial<OrchestrationDependencies> = {}
): Promise<RepositoryStatusResult> {
  const targetRef = ref.trim() || "main";
  const fetchRefContext = deps.getRefContext ?? defaultDependencies.getRefContext;
  const refCtx = await fetchRefContext(targetRef);

  return {
    ok: true,
    repo: `${config.github.owner}/${config.github.repo}`,
    ref: refCtx.ref,
    headSha: refCtx.headSha,
    headMessage: refCtx.headMessage,
    recentCommits: refCtx.recentCommits.slice(0, 5),
    checks: refCtx.checks,
  };
}
