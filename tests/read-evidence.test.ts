import test from "node:test";
import assert from "node:assert/strict";
import {
  ReadEvidenceTracker,
  ReadEvidenceError,
  detectRequiredSources,
  extractCodeBlocks,
  codeMatchesAuthenticSource,
  validateReadEvidence,
  MAX_READ_BYTES_PER_FILE,
  MAX_TOTAL_READ_BYTES,
} from "../src/read-evidence.js";
import {
  isReviewResponseForRequest,
  type ReviewRequest,
} from "../src/review-request.js";

process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
process.env.SLACK_BOT_TOKEN = "xoxb-test-bot-token";
process.env.GITHUB_TOKEN = "test-github-token";

const { findPendingHandoffWithThreadState } = await import("../src/tools/slack.js");

test("1. detectRequiredSources: detecta fuentes exigidas y bandera de contenido íntegro", () => {
  const instr1 = "Por favor, emite la fuente íntegra de `lib/regulatory-lifecycle.ts` para verificar la regla DeCA.";
  const reqs1 = detectRequiredSources(instr1);
  assert.equal(reqs1.length, 1);
  assert.equal(reqs1[0].path, "lib/regulatory-lifecycle.ts");
  assert.equal(reqs1[0].requiresFullContent, true);

  const instr2 = "Comprueba el contenido íntegro de src/agent.ts y revisa los imports.";
  const reqs2 = detectRequiredSources(instr2);
  assert.equal(reqs2.length, 1);
  assert.equal(reqs2[0].path, "src/agent.ts");
  assert.equal(reqs2[0].requiresFullContent, true);

  const instr3 = "Ejecuta get_full_file de `lib/service.ts` para contrastar la firma.";
  const reqs3 = detectRequiredSources(instr3);
  assert.equal(reqs3.length, 1);
  assert.equal(reqs3[0].path, "lib/service.ts");
  assert.equal(reqs3[0].requiresFullContent, false);

  const instr4 = "Revisa los cambios de esta PR de forma estándar sin pedir ficheros íntegros.";
  const reqs4 = detectRequiredSources(instr4);
  assert.equal(reqs4.length, 0);
});

test("2. ReadEvidenceTracker: registra lecturas exitosas y calcula bytes/sha256", () => {
  const tracker = new ReadEvidenceTracker(
    "fragonh2-boop/Fornexa",
    "573bee8ee05a066bab908baedb1e79b43d455edb"
  );

  const authenticContent = "export const DECA_PUBLIC_POST_COMPLETION_DAYS = 7;\n";
  const record = tracker.recordRead({
    repo: "fragonh2-boop/Fornexa",
    ref: "573bee8ee05a066bab908baedb1e79b43d455edb",
    path: "lib/regulatory-lifecycle.ts",
    content: authenticContent,
  });

  assert.equal(record.success, true);
  assert.equal(record.bytes, Buffer.byteLength(authenticContent, "utf8"));
  assert.equal(record.sha256.length, 64);
  assert.equal(tracker.findSuccessfulRead("lib/regulatory-lifecycle.ts")?.sha256, record.sha256);
  assert.equal(tracker.getTotalBytes(), record.bytes);
});

test("3. ReadEvidenceTracker: rechaza contaminación cruzada de repo o ref", () => {
  const tracker = new ReadEvidenceTracker(
    "fragonh2-boop/fornexa-ai-reviewer",
    "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3"
  );

  // Intento de reutilizar lectura de otro repo
  const recordDifferentRepo = tracker.recordRead({
    repo: "fragonh2-boop/Fornexa",
    ref: "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3",
    path: "lib/regulatory-lifecycle.ts",
    content: "some content",
  });
  assert.equal(recordDifferentRepo.success, false);
  assert.match(recordDifferentRepo.error!, /Cross-request mismatch/);

  // Intento de reutilizar lectura de otro SHA
  const recordDifferentSha = tracker.recordRead({
    repo: "fragonh2-boop/fornexa-ai-reviewer",
    ref: "a2d5030a64d3926fd652e1a1c34870c017d82849",
    path: "src/index.ts",
    content: "some content",
  });
  assert.equal(recordDifferentSha.success, false);
  assert.match(recordDifferentSha.error!, /Cross-request mismatch/);
});

