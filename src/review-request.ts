export interface BaseReviewRequest {
  requestedHead: string;
  instructions: string;
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

export function isReviewResponse(
  message: { text: string; botId?: string },
  agentLabel: string
): boolean {
  if (!message.botId) return false;

  const firstLine = message.text.split("\n", 1)[0].trim();
  return (
    firstLine === `${agentLabel} — REVISIÓN` ||
    firstLine === `${agentLabel} — REVISIÓN NO INICIADA` ||
    firstLine === `${agentLabel} — REVISIÓN FALLIDA`
  );
}

export function isReviewResponseForRequest(
  message: { text: string; botId?: string },
  agentLabel: string,
  request: ReviewRequest
): boolean {
  if (!isReviewResponse(message, agentLabel) || !message.text.includes(request.requestedHead)) {
    return false;
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
    target: "pr",
    prNumber: Number(explicitPrMatch[1]),
    requestedHead,
    instructions: text,
  };
}
