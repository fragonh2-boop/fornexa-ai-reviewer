import { runCapabilities } from "./capabilities.js";
import { safePath } from "./implementation.js";
import { createAdapter, supportsLegacyOnboarding } from "./providers.js";
import type { ChatCompletionTool, ChatCompletionMessageParam } from "openai/resources/index.js";
import { config } from "./config.js";
import { getFullFileAtRef, type PRContext, type RefContext } from "./tools/github.js";
import { SYSTEM_PROMPT, buildRepositoryReviewPrompt, buildUserPrompt } from "./prompt.js";
import { ensureContextResponseMarker } from "./context-onboarding.js";

export { extractFirstChoice, withTimeout } from "./reliability.js";

const adapter = createAdapter(config.model.provider, config.model.apiKey, config.model.name, config.model.timeout);

const CONTEXT_ONBOARDING_SYSTEM_PROMPT = `Eres una IA técnica independiente del proyecto FORNEXA.
Vas a recibir un documento de incorporación preparado por GPT y publicado por una persona autorizada en Slack.

Esta es una fase de adquisición de contexto, no una revisión del producto. Tu única tarea es formular preguntas que reduzcan incertidumbre antes de colaborar.

Reglas obligatorias:
- No analices, valores, recomiendes ni critiques FORNEXA todavía.
- No emitas conclusiones legales ni técnicas.
- No propongas código, arquitectura ni soluciones.
- No repitas ni resumas el documento salvo una frase mínima necesaria para contextualizar una pregunta.
- Pregunta por lagunas verificables de negocio, usuarios, operaciones, normativa, evidencia, infraestructura, seguridad, despliegue, datos, integraciones y gobernanza entre GPT, Claude y DeepSeek.
- Si una conexión adicional puede ser útil, pregunta por ella e indica qué evidencia permitiría consultar; no solicites secretos, tokens, contraseñas ni valores sensibles.
- Separa las preguntas en P0 (imprescindibles), P1 (importantes) y P2 (deseables).
- Formula preguntas concretas, numeradas y contestables. Evita duplicados.
- Termina indicando qué artefactos o accesos de solo lectura aportarían mayor contexto, sin afirmar que ya existen.
- Escribe en español.

La primera línea de tu respuesta debe ser exactamente:
DEEPSEEK — FASE 0: PREGUNTAS PARA COMPLETAR CONTEXTO`;

const tools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_full_file",
      description:
        "Devuelve el contenido completo (no solo el hunk del diff) de un fichero del repositorio en un ref concreto.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Ruta del fichero, p.ej. lib/memorandum.ts" },
          ref: { type: "string", description: "SHA o rama exacta que se está revisando" },
        },
        required: ["path", "ref"],
      },
    },
  },
];

async function runReview(messages: ChatCompletionMessageParam[], head: string): Promise<string> {
  return runCapabilities(adapter, messages, [{ definition: tools[0], execute: async args => {
    if (typeof args.path !== 'string' || !safePath(args.path)) throw new Error('Invalid read path');
    return getFullFileAtRef(args.path, head);
  } }]);
}

export async function reviewPR(
  ctx: PRContext,
  mode: "SEGUNDA_REVISION" | "ARBITRAJE",
  arbitrationContext?: string,
  requestInstructions?: string
): Promise<string> {
  return runReview([
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: buildUserPrompt({
        prNumber: ctx.number,
        title: ctx.title,
        headSha: ctx.headSha,
        diffText: ctx.diffText,
        changedFiles: ctx.changedFiles,
        checks: ctx.checks,
        mode,
        arbitrationContext,
        requestInstructions,
      }),
    },
  ], ctx.headSha);
}

export async function reviewRepository(
  ctx: RefContext,
  requestInstructions: string
): Promise<string> {
  return runReview([
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: buildRepositoryReviewPrompt({
        ref: ctx.ref,
        headSha: ctx.headSha,
        headMessage: ctx.headMessage,
        recentCommits: ctx.recentCommits,
        checks: ctx.checks,
        requestInstructions,
      }),
    },
  ], ctx.headSha);
}

export async function runContextOnboarding(context: string): Promise<string> {
  if (!supportsLegacyOnboarding(config.model.provider)) throw new Error("Legacy onboarding belongs to DeepSeek");
  const message = await adapter.complete([
    { role: "system", content: CONTEXT_ONBOARDING_SYSTEM_PROMPT },
    { role: "user", content: context },
  ], []);
  return ensureContextResponseMarker(message.content ?? "");
}
