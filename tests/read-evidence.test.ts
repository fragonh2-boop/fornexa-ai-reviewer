import test from "node:test";
import assert from "node:assert/strict";
import {
  ReadEvidenceTracker,
  ReadEvidenceError,
  detectRequiredSources,
  codeMatchesAuthenticSource,
  validateReadEvidence,
  MAX_READ_BYTES_PER_FILE,
  MAX_TOTAL_READ_BYTES,
  MAX_REQUIRED_SOURCES,
} from "../src/read-evidence.js";
import {
  isReviewResponseForRequest,
  type ReviewRequest,
} from "../src/review-request.js";
import { runCapabilities, type Capability } from "../src/capabilities.js";
import { safePath } from "../src/implementation.js";
import type { ModelAdapter } from "../src/providers.js";
import type { RefContext, PRContext } from "../src/tools/github.js";

process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
process.env.SLACK_BOT_TOKEN = "xoxb-test-bot-token";
process.env.GITHUB_TOKEN = "test-github-token";

const { findPendingHandoffWithThreadState } = await import("../src/tools/slack.js");
const { reviewRepository, reviewPR } = await import("../src/agent.js");

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
      assert.match(err.safeMessage, /Falló la lectura requerida de lib\/regulatory-lifecycle\.ts/);
      assert.equal((err as ReadEvidenceError).safeMessage.includes("404 Not Found"), false);
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

test("10. Probe 1 (control positivo): Emite la fuente íntegra de src/foo.ts con lectura y bloque coincidente -> ACCEPTED", () => {
  const tracker = new ReadEvidenceTracker(
    "fragonh2-boop/fornexa-ai-reviewer",
    "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3"
  );
  tracker.recordRead({
    repo: "fragonh2-boop/fornexa-ai-reviewer",
    ref: "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3",
    path: "src/foo.ts",
    content: "export const value = 7;\n",
  });

  const reqs = detectRequiredSources("Emite la fuente íntegra de src/foo.ts;");
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].path, "src/foo.ts");
  assert.equal(reqs[0].requiresFullContent, true);

  const verdict = "```ts\nexport const value = 7;\n```";
  assert.doesNotThrow(() => {
    validateReadEvidence({
      tracker,
      requiredSources: reqs,
      verdict,
    });
  });
});

test("11. Probe 2 (control negativo): Mismo requerimiento y lectura, pero bloque modificado -> REJECTED CONTENT_DISCREPANCY", () => {
  const tracker = new ReadEvidenceTracker(
    "fragonh2-boop/fornexa-ai-reviewer",
    "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3"
  );
  tracker.recordRead({
    repo: "fragonh2-boop/fornexa-ai-reviewer",
    ref: "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3",
    path: "src/foo.ts",
    content: "export const value = 7;\n",
  });

  const reqs = detectRequiredSources("Emite la fuente íntegra de src/foo.ts;");
  const verdict = "```ts\nexport const value = 72;\n```";

  assert.throws(
    () => {
      validateReadEvidence({
        tracker,
        requiredSources: reqs,
        verdict,
      });
    },
    (err: unknown) => {
      assert(err instanceof ReadEvidenceError);
      assert.equal(err.code, "CONTENT_DISCREPANCY");
      return true;
    }
  );
});

test("12. Probe 3 (bypass ruta con corchetes): Lee `app/[id]/page.tsx` y devuelve su código íntegro sin lectura -> REJECTED MISSING_READ", () => {
  const tracker = new ReadEvidenceTracker(
    "fragonh2-boop/fornexa-ai-reviewer",
    "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3"
  );

  const instructions = "Lee `app/[id]/page.tsx` y devuelve su código íntegro;";
  const reqs = detectRequiredSources(instructions);
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].path, "app/[id]/page.tsx");
  assert.equal(reqs[0].requiresFullContent, true);

  const inventedVerdict = "```tsx\nexport default function Page() { return <div>invented</div>; }\n```";

  // Sin lectura ejecutada en el tracker, debe fallar cerrado con MISSING_READ
  assert.throws(
    () => {
      validateReadEvidence({
        tracker,
        requiredSources: reqs,
        verdict: inventedVerdict,
      });
    },
    (err: unknown) => {
      assert(err instanceof ReadEvidenceError);
      assert.equal(err.code, "MISSING_READ");
      return true;
    }
  );
});

test("13. Probe 4 (bypass sin acento): Lee `src/foo.ts` y devuelve su codigo completo sin acento -> requiresFullContent=true y rechaza discrepancia", () => {
  const tracker = new ReadEvidenceTracker(
    "fragonh2-boop/fornexa-ai-reviewer",
    "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3"
  );
  tracker.recordRead({
    repo: "fragonh2-boop/fornexa-ai-reviewer",
    ref: "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3",
    path: "src/foo.ts",
    content: "export const value = 7;\n",
  });

  const instructions = "Lee `src/foo.ts` y devuelve su codigo completo;";
  const reqs = detectRequiredSources(instructions);
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].path, "src/foo.ts");
  assert.equal(reqs[0].requiresFullContent, true);

  const modifiedVerdict = "```ts\nexport const value = 72;\n```";
  assert.throws(
    () => {
      validateReadEvidence({
        tracker,
        requiredSources: reqs,
        verdict: modifiedVerdict,
      });
    },
    (err: unknown) => {
      assert(err instanceof ReadEvidenceError);
      assert.equal(err.code, "CONTENT_DISCREPANCY");
      return true;
    }
  );
});

