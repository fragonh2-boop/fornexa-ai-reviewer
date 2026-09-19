import { withCheckpoint } from "./checkpoint.js";
import { config } from './config.js';
import { createAdapter } from './providers.js';
import { parseImplementation, proposeImplementation, validateChanges } from './implementation.js';
import { getFullFileAtRef } from './tools/github.js';
import { publishDraft } from './github-write.js';
import { postToThread } from './tools/slack.js';
export async function processImplementation(message: {text: string; user?: string; ts: string; threadTs?: string; botId?: string}): Promise<boolean> {
  const request = parseImplementation(message.text, config.slack.agentLabel);
  if (!request || config.model.provider === 'deepseek') return false;
  const allowed = (process.env.IMPLEMENT_SLACK_USER_IDS ?? '').split(',').map(s => s.trim());
  if (message.botId || !message.user || !allowed.includes(message.user) || (message.threadTs && message.threadTs !== message.ts)) return false;
  const token = process.env.GITHUB_WRITE_TOKEN;
  const directory = process.env.IMPLEMENT_CHECKPOINT_DIR;
  if (process.env.IMPLEMENT_ENABLED !== 'true' || !token || !directory) return false;
  return withCheckpoint(directory, request.id, async (state, save) => {
    if (state.notified) return false;
    if (!state.files) {
      const adapter = createAdapter(config.model.provider, config.model.apiKey, config.model.name, config.model.timeout);
      state.files = await proposeImplementation(adapter, request, getFullFileAtRef);
      await save();
    }
    if (!state.url) { state.url = await publishDraft(token, config.github.owner, config.github.repo, request, validateChanges(state.files, request)); await save(); }
    await postToThread(`${config.slack.agentLabel} — IMPLEMENTACIÓN PREPARADA\nREQUEST: ${request.id}\n${state.url}\nTests/build pendientes de CI; revisión independiente exact-HEAD obligatoria. Sin merge ni deploy.`, message.ts);
    state.notified = true; await save();
    return true;
  });
}
