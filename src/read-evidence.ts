import crypto from "node:crypto";
import { normalizeRepository } from "./review-request.js";

export const MAX_REQUIRED_SOURCES = 10;
export const MAX_READ_BYTES_PER_FILE = 500 * 1024; // 500 KB
export const MAX_TOTAL_READ_BYTES = 2 * 1024 * 1024; // 2 MB

export interface FileReadRecord {
  repo: string;
  ref: string;
  path: string;
  content: string;
  bytes: number;
  sha256: string;
  success: boolean;
  error?: string;
  timestamp: number;
}

export interface ReadEvidenceRequirement {
  path: string;
  requiresFullContent: boolean;
}

export interface ReviewEvidenceScope {
  hasSourceInPrompt?: boolean;
  targetRef?: string;
  providedPaths?: string[];
}

export type ReadEvidenceErrorCode =
  | "MISSING_READ"
  | "READ_FAILED"
  | "CONTENT_DISCREPANCY"
  | "CROSS_REQUEST_CONTAMINATION"
  | "BUDGET_EXCEEDED";

export class ReadEvidenceError extends Error {
  readonly code: ReadEvidenceErrorCode;
  readonly path?: string;
  readonly safeMessage: string;

  constructor(code: ReadEvidenceErrorCode, safeMessage: string, path?: string) {
    super(`ReadEvidenceError [${code}]: ${safeMessage}`);
    this.name = "ReadEvidenceError";
    this.code = code;
    this.path = path;
    this.safeMessage = safeMessage;
  }
}

export function normalizeFilePath(path: string): string {
  return path
    .trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/[,;.:]+$/, "")
    .replace(/^\.?\//, "");
}

export function normalizeSourceText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

/**
 * Comprueba si un bloque de código emitido por el modelo coincide mecánicamente
 * con el contenido auténtico de GitHub (normalizando saltos de línea y whitespace).
 * También tolera encabezados cosméticos menores de una sola línea (ej. `// ruta/al/archivo`).
 */
export function codeMatchesAuthenticSource(emittedCode: string, authenticSource: string): boolean {
  const normEmitted = normalizeSourceText(emittedCode);
  const normAuthentic = normalizeSourceText(authenticSource);

  if (normEmitted === normAuthentic) {
    return true;
  }

  // Si el bloque emitido contiene un comentario inicial cosmético con la ruta
  const linesEmitted = normEmitted.split("\n");
  if (linesEmitted.length > 1 && /^\s*(?:\/\/|\/\*|#)\s*[\w.\[\]/-]+\s*(?:\*\/)?$/i.test(linesEmitted[0].trim())) {
    const strippedEmitted = linesEmitted.slice(1).join("\n").trim();
    if (strippedEmitted === normAuthentic) {
      return true;
    }
  }

  return false;
}

export interface ExtractedCodeBlock {
  code: string;
  lang?: string;
  precedingText: string;
  firstLine: string;
  startIndex: number;
  endIndex: number;
}

export function extractCodeBlocksWithMetadata(markdown: string): ExtractedCodeBlock[] {
  const blocks: ExtractedCodeBlock[] = [];
  const regex = /```([a-zA-Z0-9_.-]*)\s*\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    const lang = match[1] || undefined;
    const code = match[2];
    const startIndex = match.index;
    const endIndex = regex.lastIndex;
    const precedingText = markdown.slice(lastIndex, startIndex);
    const firstLine = (code.split("\n")[0] || "").trim();
    blocks.push({
      code,
      lang,
      precedingText,
      firstLine,
      startIndex,
      endIndex,
    });
    lastIndex = endIndex;
  }
  return blocks;
}

export function extractCodeBlocks(markdown: string): string[] {
  return extractCodeBlocksWithMetadata(markdown).map((b) => b.code);
}

/**
 * Asocia un bloque de código emitido a una ruta específica de entre las candidatas,
 * analizando comentarios de primera línea y encabezados en el texto precedente inmediato.
 */
export function associateBlockToPath(
  block: ExtractedCodeBlock,
  candidatePaths: string[]
): string | undefined {
  // 1. En comentario de la primera línea del bloque
  const commentMatch = /^\s*(?:\/\/|\/\*|#)\s*([a-zA-Z0-9_.\[\]/-]+\.[a-zA-Z0-9_-]+)/i.exec(block.firstLine);
  if (commentMatch) {
    const clean = normalizeFilePath(commentMatch[1]);
    if (candidatePaths.includes(clean)) {
      return clean;
    }
  }

  // 2. Encabezados o etiquetas en precedingText (buscando desde las líneas más cercanas al bloque hacia arriba)
  const lines = block.precedingText.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    for (const p of candidatePaths) {
      const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`(?:^|[\`'"*\\s(#:])${escaped}(?:$|[\`'"*\\s)#:])`, "i");
      if (pattern.test(line)) {
        return p;
      }
    }
  }

  return undefined;
}