test("14. Probe 5 (bypass intercambio de fuentes): Pide fuente íntegra de src/a.ts y src/b.ts con fuentes intercambiadas -> REJECTED CONTENT_DISCREPANCY", () => {
  const tracker = new ReadEvidenceTracker(
    "fragonh2-boop/fornexa-ai-reviewer",
    "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3"
  );
  tracker.recordRead({
    repo: "fragonh2-boop/fornexa-ai-reviewer",
    ref: "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3",
    path: "src/a.ts",
    content: "export const a = 1;\n",
  });
  tracker.recordRead({
    repo: "fragonh2-boop/fornexa-ai-reviewer",
    ref: "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3",
    path: "src/b.ts",
    content: "export const b = 2;\n",
  });

  const reqs = detectRequiredSources("Pide fuente íntegra de src/a.ts y src/b.ts");
  assert.equal(reqs.length, 2);

  // Veredicto con fuentes intercambiadas bajo los encabezados
  const swappedVerdict = [
    "### src/a.ts",
    "```ts",
    "export const b = 2;",
    "```",
    "",
    "### src/b.ts",
    "```ts",
    "export const a = 1;",
    "```",
  ].join("\n");

  assert.throws(
    () => {
      validateReadEvidence({
        tracker,
        requiredSources: reqs,
        verdict: swappedVerdict,
      });
    },
    (err: unknown) => {
      assert(err instanceof ReadEvidenceError);
      assert.equal(err.code, "CONTENT_DISCREPANCY");
      return true;
    }
  );

  // Comprobar que en orden correcto sí se aprueba
  const correctVerdict = [
    "### src/a.ts",
    "```ts",
    "export const a = 1;",
    "```",
    "",
    "### src/b.ts",
    "```ts",
    "export const b = 2;",
    "```",
  ].join("\n");

  assert.doesNotThrow(() => {
    validateReadEvidence({
      tracker,
      requiredSources: reqs,
      verdict: correctVerdict,
    });
  });
});

test("15. Probe 6 (bypass recorte presupuestario silencioso): Pide 11 fuentes íntegras -> arriesga BUDGET_EXCEEDED sin truncar a 10", () => {
  const instructions = "Pide fuente íntegra de `f1.ts`, `f2.ts`, `f3.ts`, `f4.ts`, `f5.ts`, `f6.ts`, `f7.ts`, `f8.ts`, `f9.ts`, `f10.ts` y `f11.ts`.";

  assert.throws(
    () => {
      detectRequiredSources(instructions);
    },
    (err: unknown) => {
      assert(err instanceof ReadEvidenceError);
      assert.equal(err.code, "BUDGET_EXCEEDED");
      assert.match(err.safeMessage, /límite de fuentes requeridas/);
      return true;
    }
  );
});

test("16. Probe 7 (ausencia de saneamiento): Error sintético con SENSITIVE_DIAGNOSTIC_CANARY no se filtra a safeMessage ni a la notificación pública", () => {
  const tracker = new ReadEvidenceTracker(
    "fragonh2-boop/fornexa-ai-reviewer",
    "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3"
  );
  tracker.recordRead({
    repo: "fragonh2-boop/fornexa-ai-reviewer",
    ref: "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3",
    path: "src/secret.ts",
    error: "Connection failure: SENSITIVE_DIAGNOSTIC_CANARY at internal path /root/keys",
  });

  const reqs = [{ path: "src/secret.ts", requiresFullContent: true }];

  assert.throws(
    () => {
      validateReadEvidence({
        tracker,
        requiredSources: reqs,
        verdict: "```ts\nexport const x = 1;\n```",
      });
    },
    (err: unknown) => {
      assert(err instanceof ReadEvidenceError);
      assert.equal(err.code, "READ_FAILED");
      assert.equal(err.safeMessage.includes("SENSITIVE_DIAGNOSTIC_CANARY"), false);
      assert.equal(err.message.includes("SENSITIVE_DIAGNOSTIC_CANARY"), false);

      // Simular generación de mensaje terminal en index.ts
      const safeReason = `la revisión del HEAD falló por falta o discrepancia de evidencia de lectura (${err.safeMessage})`;
      assert.equal(safeReason.includes("SENSITIVE_DIAGNOSTIC_CANARY"), false);
      return true;
    }
  );
});

