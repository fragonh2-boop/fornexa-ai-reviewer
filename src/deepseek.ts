import OpenAI from "openai";
import type { ChatCompletionTool, ChatCompletionMessageParam } from "openai/resources/index.js";
import { config } from "./config.js";
import { getFullFileAtRef, type PRContext } from "./tools/github.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.js";
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

// Únicas herramientas expuestas al modelo: lectura de un fichero completo.
// Deliberadamente NO existe ninguna tool de escritura/merge/deploy: el modelo
// no puede invocar lo que no está definido aquí, sea cual sea el prompt.
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
          path: { type: "string", description: "Ruta del fichero, p.ej. app/api/regulatory/route.ts" },
          ref: { type: "string", description: "SHA o rama, normalmente el HEAD de la PR" },
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

export async function reviewPR(
  ctx: PRContext,
  mode: "SEGUNDA_REVISION" | "ARBITRAJE",
  arbitrationContext?: string
): Promise<string> {
  const messages: ChatCompletionMessageParam[] = [
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
      }),
    },
  ];

  // Bucle de tool-calling: como máximo unas pocas idas y vueltas para pedir
  // ficheros completos antes de que el modelo entregue el veredicto final.
  const MAX_TOOL_ROUNDS = 6;
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