export class ReadEvidenceTracker {
  private readonly expectedRepo: string;
  private readonly expectedRef: string;
  private readonly records: FileReadRecord[] = [];

  constructor(expectedRepo: string, expectedRef: string) {
    this.expectedRepo = normalizeRepository(expectedRepo);
    this.expectedRef = expectedRef.toLowerCase();
  }

  getRepo(): string {
    return this.expectedRepo;
  }

  getRef(): string {
    return this.expectedRef;
  }

  getRecords(): readonly FileReadRecord[] {
    return this.records;
  }

  getTotalBytes(): number {
    return this.records.reduce((sum, r) => sum + r.bytes, 0);
  }

  recordRead(params: {
    repo?: string;
    ref: string;
    path: string;
    content?: string;
    error?: string;
  }): FileReadRecord {
    const normalizedRepo = normalizeRepository(params.repo || this.expectedRepo);
    const normalizedRef = params.ref.toLowerCase();
    const cleanPath = normalizeFilePath(params.path);

    // Detección de discordancia de procedencia entre solicitud y lectura
    if (normalizedRepo !== this.expectedRepo || normalizedRef !== this.expectedRef) {
      const record: FileReadRecord = {
        repo: normalizedRepo,
        ref: normalizedRef,
        path: cleanPath,
        content: "",
        bytes: 0,
        sha256: "",
        success: false,
        error: "Cross-request mismatch",
        timestamp: Date.now(),
      };
      this.records.push(record);
      return record;
    }

    if (params.error !== undefined || params.content === undefined) {
      const record: FileReadRecord = {
        repo: normalizedRepo,
        ref: normalizedRef,
        path: cleanPath,
        content: "",
        bytes: 0,
        sha256: "",
        success: false,
        error: "Read failed",
        timestamp: Date.now(),
      };
      this.records.push(record);
      return record;
    }

    const bytes = Buffer.byteLength(params.content, "utf8");
    if (bytes > MAX_READ_BYTES_PER_FILE) {
      const record: FileReadRecord = {
        repo: normalizedRepo,
        ref: normalizedRef,
        path: cleanPath,
        content: "",
        bytes,
        sha256: "",
        success: false,
        error: `File budget exceeded (${bytes} bytes > ${MAX_READ_BYTES_PER_FILE})`,
        timestamp: Date.now(),
      };
      this.records.push(record);
      return record;
    }

    const sha256 = crypto.createHash("sha256").update(params.content, "utf8").digest("hex");
    const record: FileReadRecord = {
      repo: normalizedRepo,
      ref: normalizedRef,
      path: cleanPath,
      content: params.content,
      bytes,
      sha256,
      success: true,
      timestamp: Date.now(),
    };
    this.records.push(record);
    return record;
  }

  findSuccessfulRead(path: string): FileReadRecord | undefined {
    const cleanPath = normalizeFilePath(path);
    return this.records.find((r) => r.success && r.path === cleanPath);
  }

  findAnyRead(path: string): FileReadRecord | undefined {
    const cleanPath = normalizeFilePath(path);
    return this.records.find((r) => r.path === cleanPath);
  }
}

/**
 * Detecta si las instrucciones solicitan el contenido íntegro/completo de fuentes.
 * Es tolerante a mayúsculas/minúsculas y variaciones con o sin acento (código/codigo, íntegro/integro).
 */
export function isFullContentRequested(instructions?: string): boolean {
  if (!instructions || typeof instructions !== "string") {
    return false;
  }
  const normalized = instructions
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return (
    /(?:fuente|contenido|codigo)\s+(?:integr[oa]s?|complet[oa]s?|enter[oa]s?)/i.test(normalized) ||
    /full\s+content|exact\s+source|complete\s+(?:source|code)|entire\s+(?:source|code|content)/i.test(normalized) ||
    /devuelve\s+(?:el\s+|la\s+|su\s+)?(?:codigo|fuente|contenido)\s+(?:integr[oa]|complet[oa]|enter[oa])/i.test(normalized) ||
    /emite\s+(?:la\s+|el\s+|su\s+)?(?:fuente|codigo|contenido)\s+(?:integr[oa]|complet[oa]|enter[oa])/i.test(normalized)
  );
}