test("17. Probe 8 (ruta ASCII sin backticks): Usa get_full_file una sola vez para lib/regulatory-lifecycle.ts. Devuelve su contenido íntegro", () => {
  const instructions = "Usa get_full_file una sola vez para lib/regulatory-lifecycle.ts. Devuelve su contenido íntegro; ninguna lectura, fuente inventada";
  const reqs = detectRequiredSources(instructions);
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].path, "lib/regulatory-lifecycle.ts");
  assert.equal(reqs[0].requiresFullContent, true);

  const tracker = new ReadEvidenceTracker(
    "fragonh2-boop/Fornexa",
    "573bee8ee05a066bab908baedb1e79b43d455edb"
  );
  // Sin lecturas en el tracker
  assert.throws(
    () => {
      validateReadEvidence({
        tracker,
        requiredSources: reqs,
        verdict: "```ts\nexport const fake = 1;\n```",
      });
    },
    (err: unknown) => {
      assert(err instanceof ReadEvidenceError);
      assert.equal(err.code, "MISSING_READ");
      return true;
    }
  );
});

test("18. Fuentes legítimas vacías: archivo vacío de 0 bytes o whitespace en GitHub coincide con bloque vacío", () => {
  const tracker = new ReadEvidenceTracker(
    "fragonh2-boop/fornexa-ai-reviewer",
    "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3"
  );
  tracker.recordRead({
    repo: "fragonh2-boop/fornexa-ai-reviewer",
    ref: "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3",
    path: "src/empty.ts",
    content: "",
  });

  const reqs = [{ path: "src/empty.ts", requiresFullContent: true }];
  const verdict = "### src/empty.ts\n```ts\n```";

  assert.doesNotThrow(() => {
    validateReadEvidence({
      tracker,
      requiredSources: reqs,
      verdict,
    });
  });
});

test("19. Presupuesto por fichero y presupuesto global acumulado", () => {
  const tracker = new ReadEvidenceTracker(
    "fragonh2-boop/fornexa-ai-reviewer",
    "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3"
  );

  // Fichero que excede 500 KB
  const oversizedContent = "a".repeat(MAX_READ_BYTES_PER_FILE + 10);
  const record = tracker.recordRead({
    repo: "fragonh2-boop/fornexa-ai-reviewer",
    ref: "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3",
    path: "src/big.ts",
    content: oversizedContent,
  });
  assert.equal(record.success, false);
  assert.match(record.error!, /File budget exceeded/);

  // Presupuesto global que excede 2 MB
  const tracker2 = new ReadEvidenceTracker(
    "fragonh2-boop/fornexa-ai-reviewer",
    "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3"
  );
  // Simular 5 lecturas de 450 KB (total 2.25 MB > 2 MB)
  const piece = "b".repeat(450 * 1024);
  for (let i = 1; i <= 5; i++) {
    tracker2.recordRead({
      repo: "fragonh2-boop/fornexa-ai-reviewer",
      ref: "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3",
      path: `src/part${i}.ts`,
      content: piece,
    });
  }
  assert.throws(
    () => {
      validateReadEvidence({
        tracker: tracker2,
        requiredSources: [],
        verdict: "ok",
      });
    },
    (err: unknown) => {
      assert(err instanceof ReadEvidenceError);
      assert.equal(err.code, "BUDGET_EXCEEDED");
      return true;
    }
  );
});

test("20. Procedencia de runtime: ref='main' aceptado contra pinned SHA en revisión de main, pero ref o repo incompatible rechazado", () => {
  const headSha = "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3";
  const repo = "fragonh2-boop/fornexa-ai-reviewer";
  const tracker = new ReadEvidenceTracker(repo, headSha);

  // Si el runtime lee contra headSha, el tracker registra headSha
  const record = tracker.recordRead({
    repo,
    ref: headSha,
    path: "src/foo.ts",
    content: "const a = 1;",
  });
  assert.equal(record.success, true);
  assert.equal(record.ref, headSha);

  // Si se intenta registrar un SHA o repo cruzado, el tracker lo marca como cross-request mismatch
  const mismatchRecord = tracker.recordRead({
    repo: "fragonh2-boop/Fornexa",
    ref: headSha,
    path: "src/foo.ts",
    content: "const a = 1;",
  });
  assert.equal(mismatchRecord.success, false);
  assert.equal(mismatchRecord.error, "Cross-request mismatch");
});

