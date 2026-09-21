import { createHash } from 'node:crypto';
import { parseReviewRequest } from './review-request.js';
import { parseImplementation } from './implementation.js';
interface Message { text: string; ts: string; user?: string; botId?: string; threadTs?: string }
/** Constant diagnostics: never reflect request contents, which may contain credentials. */
export function malformedHandoff(message: Message, label: string): boolean {
  return Boolean(message.user && !message.botId && (!message.threadTs || message.threadTs === message.ts)
    && message.text.includes(`${label} — ACCIÓN REQUERIDA`)
    && !parseReviewRequest(message.text, label) && !parseImplementation(message.text, label));
}
/** Bounded, duplicate-safe feedback shared by polling/events. Historical traffic is ignored. */
export function createDiagnosticReporter(label: string, send: (text: string, ts: string) => Promise<void>, now = Date.now) {
  const seen = new Set<string>();
  let windowStart = now();
  let count = 0;
  return async (message: Message): Promise<boolean> => {
    if (!malformedHandoff(message, label)) return false;
    const age = now() - Number(message.ts) * 1000;
    if (!Number.isFinite(age) || age < -300_000 || age > 3_600_000) return true;
    const id = createHash('sha256').update(message.ts + '\n' + message.text).digest('hex');
    if (seen.has(id)) return true;
    if (now() - windowStart >= 60_000) { windowStart = now(); count = 0; }
    if (count >= 3) return true;
    seen.add(id); count++;
    if (seen.size > 1000) seen.delete(seen.values().next().value!);
    try {
      await send(`${label} — HANDOFF NO VÁLIDO\nNo se ha iniciado trabajo. Usa el marcador en la primera línea y HEAD de 40 caracteres hexadecimales. Revisión: MODE: PR + PR #N, o MODE: MAIN + TARGET: main. Implementación: MODE: IMPLEMENT + TASK, PATHS y ACCEPTANCE únicos; sin rutas de configuración protegidas. Consulta docs/provider-parity.md.`, message.ts);
    } catch (error) { seen.delete(id); throw error; }
    return true;
  };
}