test("4. validateReadEvidence: falla con MISSING_READ si el modelo no invoca la herramienta requerida", () => {
  const tracker = new ReadEvidenceTracker(
    "fragonh2-boop/Fornexa",
    "573bee8ee05a066bab908baedb1e79b43d455edb"
  );

  // Ninguna lectura ejecutada en el tracker
  assert.throws(
    () =>
      validateReadEvidence({
        tracker,
        requiredSources: [{ path: "lib/regulatory-lifecycle.ts", requiresFullContent: true }],
        verdict: "Aquí está el código:\n```ts\nexport const fake = 1;\n```",
      }),
    (err: unknown) => {
      assert(err instanceof ReadEvidenceError);
      assert.equal(err.code, "MISSING_READ");
      assert.match(err.safeMessage, /No se ejecutó la lectura requerida/);
      return true;
    }
  );
});

test("5. validateReadEvidence: falla con READ_FAILED si la herramienta arrojó error (404/red)", () => {
  const tracker = new ReadEvidenceTracker(
    "fragonh2-boop/Fornexa",
    "573bee8ee05a066bab908baedb1e79b43d455edb"
  );

  tracker.recordRead({
    repo: "fragonh2-boop/Fornexa",
    ref: "573bee8ee05a066bab908baedb1e79b43d455edb",
    path: "lib/regulatory-lifecycle.ts",
    error: "404 Not Found",
  });

  assert.throws(
    () =>
      validateReadEvidence({
        tracker,
        requiredSources: [{ path: "lib/regulatory-lifecycle.ts", requiresFullContent: true }],
        verdict: "```ts\nexport const hallucinated = true;\n```",
      }),
    (err: unknown) => {
      assert(err instanceof ReadEvidenceError);
      assert.equal(err.code, "READ_FAILED");
      assert.match(err.safeMessage, /Falló la lectura requerida.*404 Not Found/);
      return true;
    }
  );
});

test("6. validateReadEvidence: falla con CONTENT_DISCREPANCY si el modelo inventa código (incidente 1518 vs 1181)", () => {
  const tracker = new ReadEvidenceTracker(
    "fragonh2-boop/Fornexa",
    "573bee8ee05a066bab908baedb1e79b43d455edb"
  );

  const authenticGitHubSource = `export const DECA_PUBLIC_POST_COMPLETION_DAYS = 7;
export function decaMinimumPublicUntilMs(completedAt: number): number {
  return completedAt + DECA_PUBLIC_POST_COMPLETION_DAYS * 86400 * 1000;
}
export function decaPublicAccessWindowIsUsable(completedAt: number, now: number): boolean {
  return now <= decaMinimumPublicUntilMs(completedAt);
}`;

  tracker.recordRead({
    repo: "fragonh2-boop/Fornexa",
    ref: "573bee8ee05a066bab908baedb1e79b43d455edb",
    path: "lib/regulatory-lifecycle.ts",
    content: authenticGitHubSource,
  });

  // Código ficticio alucinado (similar al incidente con 72h y RegulatoryLifecycleConfig)
  const hallucinatedVerdict = `### Contenido íntegro de \`lib/regulatory-lifecycle.ts\`

\`\`\`typescript
export interface RegulatoryLifecycleConfig {
  documentId: string;
  issueDate: string;
}
export function evaluateRegulatoryLifecycle(config: RegulatoryLifecycleConfig) {
  // 72 horas inventadas
  return 72;
}
\`\`\``;

  assert.throws(
    () =>
      validateReadEvidence({
        tracker,
        requiredSources: [{ path: "lib/regulatory-lifecycle.ts", requiresFullContent: true }],
        verdict: hallucinatedVerdict,
      }),
    (err: unknown) => {
      assert(err instanceof ReadEvidenceError);
      assert.equal(err.code, "CONTENT_DISCREPANCY");
      assert.match(err.safeMessage, /no coincide mecánicamente con la fuente íntegra/);
      return true;
    }
  );
});

test("7. validateReadEvidence: aprueba con éxito cuando el código emitido coincide exactamente con GitHub", () => {
  const tracker = new ReadEvidenceTracker(
    "fragonh2-boop/fornexa-ai-reviewer",
    "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3"
  );

  const authenticSlackErrors = `interface SlackPlatformErrorLike {
  data?: {
    error?: unknown;
  };
}

export function slackPlatformErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as SlackPlatformErrorLike).data?.error;
  return typeof code === "string" ? code : null;
}

export function isCannotReplyToMessageError(error: unknown): boolean {
  return slackPlatformErrorCode(error) === "cannot_reply_to_message";
}`;

  tracker.recordRead({
    repo: "fragonh2-boop/fornexa-ai-reviewer",
    ref: "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3",
    path: "src/slack-errors.ts",
    content: authenticSlackErrors,
  });

  const correctVerdict = `### Contenido íntegro de \`src/slack-errors.ts\` (HEAD: \`c0e27bf183df80c35aed5bc6a2fd4200144fb0f3\`)

\`\`\`typescript
interface SlackPlatformErrorLike {
  data?: {
    error?: unknown;
  };
}

export function slackPlatformErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as SlackPlatformErrorLike).data?.error;
  return typeof code === "string" ? code : null;
}

export function isCannotReplyToMessageError(error: unknown): boolean {
  return slackPlatformErrorCode(error) === "cannot_reply_to_message";
}
\`\`\`

### Veredicto:
MUST: ninguno
SHOULD: ninguno`;

  assert.doesNotThrow(() =>
    validateReadEvidence({
      tracker,
      requiredSources: [{ path: "src/slack-errors.ts", requiresFullContent: true }],
      verdict: correctVerdict,
    })
  );
});