test("21. Simulación aislada de guard, candado y terminal; no ejecuta agent/index", async () => {
  const inFlightMap = new Map<string, number>();
  const acquire = (key: string) => {
    if (inFlightMap.has(key)) return { acquired: false, startedAt: 0 };
    const now = Date.now();
    inFlightMap.set(key, now);
    return { acquired: true, startedAt: now };
  };
  const release = (key: string, startedAt: number) => {
    if (inFlightMap.get(key) === startedAt) inFlightMap.delete(key);
  };

  const agentLabel = "GEMINI";
  const requestTs = "1791289000.100000";
  const repo = "fragonh2-boop/fornexa-ai-reviewer";
  const headSha = "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3";
  const reviewKey = `${repo}:ref:main`;

  const request: ReviewRequest = {
    target: "ref",
    ref: "main",
    repository: repo,
    requestedHead: headSha,
    instructions: "Emite la fuente íntegra de `src/auth.ts`",
  };

  // Simulación: Ejecución con discrepancia detectada por el guard
  const lock = acquire(reviewKey);
  assert.equal(lock.acquired, true);

  let caughtError: unknown;
  let terminalMessageText = "";

  try {
    const tracker = new ReadEvidenceTracker(repo, headSha);
    const requiredSources = detectRequiredSources(request.instructions);

    // Doble de GitHub devuelve fuente auténtica
    const authenticAuthCode = "export const authenticate = () => true;\n";
    tracker.recordRead({
      repo,
      ref: headSha,
      path: "src/auth.ts",
      content: authenticAuthCode,
    });

    // Doble de modelo emite código inventado/discrepante
    const modelEmittedVerdict = "### src/auth.ts\n```ts\nexport const authenticate = () => false;\n```";

    validateReadEvidence({
      tracker,
      requiredSources,
      verdict: modelEmittedVerdict,
    });
  } catch (err) {
    caughtError = err;
    assert(err instanceof ReadEvidenceError);
    assert.equal(err.code, "CONTENT_DISCREPANCY");

    const safeReason = `la revisión del HEAD \`${headSha}\` falló por falta o discrepancia de evidencia de lectura (${err.safeMessage})`;
    terminalMessageText = [
      `${agentLabel} — REVISIÓN FALLIDA`,
      `SLACK_REQUEST_TS: ${requestTs}`,
      "",
      `Repo: ${repo}`,
      `TARGET: main`,
      `HEAD \`${headSha}\`: ${safeReason}.`,
      "",
      "_El detalle técnico se conserva en el log del servicio. El candado se liberará para permitir un reintento seguro._",
    ].join("\n");
  } finally {
    release(reviewKey, lock.startedAt);
  }

  // 1. Candado debe quedar liberado en el bloque finally
  assert.equal(inFlightMap.has(reviewKey), false);
  assert.ok(caughtError);

  // 2. El mensaje terminal correlacionado debe cerrar el hilo
  const terminalMessage = {
    ts: "1791289010.200000",
    text: terminalMessageText,
    botId: "B0C39QX9PEY",
    threadTs: requestTs,
  };

  assert.equal(isReviewResponseForRequest(terminalMessage, agentLabel, request, requestTs), true);

  const rootMessage = {
    ts: requestTs,
    text: `${agentLabel} — ACCIÓN REQUERIDA\nMODE: MAIN\nTARGET: main\nRepo: ${repo}\nHEAD: ${headSha}\n\nEmite la fuente íntegra de \`src/auth.ts\``,
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

  assert.equal(pending, null, "El hilo queda cerrado y el candado libre");
});

test("22. Claude MUST 1: runCapabilities aborta inmediatamente ante ReadEvidenceError", async () => {
  const capability: Capability = {
    definition: {
      type: "function",
      function: {
        name: "get_full_file",
        description: "get file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    },
    async execute() {
      throw new ReadEvidenceError(
        "CROSS_REQUEST_CONTAMINATION",
        "Argumento de ref incompatible con la revisión activa",
        "src/auth.ts"
      );
    },
  };

  const adapter: ModelAdapter = {
    async complete() {
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "get_full_file",
              arguments: JSON.stringify({ path: "src/auth.ts" }),
            },
          },
        ],
      };
    },
  };

  await assert.rejects(
    runCapabilities(adapter, [{ role: "user", content: "test prompt" }], [capability]),
    (err: unknown) => {
      assert(err instanceof ReadEvidenceError);
      assert.equal(err.code, "CROSS_REQUEST_CONTAMINATION");
      assert.match(err.message, /Argumento de ref incompatible con la revisión activa/);
      return true;
    }
  );
});

test("23. Claude MUST 2: detectRequiredSources no rechaza solicitudes estándar con más de 10 rutas sin requerir contenido íntegro", () => {
  // Lista de 12 archivos en prosa de una revisión normal
  const normalPRInstructions =
    "Por favor revisa los cambios en los siguientes ficheros: " +
    Array.from({ length: 12 }, (_, i) => `src/file${i}.ts`).join(", ") +
    ". Identifica riesgos de seguridad o regresiones.";

  const reqs = detectRequiredSources(normalPRInstructions);
  assert.equal(reqs.length, 0);

  // Solicitud que sí exige contenido íntegro para más de 10 ficheros
  const fullContentInstructions =
    "Emite el contenido íntegro de: " +
    Array.from({ length: 11 }, (_, i) => `src/file${i}.ts`).join(", ");

  assert.throws(
    () => detectRequiredSources(fullContentInstructions),
    (err: unknown) => {
      assert(err instanceof ReadEvidenceError);
      assert.equal(err.code, "BUDGET_EXCEEDED");
      return true;
    }
  );

  // Solicitud con más de 10 instrucciones explícitas de get_full_file
  const explicitReadsInstructions = Array.from(
    { length: 11 },
    (_, i) => `Usa get_full_file para src/file${i}.ts`
  ).join(". ");

  assert.throws(
    () => detectRequiredSources(explicitReadsInstructions),
    (err: unknown) => {
      assert(err instanceof ReadEvidenceError);
      assert.equal(err.code, "BUDGET_EXCEEDED");
      return true;
    }
  );
});

