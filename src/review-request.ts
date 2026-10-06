export const ALLOWED_REPOSITORIES = [
  "fragonh2-boop/fornexa-ai-reviewer",
  "fragonh2-boop/Fornexa",
] as const;

export type AllowedRepository = (typeof ALLOWED_REPOSITORIES)[number];

export const DEFAULT_REPOSITORY: AllowedRepository = "fragonh2-boop/Fornexa";

export function normalizeRepository(repoStr: string): string {
  const trimmed = repoStr.trim();
  const parts = trimmed.split("/");
  if (parts.length !== 2) return trimmed;
  const [owner, name] = parts;
  for (const allowed of ALLOWED_REPOSITORIES) {
    if (allowed.toLowerCase() === `${owner}/${name}`.toLowerCase()) {
      return allowed;
    }
  }
  return `${owner}/${name}`;
}

export function isRepositoryAllowed(repo: string): repo is AllowedRepository {
  const normalized = normalizeRepository(repo);
  return (ALLOWED_REPOSITORIES as readonly string[]).includes(normalized);
}

export interface BaseReviewRequest {
  repository: string;
  requestedHead: string;
  instructions: string;
  rawRepository?: string;
}

export interface PRReviewRequest extends BaseReviewRequest {
  target: "pr";
  prNumber: number;
}

export interface RefReviewRequest extends BaseReviewRequest {
  target: "ref";
  ref: string;
}

export type ReviewRequest = PRReviewRequest | RefReviewRequest;

function reviewPart(text: string): { index: number; total: number; body: string } | null {
  const match = text.match(/\n\n_Respuesta ([^\n]*)_\s*$/);
  if (!match) return null;
  const numbers = match[1].match(/^(\d+)\/(\d+)$/);
  const index = Number(numbers?.[1]);
  const total = Number(numbers?.[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index < 1 || total < 1 || index > total) {
    return { index: 0, total: 0, body: text };
  }
  return { index, total, body: text.slice(0, match.index) };
}

export function isReviewResponse(
  message: { text: string; botId?: string },
  agentLabel: string
): boolean {
  if (!message.botId) return false;
  const part = reviewPart(message.text);
  if (part && (part.index === 0 || part.index !== part.total)) return false;

  const firstLine = message.text.split("\n", 1)[0].trim();
  return (
    firstLine === `${agentLabel} — REVISIÓN` ||
    firstLine === `${agentLabel} — REVISIÓN NO INICIADA` ||
    firstLine === `${agentLabel} — REVISIÓN FALLIDA`
  );
}

/**
 * New parts close only on their correlated final message. Complete legacy
 * 1..N groups are still recognized so a rollout does not replay old reviews;
 * a missing, mixed-author or out-of-order legacy part never closes the root.
 */
export function isReviewThreadComplete(
  messages: Array<{ ts: string; text: string; botId?: string; threadTs?: string }>,
  agentLabel: string,
  request: ReviewRequest,
  requestTs: string
): boolean {
  const replies = messages
    .filter((message) => message.ts !== requestTs && message.threadTs === requestTs)
    .sort((left, right) => Number(left.ts) - Number(right.ts));
  if (replies.some((message) => isReviewResponseForRequest(message, agentLabel, request, requestTs))) {
    return true;
  }

  for (const [offset, first] of replies.entries()) {
    const part = reviewPart(first.text);
    if (!part || part.index !== 1 || part.total < 2 || part.total > replies.length - offset) continue;
    if (!isReviewResponseForRequest({ ...first, text: part.body }, agentLabel, request, requestTs)) continue;
    const group = replies.slice(offset)
      .filter((message) => message.botId === first.botId && reviewPart(message.text))
      .slice(0, part.total);
    if (group.length !== part.total) continue;
    const complete = group.every((message, index) => {
      const current = reviewPart(message.text);
      if (message.botId !== first.botId || current?.index !== index + 1 || current.total !== part.total) return false;
      // Modern headers, if present, must still belong to this exact request.
      const hasHeader = /^[A-Z][A-Z0-9_-]* — REVISIÓN/.test(message.text);
      return !hasHeader || isReviewResponseForRequest({ ...message, text: current.body }, agentLabel, request, requestTs);
    });
    if (complete) return true;
  }
  return false;
}

export function isReviewResponseForRequest(
  message: { text: string; botId?: string },
  agentLabel: string,
  request: ReviewRequest,
  requestTs?: string
): boolean {
  if (!isReviewResponse(message, agentLabel) || !message.text.includes(request.requestedHead)) {
    return false;
  }

  if (requestTs && message.text.split("\n")[1] !== `SLACK_REQUEST_TS: ${requestTs}`) return false;

  const repoMatch = message.text.match(/^\s*Repo(?:sitory)?\s*:\s*`?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)`?\s*$/im);
  if (repoMatch) {
    const responseRepo = normalizeRepository(repoMatch[1]);
    if (responseRepo !== normalizeRepository(request.repository)) {
      return false;
    }
  }

  return request.target === "pr"
    ? message.text.includes(`PR #${request.prNumber}:`)
    : message.text.includes(`TARGET: ${request.ref}`);
}

export function parseReviewRequest(text: string, agentLabel: string): ReviewRequest | null {
  const requestMarker = `${agentLabel} — ACCIÓN REQUERIDA`;
  if (!text.split("\n")[0].includes(requestMarker)) return null;

  if (/^\s*MODE\s*:\s*IMPLEMENT\s*$/im.test(text)) return null;
  const headMatch = text.match(/HEAD(?:\s+exacto)?\s*:\s*`?([0-9a-f]{40})`?\s*$/im);
  if (!headMatch) return null;

  const repoMatch = text.match(/^\s*Repo(?:sitory)?\s*:\s*`?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)`?\s*$/im);
  const rawRepository = repoMatch ? repoMatch[1].trim() : undefined;
  const repository = rawRepository ? normalizeRepository(rawRepository) : DEFAULT_REPOSITORY;

  const requestedHead = headMatch[1].toLowerCase();
  const targetMatch = text.match(/^\s*(?:TARGET|BRANCH)\s*:\s*`?([A-Za-z0-9._\/-]+)`?\s*$/im);
  const modeMatch = text.match(/^\s*MODE\s*:\s*(MAIN|PR)\s*$/im);
  const explicitPrMatch = text.match(/^\s*PR\s*#(\d+)\s*$/im);

  // Las revisiones de repositorio deben ser explícitas. TARGET/BRANCH main o
  // MODE: MAIN ganan sobre cualquier referencia narrativa a una PR histórica.
  // Así "post-PR #61" nunca convierte una revisión global en una revisión PR.
  if (targetMatch || modeMatch?.[1].toUpperCase() === "MAIN") {
    const ref = (targetMatch?.[1] ?? "main").toLowerCase();
    if (ref !== "main") return null;
    return {
      repository,
      rawRepository,
      target: "ref",
      ref,
      requestedHead,
      instructions: text,
    };
  }

  // MODE: PR exige además una línea PR #<n>. Sin MODE se mantiene la
  // compatibilidad histórica de PRs siempre que la línea PR sea autónoma.
  if (modeMatch?.[1].toUpperCase() === "PR" && !explicitPrMatch) return null;
  if (!explicitPrMatch) return null;

  return {
    repository,
    rawRepository,
    target: "pr",
    prNumber: Number(explicitPrMatch[1]),
    requestedHead,
    instructions: text,
  };
}
