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
  return Boolean(message.botId) && message.text.startsWith(`${agentLabel} — REVISIÓN`);
}

export function formatReviewAck(request: ReviewRequest, agentLabel: string): string {
  if (request.target === "pr") {
    return `${agentLabel} — SOLICITUD ACEPTADA\n\nModo: PR\nObjetivo: PR #${request.prNumber}\nSHA solicitado: \`${request.requestedHead}\`\n\n_Validando HEAD antes de iniciar la revisión._`;
  }

  return `${agentLabel} — SOLICITUD ACEPTADA\n\nModo: MAIN\nObjetivo: ${request.ref}\nSHA solicitado: \`${request.requestedHead}\`\n\n_Validando HEAD de ${request.ref} antes de iniciar la revisión de repositorio._`;
}

export function parseReviewRequest(text: string, agentLabel: string): ReviewRequest | null {
  const requestMarker = `${agentLabel} — ACCIÓN REQUERIDA`;
  if (!text.includes(requestMarker)) return null;

  const headMatch = text.match(/HEAD(?:\s+exacto)?\s*:\s*`?([0-9a-f]{7,40})`?/i);
  if (!headMatch) return null;

  const requestedHead = headMatch[1].toLowerCase();
  const targetMatch = text.match(/^\s*TARGET\s*:\s*`?([A-Za-z0-9._\/-]+)`?\s*$/im);

  // TARGET explícito gana sobre cualquier mención narrativa a una PR (p. ej.
  // "revisión post-PR #61"). Esto permite revisiones del estado actual de main
  // sin que una referencia histórica se interprete como el objeto a revisar.
  if (targetMatch) {
    const ref = targetMatch[1].toLowerCase();
    if (ref !== "main") return null;
    return {
      target: "ref",
      ref,
      requestedHead,
      instructions: text,
    };
  }

  // Compatibilidad con el protocolo histórico de PRs. La línea debe ser
  // explícita y autónoma para no capturar frases como "post-PR #61".
  const prMatch = text.match(/^\s*PR\s*#(\d+)\s*$/im);
  if (!prMatch) return null;

  return {
    target: "pr",
    prNumber: Number(prMatch[1]),
    requestedHead,
    instructions: text,
  };
}
