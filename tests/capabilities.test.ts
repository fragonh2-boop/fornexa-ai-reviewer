import assert from "node:assert/strict";
import test from "node:test";
import type {
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/index.js";
import { runCapabilities, type Capability } from "../src/capabilities.js";
import type { ModelAdapter } from "../src/providers.js";

function fakeAdapter(responses: ChatCompletionMessage[]): ModelAdapter {
  let call = 0;
  return {
    async complete() {
      const message = responses[call];
      call += 1;
      return message;
    },
  };
}

function toolCallMessage(name: string): ChatCompletionMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: "{}" } }],
  } as unknown as ChatCompletionMessage;
}

const finalMessage = { role: "assistant", content: "veredicto final" } as ChatCompletionMessage;

function toolDefinitionFor(name: string): ChatCompletionTool {
  return {
    type: "function",
    function: { name, description: "test", parameters: { type: "object", properties: {} } },
  };
}

test("un fallo de la capacidad no aborta la revisión: se devuelve como contenido del tool result", async () => {
  const adapter = fakeAdapter([toolCallMessage("boom"), finalMessage]);
  const capability: Capability = {
    definition: toolDefinitionFor("boom"),
    execute: async () => {
      throw new Error("fichero.ts no es un fichero de texto en abc123");
    },
  };
  const messages: ChatCompletionMessageParam[] = [{ role: "user", content: "revisa" }];

  const result = await runCapabilities(adapter, messages, [capability]);

  assert.equal(result, "veredicto final");
  const toolMessage = messages.find((m) => m.role === "tool");
  assert.ok(toolMessage);
  assert.equal(
    (toolMessage as { content: string }).content,
    "Error: fichero.ts no es un fichero de texto en abc123"
  );
});

test("una capacidad que funciona sigue devolviendo su contenido tal cual", async () => {
  const adapter = fakeAdapter([toolCallMessage("ok"), finalMessage]);
  const capability: Capability = {
    definition: toolDefinitionFor("ok"),
    execute: async () => "contenido real",
  };
  const messages: ChatCompletionMessageParam[] = [{ role: "user", content: "revisa" }];

  const result = await runCapabilities(adapter, messages, [capability]);

  assert.equal(result, "veredicto final");
  const toolMessage = messages.find((m) => m.role === "tool");
  assert.equal((toolMessage as { content: string }).content, "contenido real");
});

test("admite mensajes de contexto mayores a 500 KB hasta el presupuesto por defecto de 2 MB", async () => {
  const adapter = fakeAdapter([finalMessage]);
  // 600 KB payload (greater than old 500_000 byte limit, under 2 MB limit)
  const bigContent = "a".repeat(600_000);
  const messages: ChatCompletionMessageParam[] = [{ role: "user", content: bigContent }];

  const result = await runCapabilities(adapter, messages, []);
  assert.equal(result, "veredicto final");
});

test("lanza 'Context budget exceeded' cuando el mensaje supera el presupuesto", async () => {
  const adapter = fakeAdapter([finalMessage]);
  // Exceeds 2 MB default limit
  const hugeContent = "x".repeat(2_100_000);
  const messages: ChatCompletionMessageParam[] = [{ role: "user", content: hugeContent }];

  await assert.rejects(
    async () => runCapabilities(adapter, messages, []),
    /Context budget exceeded/
  );
});

test("admite resultados de herramientas entre 100 KB y 500 KB", async () => {
  const adapter = fakeAdapter([toolCallMessage("mid_payload"), finalMessage]);
  const capability: Capability = {
    definition: toolDefinitionFor("mid_payload"),
    execute: async () => "y".repeat(250_000), // 250 KB > old 100 KB limit, <= 500 KB
  };
  const messages: ChatCompletionMessageParam[] = [{ role: "user", content: "revisa" }];

  const result = await runCapabilities(adapter, messages, [capability]);
  assert.equal(result, "veredicto final");
});

test("lanza 'File budget exceeded' cuando una herramienta supera 500 KB", async () => {
  const adapter = fakeAdapter([toolCallMessage("oversized_payload"), finalMessage]);
  const capability: Capability = {
    definition: toolDefinitionFor("oversized_payload"),
    execute: async () => "z".repeat(500 * 1024 + 10),
  };
  const messages: ChatCompletionMessageParam[] = [{ role: "user", content: "revisa" }];

  await assert.rejects(
    async () => runCapabilities(adapter, messages, [capability]),
    /File budget exceeded/
  );
});
