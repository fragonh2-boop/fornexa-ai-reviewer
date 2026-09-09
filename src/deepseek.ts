import OpenAI from "openai";
import type { ChatCompletionTool, ChatCompletionMessageParam } from "openai/resources/index.js";
import { config } from "./config.js";
import { getFullFileAtRef, type PRContext, type RefContext } from "./tools/github.js";
import { SYSTEM_PROMPT, buildRepositoryReviewPrompt, buildUserPrompt } from "./prompt.js";
import { ensureContextResponseMarker } from "./context-onboarding.js";

const client = new OpenAI({
  apiKey: config.deepseek.apiKey,
  baseURL: config.deepseek.baseURL,
});

const CONTEXT_ONBOARDING_SYSTEM_PROMPT = `Eres DeepSeek, tercera IA técnica del proyecto FORNEXA.
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

async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (name === "get_full_file") {
    try {
      return await getFullFileAtRef(String(args.path), String(args.ref));
    } catch (err) {
      return `ERROR leyendo el fichero: ${(err as Error).message}`;
    }
  }
  return `ERROR: herramienta desconocida "${name}"`;
}

async function runReview(messages: ChatCompletionMessageParam[]): Promise<string> {
  const MAX_TOOL_ROUNDS = 8;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const completion = await client.chat.completions.create({
      model: config.deepseek.model,
      messages,
      tools,
      temperature: 0.2,
    });

    const choice = completion.choices[0];
    const message = choice.message;

    if (!message.tool_calls || message.tool_calls.length === 0) {
      return message.content ?? "(el modelo no devolvió contenido)";
    }

    messages.push(message);
    for (const call of message.tool_calls) {
      const args = JSON.parse(call.function.arguments || "{}");
      const result = await runTool(call.function.name, args);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
  }

  return "(se alcanzó el límite de rondas de herramientas sin veredicto final; revisar manualmente)";
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
  ]);
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
  ]);
}

export async function runContextOnboarding(context: string): Promise<string> {
  const completion = await client.chat.completions.create({
    model: config.deepseek.model,
    messages: [
      { role: "system", content: CONTEXT_ONBOARDING_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Documento de incorporación de FORNEXA:\n\n${context}`,
      },
    ],
    temperature: 0.15,
    max_tokens: 8000,
  });

  return ensureContextResponseMarker(
    completion.choices[0]?.message.content ?? "(el modelo no devolvió contenido)"
  );
}
