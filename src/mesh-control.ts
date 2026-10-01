import { timingSafeEqual } from "node:crypto";

export function isMeshControlAuthorized(
  authorization: string | undefined,
  expectedToken: string | null
): boolean {
  if (!expectedToken || !authorization?.startsWith("Bearer ")) return false;
  const received = Buffer.from(authorization.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** Accepts exactly one JSON field so the control endpoint never transports text or commands. */
export function parseMeshPingTarget(rawBody: string): string | null {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed);
    if (entries.length !== 1 || entries[0][0] !== "to" || typeof entries[0][1] !== "string") {
      return null;
    }
    return entries[0][1].trim() || null;
  } catch {
    return null;
  }
}
