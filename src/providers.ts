import OpenAI, { type ClientOptions } from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool, ChatCompletionMessage } from 'openai/resources/index.js';
export type ProviderName = 'gpt' | 'claude' | 'gemini' | 'deepseek';
export interface ModelAdapter {
  complete(messages: ChatCompletionMessageParam[], tools: ChatCompletionTool[]): Promise<ChatCompletionMessage>;
}
export const endpoints: Record<ProviderName, string> = {
  gpt: 'https://api.openai.com/v1',
  claude: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  deepseek: 'https://api.deepseek.com',
};
/** Shared function-calling transport; no repository permissions live in adapters. */
export function createAdapter(provider: ProviderName, apiKey: string, model: string, timeout: number, fetch?: ClientOptions["fetch"]): ModelAdapter {
  const client = new OpenAI({ apiKey, baseURL: endpoints[provider], timeout, maxRetries: 0, fetch });
  return {
    async complete(messages, tools) {
      const result = await client.chat.completions.create({ model, messages,
        ...(tools.length ? { tools } : {}), max_tokens: 8192 });
      const choice = result.choices?.[0];
      if (!choice || !['stop', 'tool_calls'].includes(choice.finish_reason)) {
        throw new Error('Incomplete or rejected provider response');
      }
      const message = choice.message;
      if (!message || (!message.content?.trim() && !message.tool_calls?.length)) throw new Error('Empty provider response');
      return message;
    },
  };
}

export function supportsLegacyOnboarding(provider: ProviderName): boolean { return provider === "deepseek"; }
