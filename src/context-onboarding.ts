export const CONTEXT_MARKER = "DEEPSEEK — INCORPORACIÓN CONTEXTUAL FORNEXA";
export const CONTEXT_PROCESS_COMMAND = "DEEPSEEK — PROCESAR CONTEXTO FORNEXA";
export const CONTEXT_RESPONSE_MARKER = "DEEPSEEK — FASE 0: PREGUNTAS PARA COMPLETAR CONTEXTO";

const MAX_CONTEXT_PACKAGES = 20;
const MAX_CONTEXT_CHARS = 64 * 1024;

export interface ContextThreadMessage {
  ts: string;
  text: string;
  user?: string;
  botId?: string;
}

export interface ContextPackage {
  index: number;
  total: number;
  final: boolean;
  body: string;
}

export function contextAuthorKey(message: ContextThreadMessage): string | null {
  if (message.user) return `user:${message.user}`;
  if (message.botId) return `bot:${message.botId}`;
  return null;
}

export type ContextBuildResult =
  | { ok: true; context: string; packageCount: number }
  | { ok: false; error: string };

export function parseContextPackage(text: string): ContextPackage | null {
  const escapedMarker = CONTEXT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(
    new RegExp(
      `^${escapedMarker}\\s*\\n+\\s*PAQUETE\\s+(FINAL\\s+)?(\\d+)\\/(\\d+)\\s*\\n+([\\s\\S]*)$`,
      "i"
    )
  );
  if (!match) return null;

  const index = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || total < 1) {
    return null;
  }

  return {
    index,
    total,
    final: Boolean(match[1]),
    body: cleanPackageBody(match[4]),
  };
}

function cleanPackageBody(body: string): string {
  return body
    .replace(
      /^No respondas ni analices hasta recibir el paquete FINAL\. Reconstruye los paquetes de este hilo en orden\.\s*/i,
      ""
    )
    .replace(/\s*Continúa esperando; faltan paquetes\.\s*$/i, "")
    .replace(
      /\s*FIN DEL PAQUETE\. Ya puedes reconstruir todo el contexto y responder únicamente según la instrucción de FASE 0\.\s*$/i,
      ""
    )
    .replace(/\n\*Enviado usando\*[\s\S]*$/i, "")
    .trim();
}

export function isContextProcessCommand(text: string): boolean {
  return text.trim() === CONTEXT_PROCESS_COMMAND;
}

export function isContextReadyMessage(text: string): boolean {
  if (isContextProcessCommand(text)) return true;
  const parsed = parseContextPackage(text);
  return Boolean(parsed?.final && parsed.index === parsed.total);
}

export function ensureContextResponseMarker(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith(CONTEXT_RESPONSE_MARKER)) return trimmed;
  return `${CONTEXT_RESPONSE_MARKER}\n\n${trimmed}`;
}

export function containsPotentialSecret(text: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bxox[baprs]-[A-Za-z0-9-]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bsk-[A-Za-z0-9_-]{20,}/.test(
    text
  );
}

export function buildContextFromThread(
  messages: ContextThreadMessage[],
  expectedAuthorKey: string
): ContextBuildResult {
  const parsed = messages
    .map((message) => ({ message, package: parseContextPackage(message.text) }))
    .filter(
      (entry): entry is { message: ContextThreadMessage; package: ContextPackage } =>
        entry.package !== null
    );

  if (parsed.length === 0) {
    return { ok: false, error: "El hilo no contiene paquetes de contexto reconocibles." };
  }
  if (parsed.some(({ message }) => contextAuthorKey(message) !== expectedAuthorKey)) {
    return { ok: false, error: "Todos los paquetes deben proceder del mismo autor de Slack." };
  }

  const totals = new Set(parsed.map(({ package: item }) => item.total));
  if (totals.size !== 1) {
    return { ok: false, error: "Los paquetes declaran totales incompatibles." };
  }
  const total = parsed[0].package.total;
  if (total > MAX_CONTEXT_PACKAGES) {
    return { ok: false, error: `El contexto supera el máximo de ${MAX_CONTEXT_PACKAGES} paquetes.` };
  }
  if (parsed.length !== total) {
    return { ok: false, error: `El hilo declara ${total} paquetes, pero contiene ${parsed.length}.` };
  }

  const byIndex = new Map<number, ContextPackage>();
  for (const { package: item } of parsed) {
    if (item.index > total || byIndex.has(item.index)) {
      return { ok: false, error: "Hay paquetes duplicados o fuera de rango." };
    }
    byIndex.set(item.index, item);
  }
  for (let index = 1; index <= total; index++) {
    if (!byIndex.has(index)) {
      return { ok: false, error: `Falta el paquete ${index}/${total}.` };
    }
  }
  const last = byIndex.get(total);
  if (!last?.final) {
    return { ok: false, error: "El último paquete no está marcado como FINAL." };
  }

  const context = Array.from({ length: total }, (_, offset) => byIndex.get(offset + 1)!.body)
    .join("\n\n")
    .trim();
  if (!context) return { ok: false, error: "El contexto reconstruido está vacío." };
  if (context.length > MAX_CONTEXT_CHARS) {
    return { ok: false, error: "El contexto reconstruido supera 64 KiB." };
  }
  if (containsPotentialSecret(context)) {
    return {
      ok: false,
      error: "El contexto parece contener una credencial o clave privada y no se enviará al modelo.",
    };
  }

  return { ok: true, context, packageCount: total };
}

export function splitSlackText(text: string, maxChars = 3800): string[] {
  if (maxChars < 200) throw new Error("maxChars debe ser al menos 200.");
  const paragraphs = text.split(/\n\n/);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);

    let remaining = paragraph;
    while (remaining.length > maxChars) {
      let cut = remaining.lastIndexOf("\n", maxChars);
      if (cut < Math.floor(maxChars / 2)) cut = remaining.lastIndexOf(" ", maxChars);
      if (cut < Math.floor(maxChars / 2)) cut = maxChars;
      chunks.push(remaining.slice(0, cut).trimEnd());
      remaining = remaining.slice(cut).trimStart();
    }
    current = remaining;
  }

  if (current) chunks.push(current);
  return chunks;
}