/**
 * Extrae las rutas de ficheros exigidas a partir de las instrucciones de la solicitud.
 * Si se solicita contenido íntegro y se excede el límite de 10 fuentes, arroja BUDGET_EXCEEDED sin truncar.
 * Si se solicita contenido íntegro pero no se puede identificar ninguna fuente verificable, falla cerrado.
 * Si la revisión es de repositorio (main/rama) sin código en prompt (hasSourceInPrompt === false),
 * cualquier fichero objetivo de revisión/inspección técnica requiere lectura efectiva vía GitHub.
 */
export function detectRequiredSources(
  instructions?: string,
  scope?: ReviewEvidenceScope
): ReadEvidenceRequirement[] {
  if (!instructions || typeof instructions !== "string") {
    return [];
  }

  const isFullReq = isFullContentRequested(instructions);
  const seenPaths = new Set<string>();
  const explicitReadPaths = new Set<string>();

  // 1. Rutas entre backticks o comillas (p. ej. `app/[id]/page.tsx`, `lib/regulatory-lifecycle.ts`)
  const quotedRegex = /[`"']([a-zA-Z0-9_.\[\]/-]+\.[a-zA-Z0-9_-]+)[`"']/g;
  let match: RegExpExecArray | null;
  while ((match = quotedRegex.exec(instructions)) !== null) {
    const clean = normalizeFilePath(match[1]);
    if (clean && !clean.includes("..")) {
      seenPaths.add(clean);
    }
  }

  // 2. Rutas en texto llano con '/' y extensión de fichero (p. ej. lib/regulatory-lifecycle.ts, src/foo.ts)
  const pathTokenRegex = /(?:^|[\s,;:(])((?:[a-zA-Z0-9_.-]|\[[a-zA-Z0-9_.-]+\])+(?:\/(?:[a-zA-Z0-9_.-]|\[[a-zA-Z0-9_.-]+\])+)+\.[a-zA-Z0-9_-]+)(?:$|[\s,;:).])/g;
  while ((match = pathTokenRegex.exec(instructions)) !== null) {
    const candidate = normalizeFilePath(match[1]);
    if (
      candidate &&
      !candidate.includes("..") &&
      !candidate.startsWith("http://") &&
      !candidate.startsWith("https://")
    ) {
      seenPaths.add(candidate);
    }
  }

  // 3. Patrones de acción explícita (get_full_file, lee, leer, consultar)
  const actionRegex = /(?:get_full_file|lee|leer|obtén|obten|obtener|consultar?)\s+(?:el\s+|la\s+)?(?:fichero|archivo|código|codigo|fuente)?.*?(?:de\s+|para\s+|en\s+)?([a-zA-Z0-9_.\[\]/-]+\.[a-zA-Z0-9_-]+)/gi;
  while ((match = actionRegex.exec(instructions)) !== null) {
    const clean = normalizeFilePath(match[1]);
    if (clean && !clean.includes("..")) {
      seenPaths.add(clean);
      explicitReadPaths.add(clean);
    }
  }

  // 4. Frases explícitas de requerimiento de fuente o lectura
  const phraseRegex = /(?:fuente|contenido|código|codigo|archivo|fichero)\s+(?:íntegr[oa]s?|integr[oa]s?|complet[oa]s?|enter[oa]s?)?\s*(?:de\s+|para\s+|en\s+)?([a-zA-Z0-9_.\[\]/-]+\.[a-zA-Z0-9_-]+)/gi;
  while ((match = phraseRegex.exec(instructions)) !== null) {
    const clean = normalizeFilePath(match[1]);
    if (clean && !clean.includes("..")) {
      seenPaths.add(clean);
    }
  }

  // 5. En revisión de repositorio (main/rama) sin fuente en prompt (scope.hasSourceInPrompt === false):
  // Cualquier fichero objeto de revisión/inspección técnica (revisa, analiza, comprueba, etc.)
  // o consulta de riesgo dirigida a un fichero requiere lectura efectiva vía GitHub.
  if (scope?.hasSourceInPrompt === false) {
    const inspectionVerbRegex = /(?:revisa|revisar|analiza|analizar|comprueba|comprobar|examina|examinar|inspecciona|inspeccionar|audita|auditar|verifica|verificar|mira|mirar|evalúa|evaluar|estudia|estudiar)\s+(?:el\s+|la\s+|los\s+|las\s+)?(?:fichero|archivo|código|codigo|fuente|módulo|modulo)?.*?(?:de\s+|para\s+|en\s+|sobre\s+)?([a-zA-Z0-9_.\[\]/-]+\.[a-zA-Z0-9_-]+)/gi;
    while ((match = inspectionVerbRegex.exec(instructions)) !== null) {
      const clean = normalizeFilePath(match[1]);
      if (clean && !clean.includes("..")) {
        seenPaths.add(clean);
        explicitReadPaths.add(clean);
      }
    }

    const riskQueryRegex = /(?:fuga(?:s)?|vulnerabilidad(?:es)?|seguridad|fallo(?:s)?|error(?:es)?|leak(?:s)?|bug(?:s)?)\s+(?:en|sobre|de)\s+[`"']?([a-zA-Z0-9_.\[\]/-]+\.[a-zA-Z0-9_-]+)/gi;
    while ((match = riskQueryRegex.exec(instructions)) !== null) {
      const clean = normalizeFilePath(match[1]);
      if (clean && !clean.includes("..")) {
        seenPaths.add(clean);
        explicitReadPaths.add(clean);
      }
    }

    // Si en las instrucciones de revisión de repositorio se citaron ficheros y hay intención técnica
    if (seenPaths.size > 0 && explicitReadPaths.size === 0) {
      const hasReviewIntent = /(?:revis|analiz|comprob|examin|inspeccion|audit|verific|fuga|seguridad|fallo|error)/i.test(instructions);
      if (hasReviewIntent) {
        for (const p of seenPaths) {
          explicitReadPaths.add(p);
        }
      }
    }
  }

  // Verificación de límite presupuestario (MUST: No truncar silenciosamente)
  // Aplica a seenPaths cuando se solicita contenido íntegro; o a explicitReadPaths en caso no-íntegro
  const pathsToValidate = isFullReq ? seenPaths : explicitReadPaths;
  if (pathsToValidate.size > MAX_REQUIRED_SOURCES) {
    throw new ReadEvidenceError(
      "BUDGET_EXCEEDED",
      `Se superó el límite de fuentes requeridas (${pathsToValidate.size} > ${MAX_REQUIRED_SOURCES})`
    );
  }

  // Si se solicitó contenido íntegro explícitamente pero no se pudo establecer ninguna fuente: fallo cerrado
  if (isFullReq && seenPaths.size === 0) {
    throw new ReadEvidenceError(
      "MISSING_READ",
      "Se solicitó contenido íntegro pero no se pudieron establecer fuentes verificables para la revisión"
    );
  }

  const results: ReadEvidenceRequirement[] = [];
  if (isFullReq) {
    for (const path of seenPaths) {
      results.push({ path, requiresFullContent: true });
    }
  } else {
    for (const path of explicitReadPaths) {
      results.push({ path, requiresFullContent: false });
    }
  }

  return results;
}

export function validateReadEvidence(params: {
  tracker: ReadEvidenceTracker;
  requiredSources: ReadEvidenceRequirement[];
  verdict: string;
  scope?: ReviewEvidenceScope;
}): void {
  const { tracker, requiredSources, verdict, scope } = params;

  // Verificación 1: Comprobación de discordancia de procedencia
  for (const record of tracker.getRecords()) {
    if (record.repo !== tracker.getRepo() || record.ref !== tracker.getRef()) {
      throw new ReadEvidenceError(
        "CROSS_REQUEST_CONTAMINATION",
        "Discordancia de repositorio o commit entre la solicitud y la lectura ejecutada",
        record.path
      );
    }
  }

  // Verificación 2: Límite presupuestario global de lectura
  if (tracker.getTotalBytes() > MAX_TOTAL_READ_BYTES) {
    throw new ReadEvidenceError(
      "BUDGET_EXCEEDED",
      `Presupuesto total de lectura excedido (${tracker.getTotalBytes()} bytes > ${MAX_TOTAL_READ_BYTES})`
    );
  }

  if (requiredSources.length > MAX_REQUIRED_SOURCES) {
    throw new ReadEvidenceError(
      "BUDGET_EXCEEDED",
      `Se superó el límite de fuentes requeridas (${requiredSources.length} > ${MAX_REQUIRED_SOURCES})`
    );
  }

  // Verificación en revisiones sin fuente en prompt (main/rama):
  // Si no se proporcionó código en el prompt, el modelo no puede aseverar haber leído
  // ni emitir bloques de código de ficheros que no hayan sido leídos efectivamente en GitHub.
  if (scope?.hasSourceInPrompt === false) {
    const readClaimRegex = /(?:he\s+(?:le[ií]do|revisado|analizado|inspeccionado|comprobado|examinado)|tras\s+(?:leer|revisar|analizar|inspeccionar))\s+[`"']?([a-zA-Z0-9_.\[\]/-]+\.[a-zA-Z0-9_-]+)/gi;
    let claimMatch: RegExpExecArray | null;
    while ((claimMatch = readClaimRegex.exec(verdict)) !== null) {
      const claimedPath = normalizeFilePath(claimMatch[1]);
      if (claimedPath && !tracker.findSuccessfulRead(claimedPath)) {
        throw new ReadEvidenceError(
          "MISSING_READ",
          `No se ejecutó la lectura requerida de ${claimedPath}`,
          claimedPath
        );
      }
    }
  }

  if (requiredSources.length === 0) {
    return;
  }


  const codeBlocksWithMeta = extractCodeBlocksWithMetadata(verdict);
  const candidatePaths = requiredSources.map((r) => r.path);

  // Verificación 3: Cada fuente requerida debe haber sido leída exitosamente en GitHub
  for (const req of requiredSources) {
    const successfulRead = tracker.findSuccessfulRead(req.path);
    if (!successfulRead) {
      const failedRead = tracker.findAnyRead(req.path);
      if (failedRead) {
        throw new ReadEvidenceError(
          "READ_FAILED",
          `Falló la lectura requerida de ${req.path} en el commit especificado`,
          req.path
        );
      }
      throw new ReadEvidenceError(
        "MISSING_READ",
        `No se ejecutó la lectura requerida de ${req.path}`,
        req.path
      );
    }
  }

  // Verificación 4: Si se requiere contenido íntegro, vincular inequívocamente cada ruta a su bloque
  const sourcesNeedingFull = requiredSources.filter((r) => r.requiresFullContent);
  if (sourcesNeedingFull.length === 0) {
    return;
  }

  if (codeBlocksWithMeta.length === 0) {
    throw new ReadEvidenceError(
      "CONTENT_DISCREPANCY",
      `Se solicitó fuente íntegra pero el veredicto no incluye ningún bloque de código`,
      sourcesNeedingFull[0].path
    );
  }

  // Mapeo inequívoco bloque -> archivo
  const blockAssociations: { path: string; block: ExtractedCodeBlock }[] = [];

  if (sourcesNeedingFull.length === 1 && codeBlocksWithMeta.length === 1) {
    const declared = associateBlockToPath(codeBlocksWithMeta[0], candidatePaths);
    if (!declared || declared === sourcesNeedingFull[0].path) {
      blockAssociations.push({ path: sourcesNeedingFull[0].path, block: codeBlocksWithMeta[0] });
    } else {
      throw new ReadEvidenceError(
        "CONTENT_DISCREPANCY",
        `El bloque de código emitido está asociado a ${declared} en lugar de la fuente requerida ${sourcesNeedingFull[0].path}`,
        sourcesNeedingFull[0].path
      );
    }
  } else {
    for (const block of codeBlocksWithMeta) {
      const declared = associateBlockToPath(block, candidatePaths);
      if (declared) {
        blockAssociations.push({ path: declared, block });
      }
    }
  }

  for (const req of sourcesNeedingFull) {
    const successfulRead = tracker.findSuccessfulRead(req.path)!;
    const associated = blockAssociations.filter((a) => a.path === req.path);

    if (associated.length === 0) {
      throw new ReadEvidenceError(
        "CONTENT_DISCREPANCY",
        `No se encontró un bloque de código asociado unívocamente a ${req.path}`,
        req.path
      );
    }

    // Comprobar que todos los bloques declarados para esta ruta coinciden mecánicamente
    for (const { block } of associated) {
      if (!codeMatchesAuthenticSource(block.code, successfulRead.content)) {
        throw new ReadEvidenceError(
          "CONTENT_DISCREPANCY",
          `El código emitido en el veredicto no coincide mecánicamente con la fuente íntegra autenticada de ${req.path}`,
          req.path
        );
      }
    }
  }
}
