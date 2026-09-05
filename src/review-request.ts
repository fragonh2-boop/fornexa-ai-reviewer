export interface ReviewRequest {
  prNumber: number;
  requestedHead: string;
}

export function parseReviewRequest(text: string, agentLabel: string): ReviewRequest | null {
  const requestMarker = `${agentLabel} — ACCIÓN REQUERIDA`;
  if (!text.includes(requestMarker)) return null;

  const prMatch = text.match(/PR\s*#(\d+)/i);
  const headMatch = text.match(/HEAD:\s*`?([0-9a-f]{7,40})`?/i);
  if (!prMatch || !headMatch) return null;

  return {
    prNumber: Number(prMatch[1]),
    requestedHead: headMatch[1].toLowerCase(),
  };
}