test("8. validateReadEvidence: tolera comentario cosmético inicial de ruta en el bloque emitido", () => {
  const tracker = new ReadEvidenceTracker(
    "fragonh2-boop/fornexa-ai-reviewer",
    "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3"
  );

  const authenticSource = "export const PI = 3.14159;\n";
  tracker.recordRead({
    repo: "fragonh2-boop/fornexa-ai-reviewer",
    ref: "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3",
    path: "lib/math.ts",
    content: authenticSource,
  });

  const verdictWithHeader = `\`\`\`typescript\n// lib/math.ts\nexport const PI = 3.14159;\n\`\`\``;
  assert.doesNotThrow(() =>
    validateReadEvidence({
      tracker,
      requiredSources: [{ path: "lib/math.ts", requiresFullContent: true }],
      verdict: verdictWithHeader,
    })
  );
});

test("9. Sondeo y correlación: REVISIÓN FALLIDA por ReadEvidence cierra determinísticamente el hilo", async () => {
  const agentLabel = "GEMINI";
  const requestTs = "1791282609.370269";
  const repo = "fragonh2-boop/Fornexa";
  const head = "573bee8ee05a066bab908baedb1e79b43d455edb";

  const request: ReviewRequest = {
    target: "ref",
    ref: "main",
    repository: repo,
    requestedHead: head,
    instructions: "emite la fuente íntegra de `lib/regulatory-lifecycle.ts`",
  };

  // Simulación del mensaje terminal que emite notifyFailure cuando se captura ReadEvidenceError
  const safeReason = "la revisión del HEAD `573bee8ee05a066bab908baedb1e79b43d455edb` falló por falta o discrepancia de evidencia de lectura (El código emitido en el veredicto no coincide mecánicamente con la fuente íntegra autenticada de lib/regulatory-lifecycle.ts)";
  const terminalMessageText = [
    `${agentLabel} — REVISIÓN FALLIDA`,
    `SLACK_REQUEST_TS: ${requestTs}`,
    "",
    `Repo: ${repo}`,
    `TARGET: main`,
    `HEAD \`${head}\`: ${safeReason}.`,
    "",
    "_El detalle técnico se conserva en el log del servicio. El candado se liberará para permitir un reintento seguro._",
  ].join("\n");

  const terminalMessage = {
    ts: "1791282615.123456",
    text: terminalMessageText,
    botId: "B0C39QX9PEY",
    threadTs: requestTs,
  };

  // 1. isReviewResponseForRequest debe evaluar a true
  const matches = isReviewResponseForRequest(
    terminalMessage,
    agentLabel,
    request,
    requestTs
  );
  assert.equal(matches, true);

  // 2. findPendingHandoffWithThreadState no debe devolver handoff pendiente para este hilo cerrado
  const rootMessage = {
    ts: requestTs,
    text: `${agentLabel} — ACCIÓN REQUERIDA\nMODE: MAIN\nTARGET: main\nRepo: ${repo}\nHEAD: ${head}\n\nemite la fuente íntegra de \`lib/regulatory-lifecycle.ts\``,
    user: "U0C4X8N9QD6",
    replyCount: 1,
  };

  const pending = await findPendingHandoffWithThreadState(
    [rootMessage],
    agentLabel,
    {
      allowedBotIds: ["B0C3MGL1P2T", "B0C39QX9PEY"],
      ownBotId: "B0C39QX9PEY",
      ownUserId: "U0C362TR8HG",
    },
    async (threadTs) => {
      if (threadTs === requestTs) {
        return [rootMessage, terminalMessage];
      }
      return [];
    }
  );

  assert.equal(pending, null, "El hilo con REVISIÓN FALLIDA correlacionada debe quedar cerrado sin reintento");
});
