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
