import assert from 'node:assert/strict';
import test from 'node:test';

test('ordinary Slack conversations cannot invoke the local sidecar', async () => {
  process.env.DEEPSEEK_API_KEY ||= 'test-key';
  process.env.SLACK_BOT_TOKEN ||= 'xoxb-test';
  process.env.GITHUB_TOKEN ||= 'test-token';

  const { conversationTools, SLACK_CONVERSATION_SYSTEM_PROMPT } = await import('../src/agent.js');
  const names = conversationTools.map((tool) => tool.function.name);

  assert.deepEqual(names, ['get_current_weather', 'fetch_web_content']);
  assert.equal(names.includes('query_local_antigravity'), false);
  assert.match(SLACK_CONVERSATION_SYSTEM_PROMPT, /aprobación humana firmada en Slack/);
});