test("24. Claude/DeepSeek SHOULD 3: safePath y codeMatchesAuthenticSource admiten rutas Next.js con corchetes", () => {
  // safePath
  assert.equal(safePath("app/[id]/page.tsx"), true);
  assert.equal(safePath("src/routes/[...slug]/page.tsx"), true);
  assert.equal(safePath("../app/[id]/page.tsx"), false);
  assert.equal(safePath(".env"), false);

  // codeMatchesAuthenticSource con comentario cosmético de cabecera con corchetes
  const authentic = "export default function Page() {\n  return <div>OK</div>;\n}";
  const emittedWithBracketComment = "// app/[id]/page.tsx\nexport default function Page() {\n  return <div>OK</div>;\n}";
  assert.equal(codeMatchesAuthenticSource(emittedWithBracketComment, authentic), true);

  const emittedWithBlockComment = "/* app/[id]/page.tsx */\nexport default function Page() {\n  return <div>OK</div>;\n}";
  assert.equal(codeMatchesAuthenticSource(emittedWithBlockComment, authentic), true);
});

test("25. MUST 1 Probe 1: reviewRepository con 'Revisa `src/auth.ts` y dime si hay fuga' rechaza sin lecturas con MISSING_READ", async () => {
  const repo = "fragonh2-boop/fornexa-ai-reviewer";
  const headSha = "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3";
  const ctx: RefContext = {
    ref: "main",
    headSha,
    headMessage: "chore: update dependencies",
    recentCommits: [{ sha: headSha, message: "chore: update dependencies" }],
    checks: [{ name: "ci", status: "completed", conclusion: "success" }],
    repo,
  };

  let getFileCalls = 0;
  const mockGetFile = async () => {
    getFileCalls++;
    return "export const auth = true;";
  };

  // Modelo doble: 1 llamada al modelo, 0 llamadas a herramientas
  const mockAdapter: ModelAdapter = {
    async complete() {
      return {
        role: "assistant",
        content: "He leído src/auth.ts: no hay fuga. MUST: ninguno. MERGE: YES",
      };
    },
  };

  await assert.rejects(
    reviewRepository(ctx, "Revisa `src/auth.ts` y dime si hay fuga.", {
      adapter: mockAdapter,
      getFile: mockGetFile,
    }),
    (err: unknown) => {
      assert(err instanceof ReadEvidenceError);
      assert.equal(err.code, "MISSING_READ");
      assert.equal(err.path, "src/auth.ts");
      assert.match(err.safeMessage, /No se ejecutó la lectura requerida de src\/auth\.ts/);
      return true;
    }
  );

  assert.equal(getFileCalls, 0, "GitHub no debió recibir llamadas");
});

test("26. MUST 1 Probe 2 (Control full-sin-lectura): solicitud de contenido íntegro sin lectura rechaza con MISSING_READ", async () => {
  const repo = "fragonh2-boop/fornexa-ai-reviewer";
  const headSha = "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3";
  const ctx: RefContext = {
    ref: "main",
    headSha,
    headMessage: "chore: test",
    recentCommits: [{ sha: headSha, message: "chore: test" }],
    checks: [],
    repo,
  };

  const mockAdapter: ModelAdapter = {
    async complete() {
      return {
        role: "assistant",
        content: "### src/auth.ts\n```ts\nexport const fake = 1;\n```",
      };
    },
  };

  await assert.rejects(
    reviewRepository(ctx, "Lee `src/auth.ts` y devuelve contenido íntegro.", {
      adapter: mockAdapter,
      getFile: async () => "export const auth = true;",
    }),
    (err: unknown) => {
      assert(err instanceof ReadEvidenceError);
      assert.equal(err.code, "MISSING_READ");
      return true;
    }
  );
});

test("27. MUST 2 Probe 3: ref incompatible con marcador sintético produce error seguro sin filtrar canary", async () => {
  const repo = "fragonh2-boop/fornexa-ai-reviewer";
  const headSha = "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3";
  const canary = "SYNTHETIC_DIAGNOSTIC_CANARY_0241";
  const ctx: RefContext = {
    ref: "main",
    headSha,
    headMessage: "test",
    recentCommits: [],
    checks: [],
    repo,
  };

  const mockAdapter: ModelAdapter = {
    async complete() {
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_ref_canary",
            type: "function",
            function: {
              name: "get_full_file",
              arguments: JSON.stringify({
                path: "src/auth.ts",
                ref: canary,
              }),
            },
          },
        ],
      };
    },
  };

  await assert.rejects(
    reviewRepository(ctx, "Revisa `src/auth.ts`", {
      adapter: mockAdapter,
      getFile: async () => "content",
    }),
    (err: unknown) => {
      assert(err instanceof ReadEvidenceError);
      assert.equal(err.code, "CROSS_REQUEST_CONTAMINATION");
      assert.equal(err.safeMessage, "Argumento de ref incompatible con la revisión activa");
      assert.equal(err.safeMessage.includes(canary), false, "safeMessage no debe contener el canario");
      assert.equal(err.message.includes(canary), false, "err.message no debe contener el canario");

      // Simular formateo público de terminal en index.ts
      const safeReason = `la revisión del HEAD \`${headSha}\` falló por falta o discrepancia de evidencia de lectura (${err.safeMessage})`;
      assert.equal(safeReason.includes(canary), false, "safeReason público no debe contener el canario");
      return true;
    }
  );
});

