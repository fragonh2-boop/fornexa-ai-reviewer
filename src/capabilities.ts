import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/index.js';
import type { ModelAdapter } from './providers.js';
export interface Capability { definition: ChatCompletionTool; execute(args: Record<string, unknown>): Promise<string> }
/** Provider-independent execution and budgets. Only supplied capabilities can run. */
export async function runCapabilities(adapter: ModelAdapter, messages: ChatCompletionMessageParam[], capabilities: Capability[]): Promise<string> {
  let bytes = Buffer.byteLength(JSON.stringify(messages));
  for (let round = 0; round < 8; round++) {
    if (bytes > 500_000) throw new Error('Context budget exceeded');
    const message = await adapter.complete(messages, capabilities.map(c => c.definition));
    bytes += Buffer.byteLength(JSON.stringify(message));
    if (!message.tool_calls?.length) {
      if (!message.content?.trim()) throw new Error('Empty provider response');
      return message.content;
    }
    if (message.tool_calls.length > 20) throw new Error('Tool budget exceeded');
    messages.push(message);
    const ids = new Set<string>();
    for (const call of message.tool_calls) {
      if (!call.id || ids.has(call.id)) throw new Error('Invalid tool call identity');
      ids.add(call.id);
      const capability = capabilities.find(c => c.definition.function.name === call.function.name);
      const args: unknown = JSON.parse(call.function.arguments);
      if (!capability || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid tool call');
      const content = await capability.execute(args as Record<string, unknown>);
      if (Buffer.byteLength(content) > 100_000) throw new Error('File budget exceeded');
      bytes += Buffer.byteLength(content);
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }
  throw new Error('Tool budget exhausted');
}
