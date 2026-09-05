import OpenAI from "openai";
import type { ChatCompletionTool, ChatCompletionMessageParam } from "openai/resources/index.js";
import { config } from "./config.js";
import { getFullFileAtRef, type PRContext } from "./tools/github.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.js";

const client = new OpenAI({
  apiKey: config.deepseek.apiKey,
  baseURL: config.deepseek.baseURL,
});

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