test("28. MUST 2 Probe 4: repo incompatible con marcador sintético produce error seguro sin filtrar canary", async () => {
  const repo = "fragonh2-boop/fornexa-ai-reviewer";
  const headSha = "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3";
  const canary = "SYNTHETIC_DIAGNOSTIC_CANARY_0241";
  const ctx: RefContext = {
    ref: "main",
    headSha,
    headMessage: "test",
    recentCommits: [],
    checks: [],
    repo,
  };

  const mockAdapter: ModelAdapter = {
    async complete() {
      return {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_repo_canary",
            type: "function",
            function: {
              name: "get_full_file",
              arguments: JSON.stringify({
                path: "src/auth.ts",
                repo: canary,
              }),
            },
          },
        ],
      };
    },
  };

  await assert.rejects(
    reviewRepository(ctx, "Revisa `src/auth.ts`", {
      adapter: mockAdapter,
      getFile: async () => "content",
    }),
    (err: unknown) => {
      assert(err instanceof ReadEvidenceError);
      assert.equal(err.code, "CROSS_REQUEST_CONTAMINATION");
      assert.equal(err.safeMessage, "Argumento de repositorio incompatible con la revisión activa");
      assert.equal(err.safeMessage.includes(canary), false, "safeMessage no debe contener el canario");
      assert.equal(err.message.includes(canary), false, "err.message no debe contener el canario");

      const safeReason = `la revisión del HEAD \`${headSha}\` falló por falta o discrepancia de evidencia de lectura (${err.safeMessage})`;
      assert.equal(safeReason.includes(canary), false, "safeReason público no debe contener el canario");
      return true;
    }
  );
});

test("29. Control positivo Main: ref main, lectura efectiva y veredicto fundamentado aceptado", async () => {
  const repo = "fragonh2-boop/fornexa-ai-reviewer";
  const headSha = "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3";
  const ctx: RefContext = {
    ref: "main",
    headSha,
    headMessage: "feat: add auth check",
    recentCommits: [{ sha: headSha, message: "feat: add auth check" }],
    checks: [{ name: "ci", status: "completed", conclusion: "success" }],
    repo,
  };

  let turns = 0;
  let getFileCount = 0;

  const mockAdapter: ModelAdapter = {
    async complete() {
      turns++;
      if (turns === 1) {
        return {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_read_auth",
              type: "function",
              function: {
                name: "get_full_file",
                arguments: JSON.stringify({
                  path: "src/auth.ts",
                  ref: headSha,
                }),
              },
            },
          ],
        };
      }
      return {
        role: "assistant",
        content: "Revisado src/auth.ts de forma íntegra: no se aprecian fugas de secretos ni desbordamientos. MUST: ninguno. MERGE: YES",
      };
    },
  };

  const mockGetFile = async (path: string, ref: string) => {
    getFileCount++;
    assert.equal(path, "src/auth.ts");
    assert.equal(ref, headSha);
    return "export function authenticate(token: string) { return Boolean(token); }\n";
  };

  const verdict = await reviewRepository(ctx, "Revisa `src/auth.ts` y dime si hay fuga", {
    adapter: mockAdapter,
    getFile: mockGetFile,
  });

  assert.equal(turns, 2, "El modelo debe haber realizado 2 turnos (herramienta + veredicto)");
  assert.equal(getFileCount, 1, "Debe haberse realizado 1 lectura de GitHub");
  assert.match(verdict, /Revisado src\/auth\.ts/);
  assert.match(verdict, /MERGE: YES/);
});

test("30. PR Review: diff suministrado en prompt evalúa cambios sin exigir lecturas forzadas en GitHub", async () => {
  const repo = "fragonh2-boop/fornexa-ai-reviewer";
  const headSha = "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3";
  const prCtx: PRContext = {
    number: 37,
    title: "guard read evidence",
    headSha,
    baseSha: "base123",
    repo,
    changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
    diffText: "diff --git a/src/a.ts b/src/a.ts\n+export const a = 1;\n",
    checks: [{ name: "ci", status: "completed", conclusion: "success" }],
  };

  let getFileCount = 0;
  const mockAdapter: ModelAdapter = {
    async complete() {
      return {
        role: "assistant",
        content: "Revisado el diff de la PR: no se aprecian anomalías en src/a.ts. MUST: ninguno. MERGE: YES",
      };
    },
  };

  const verdict = await reviewPR(
    prCtx,
    "SEGUNDA_REVISION",
    undefined,
    "Por favor revisa los cambios en src/a.ts y src/b.ts.",
    {
      adapter: mockAdapter,
      getFile: async () => {
        getFileCount++;
        return "";
      },
    }
  );

  assert.equal(getFileCount, 0, "No debe obligar a llamadas de get_full_file si el diff está en prompt");
  assert.match(verdict, /MERGE: YES/);
});

