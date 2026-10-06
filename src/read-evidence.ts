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
  return path.trim().replace(/^['"`]+|['"`]+$/g, "").replace(/^\.?\//, "");
}

export function normalizeSourceText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
}

export function extractCodeBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const regex = /```(?:[a-zA-Z0-9_.-]+)?\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    blocks.push(match[1]);
  }
  return blocks;
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
  if (linesEmitted.length > 1 && /^\/\/\s*[\w./-]+$/i.test(linesEmitted[0].trim())) {
    const strippedEmitted = linesEmitted.slice(1).join("\n").trim();
    if (strippedEmitted === normAuthentic) {
      return true;
    }
  }

  return false;
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

    // Detección de contaminación cruzada de repositorio o SHA
    if (normalizedRepo !== this.expectedRepo || normalizedRef !== this.expectedRef) {
      const record: FileReadRecord = {
        repo: normalizedRepo,
        ref: normalizedRef,
        path: cleanPath,
        content: "",
        bytes: 0,
        sha256: "",
        success: false,
        error: `Cross-request mismatch: expected ${this.expectedRepo}@${this.expectedRef}, got ${normalizedRepo}@${normalizedRef}`,
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
        error: params.error || "Read failed without explicit content",
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
 * Extrae las rutas de ficheros exigidas a partir de las instrucciones de la solicitud.
 * Si las instrucciones contienen términos como "fuente íntegra", "contenido íntegro", etc.,
 * se activa requiresFullContent = true para verificar mecánicamente el código resultante.
 */
export function detectRequiredSources(instructions?: string): ReadEvidenceRequirement[] {
  if (!instructions || typeof instructions !== "string") {
    return [];
  }

  const results: ReadEvidenceRequirement[] = [];
  const seenPaths = new Set<string>();

  const isFullContentRequested = /(?:fuente|contenido|código)\s+(?:íntegr[oa]s?|complet[oa]s?|enter[oa]s?)|full\s+content|exact\s+source/i.test(
    instructions
  );

  // Patrón 1: frases explícitas de requerimiento de fuente o lectura
  const explicitPattern = /(?:fuente|contenido|código|archivo|fichero)\s+(?:íntegr[oa]s?|complet[oa]s?|enter[oa]s?)?\s*(?:de\s+)?[`"']?([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\.[a-zA-Z0-9_-]+)[`"']?/gi;
  let match: RegExpExecArray | null;
  while ((match = explicitPattern.exec(instructions)) !== null) {
    const clean = normalizeFilePath(match[1]);
    if (clean && !clean.includes("..") && !seenPaths.has(clean)) {
      seenPaths.add(clean);
      results.push({
        path: clean,
        requiresFullContent: isFullContentRequested,
      });
    }
  }

  // Patrón 2: herramientas o acciones explícitas como get_full_file, lee, consultar
  const actionPattern = /(?:get_full_file|lee|leer|obtén|obtener|consultar?)\s+(?:el\s+)?(?:fichero|archivo|código|fuente)?\s*(?:de\s+)?[`"']?([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\.[a-zA-Z0-9_-]+)[`"']?/gi;
  while ((match = actionPattern.exec(instructions)) !== null) {
    const clean = normalizeFilePath(match[1]);
    if (clean && !clean.includes("..") && !seenPaths.has(clean)) {
      seenPaths.add(clean);
      results.push({
        path: clean,
        requiresFullContent: isFullContentRequested,
      });
    }
  }

  // Patrón 3: Si se solicitó contenido íntegro y hay rutas entre backticks con extensión de fichero
  if (isFullContentRequested) {
    const backtickedPattern = /`([a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*\.[a-zA-Z0-9_-]+)`/g;
    while ((match = backtickedPattern.exec(instructions)) !== null) {
      const clean = normalizeFilePath(match[1]);
      if (clean && !clean.includes("..") && !seenPaths.has(clean)) {
        seenPaths.add(clean);
        results.push({
          path: clean,
          requiresFullContent: true,
        });
      }
    }
  }

  return results.slice(0, MAX_REQUIRED_SOURCES);
}

export function validateReadEvidence(params: {
  tracker: ReadEvidenceTracker;
  requiredSources: ReadEvidenceRequirement[];
  verdict: string;
}): void {
  const { tracker, requiredSources, verdict } = params;

  // Verificación 1: Comprobación de contaminación cruzada en cualquier registro
  for (const record of tracker.getRecords()) {
    if (record.repo !== tracker.getRepo() || record.ref !== tracker.getRef()) {
      throw new ReadEvidenceError(
        "CROSS_REQUEST_CONTAMINATION",
        `Evidencia rechazada por discordancia de repositorio/SHA: ${record.repo}@${record.ref} frente a esperado ${tracker.getRepo()}@${tracker.getRef()}`,
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

  if (requiredSources.length === 0) {
    return;
  }

  const codeBlocks = extractCodeBlocks(verdict);

  // Verificación 3: Cada fuente requerida debe haber sido leída exitosamente y contrastada si aplica
  for (const req of requiredSources) {
    const successfulRead = tracker.findSuccessfulRead(req.path);
    if (!successfulRead) {
      const failedRead = tracker.findAnyRead(req.path);
      if (failedRead && failedRead.error) {
        throw new ReadEvidenceError(
          "READ_FAILED",
          `Falló la lectura requerida de ${req.path}: ${failedRead.error}`,
          req.path
        );
      }
      throw new ReadEvidenceError(
        "MISSING_READ",
        `No se ejecutó la lectura requerida de ${req.path}`,
        req.path
      );
    }

    if (req.requiresFullContent) {
      if (codeBlocks.length === 0) {
        throw new ReadEvidenceError(
          "CONTENT_DISCREPANCY",
          `Se solicitó fuente íntegra de ${req.path} pero el veredicto no incluye ningún bloque de código`,
          req.path
        );
      }

      const matchFound = codeBlocks.some((block) =>
        codeMatchesAuthenticSource(block, successfulRead.content)
      );

      if (!matchFound) {
        throw new ReadEvidenceError(
          "CONTENT_DISCREPANCY",
          `El código emitido en el veredicto no coincide mecánicamente con la fuente íntegra autenticada de ${req.path}`,
          req.path
        );
      }
    }
  }
}