test("31. Formal main sin fuente falla cerrado con instrucción genérica, independiente de afirmaciones del modelo", async () => {
  const repo = "fragonh2-boop/fornexa-ai-reviewer";
  const headSha = "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3";
  const ctx: RefContext = {
    ref: "main",
    headSha,
    headMessage: "test",
    recentCommits: [],
    checks: [],
    repo,
  };

  const mockAdapter: ModelAdapter = {
    async complete() {
      return {
        role: "assistant",
        content: "He leído `src/secret.ts`: no hay problemas. MUST: ninguno. MERGE: YES",
      };
    },
  };

  await assert.rejects(
    reviewRepository(ctx, "Revisa el estado general del repositorio", {
      adapter: mockAdapter,
      getFile: async () => "",
    }),
    (err: unknown) => {
      assert(err instanceof ReadEvidenceError);
      assert.equal(err.code, "MISSING_READ");
      assert.match(err.safeMessage, /requiere una lectura efectiva/);
      return true;
    }
  );
});

const formalMainContext: RefContext = {
  ref: "main",
  headSha: "fac26e0be18f0b31de75684800054ea61abdce87",
  headMessage: "metadata, not source",
  recentCommits: [],
  checks: [],
  repo: "fragonh2-boop/fornexa-ai-reviewer",
};

function scriptedReviewAdapter(readPaths: string[], verdict: string): ModelAdapter {
  let turns = 0;
  return {
    async complete() {
      if (turns++ === 0 && readPaths.length) {
        return {
          role: "assistant",
          content: null,
          tool_calls: readPaths.map((path, index) => ({
            id: `read_${index}`,
            type: "function" as const,
            function: {
              name: "get_full_file",
              arguments: JSON.stringify({ path, ref: "main" }),
            },
          })),
        };
      }
      return { role: "assistant", content: verdict };
    },
  };
}

test("32. Formal main exige fuente para inglés, paráfrasis y revisión sin rutas, no por regex de veredicto", async () => {
  const fixtures = [
    ["Review src/auth.ts and tell me whether it contains a secret leak.", "I have read src/auth.ts. MUST: none. MERGE: YES"],
    ["¿Qué opinas de `src/auth.ts`? ¿Está correcto?", "Revisado src/auth.ts: todo correcto. MUST: ninguno. MERGE: YES"],
    ["Revisa main y dime si hay vulnerabilidades de seguridad.", "No hay vulnerabilidades. MUST: ninguno. MERGE: YES"],
    ["Revisa el estado general del repositorio", "### src/auth.ts\n```ts\nexport const fabricated = true;\n```\nMERGE: YES"],
    ["", "MUST: ninguno. MERGE: YES"],
  ];
  for (const [instructions, verdict] of fixtures) {
    let reads = 0;
    await assert.rejects(
      reviewRepository(formalMainContext, instructions, {
        adapter: scriptedReviewAdapter([], verdict),
        getFile: async () => { reads++; return "source"; },
      }),
      (err: unknown) => err instanceof ReadEvidenceError && err.code === "MISSING_READ"
    );
    assert.equal(reads, 0);
  }
});

test("33. Una lectura ajena no satisface ninguna ruta objetivo nombrada en revisión formal main", async () => {
  for (const [instructions, expectedMissing] of [
    ["Review src/auth.ts for correctness.", "src/auth.ts"],
    ["¿Qué opinas de `src/auth.ts`?", "src/auth.ts"],
    ["src/auth.ts y src/session.ts", "src/auth.ts"],
    ["Review README.md for correctness.", "README.md"],
  ]) {
    const observed: string[] = [];
    await assert.rejects(
      reviewRepository(formalMainContext, instructions, {
        adapter: scriptedReviewAdapter(["src/unrelated.ts"], "MUST: ninguno. MERGE: YES"),
        getFile: async (path, ref, repo) => {
          assert.equal(ref, formalMainContext.headSha);
          assert.equal(repo, formalMainContext.repo);
          observed.push(path);
          return "export const unrelated = true;";
        },
      }),
      (err: unknown) => err instanceof ReadEvidenceError && err.code === "MISSING_READ" && err.path === expectedMissing
    );
    assert.deepEqual(observed, ["src/unrelated.ts"]);
  }
});

test("34. Formal main acepta selección dinámica acotada o todas las rutas nombradas leídas en el SHA activo", async () => {
  for (const [instructions, paths] of [
    ["Review the current repository state.", ["src/auth.ts"]],
    ["src/auth.ts y src/session.ts", ["src/auth.ts", "src/session.ts"]],
  ] as Array<[string, string[]]>) {
    const observed: string[] = [];
    const verdict = await reviewRepository(formalMainContext, instructions, {
      adapter: scriptedReviewAdapter(paths, "MUST: ninguno. MERGE: YES"),
      getFile: async (path, ref) => {
        assert.equal(ref, formalMainContext.headSha);
        observed.push(path);
        return "export const authentic = true;";
      },
    });
    assert.deepEqual(observed, paths);
    assert.match(verdict, /MERGE: YES/);
    // This proves source provenance/consumption, not truth or complete coverage
    // of every conclusion in model prose. No model assertion is the evidence.
  }
});

test("35. Formal main no permite desactivar el contrato mediante opciones inyectadas", async () => {
  await assert.rejects(
    reviewRepository(formalMainContext, "Review main.", {
      adapter: scriptedReviewAdapter([], "MERGE: YES"),
      getFile: async () => "source",
      ...({ scope: { kind: "pull_request", hasSourceInPrompt: true } } as Record<string, unknown>),
    }),
    (err: unknown) => err instanceof ReadEvidenceError && err.code === "MISSING_READ"
  );
});

test("36. Selección de fuentes main y lecturas dinámicas excedidas fallan sin recorte ni lectura undécima", async () => {
  const paths = Array.from({ length: MAX_REQUIRED_SOURCES + 1 }, (_, i) => `src/file${i}.ts`);
  let modelCalls = 0;
  for (const delimiter of [", ", " ", "\n", "\t", ",", ";", ":"]) {
    await assert.rejects(
      reviewRepository(formalMainContext, `Review ${paths.join(delimiter)}`, {
        adapter: { async complete() { modelCalls++; return { role: "assistant", content: "MERGE: YES" }; } },
      }),
      (err: unknown) => err instanceof ReadEvidenceError && err.code === "BUDGET_EXCEEDED"
    );
  }
  assert.equal(modelCalls, 0);

  const observed: string[] = [];
  await assert.rejects(
    reviewRepository(formalMainContext, "Review main.", {
      adapter: scriptedReviewAdapter(paths, "MERGE: YES"),
      getFile: async (path) => { observed.push(path); return "source"; },
    }),
    (err: unknown) => err instanceof ReadEvidenceError && err.code === "BUDGET_EXCEEDED"
  );
  assert.deepEqual(observed, paths.slice(0, MAX_REQUIRED_SOURCES));
});

test("37. PR diff-only de 12 rutas narrativas conserva la fuente suministrada sin forzar GitHub", async () => {
  const paths = Array.from({ length: 12 }, (_, i) => `src/file${i}.ts`);
  const ctx: PRContext = {
    number: 37,
    title: "diff-only",
    headSha: formalMainContext.headSha,
    baseSha: "c0e27bf183df80c35aed5bc6a2fd4200144fb0f3",
    repo: formalMainContext.repo,
    changedFiles: paths,
    diffText: paths.map((path) => `diff --git a/${path} b/${path}\n+export const changed = true;\n`).join("\n"),
    checks: [],
  };
  let reads = 0;
  const verdict = await reviewPR(ctx, "SEGUNDA_REVISION", undefined, `Revisa los cambios: ${paths.join(", ")}`, {
    adapter: scriptedReviewAdapter([], "Revisado el diff suministrado. MUST: ninguno. MERGE: YES"),
    getFile: async () => { reads++; return "source"; },
  });
  assert.equal(reads, 0);
  assert.match(verdict, /MERGE: YES/);
});

test("38. Lectura dinámica fallida no puede ser sustituida por el veredicto ni filtra el error bruto", async () => {
  const marker = "SYNTHETIC_READ_ERROR_CANARY";
  let turns = 0;
  const adapter = scriptedReviewAdapter(["src/auth.ts"], "MERGE: YES");
  await assert.rejects(
    reviewRepository(formalMainContext, "Review main.", {
      adapter: { async complete(messages, tools) { turns++; return adapter.complete(messages, tools); } },
      getFile: async () => { throw new Error(marker); },
    }),
    (err: unknown) => {
      assert(err instanceof ReadEvidenceError);
      assert.equal(err.code, "READ_FAILED");
      assert.equal(err.safeMessage.includes(marker), false);
      assert.equal(err.message.includes(marker), false);
      return true;
    }
  );
  assert.equal(turns, 1);
});

test("39. Rutas adyacentes por separadores admitidos se vinculan todas, sin consumir el delimitador", async () => {
  const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
  for (const delimiter of [" ", "\n", "\t", ",", ";", ":"]) {
    const instructions = `Review ${paths.join(delimiter)}`;
    assert.deepEqual(
      detectRequiredSources(instructions, { kind: "repository" }).map((source) => source.path),
      paths
    );
    await assert.rejects(
      reviewRepository(formalMainContext, instructions, {
        adapter: scriptedReviewAdapter([paths[0], paths[2]], "MUST: ninguno. MERGE: YES"),
        getFile: async () => "source",
      }),
      (err: unknown) => err instanceof ReadEvidenceError && err.code === "MISSING_READ" && err.path === paths[1]
    );
    const observed: string[] = [];
    const verdict = await reviewRepository(formalMainContext, instructions, {
      adapter: scriptedReviewAdapter(paths, "MUST: ninguno. MERGE: YES"),
      getFile: async (path) => { observed.push(path); return "source"; },
    });
    assert.deepEqual(observed, paths);
    assert.match(verdict, /MERGE: YES/);
  }
});
