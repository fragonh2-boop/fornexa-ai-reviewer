import { Octokit } from '@octokit/rest';

export const DEPLOY_REPO = 'fragonh2-boop/fornexa-ai-reviewer';
export const DEPLOY_SERVICE_NAME = 'fornexa-ai-reviewer-gemini';
export const DEPLOY_SERVICE_ID = 'srv-daobas6gekts73bjr5s0';
const SHA = /^[0-9a-f]{40}$/;

export interface DeployRequest {
  head: string;
  ts: string;
  user: string;
}

/** Only an exact root handoff can cause a deployment. Never infer one from prose. */
export function parseDeployRequest(message: {
  text: string; ts: string; user?: string; botId?: string; threadTs?: string;
}, label: string): DeployRequest | null {
  if (message.botId || !message.user || (message.threadTs && message.threadTs !== message.ts)) return null;
  const lines = message.text.trim().split(/\r?\n/).map(line => line.trim());
  if (lines.length !== 4 || lines[0] !== `${label} — ACCIÓN REQUERIDA` ||
      lines[1] !== 'MODE: DEPLOY' || lines[2] !== `TARGET: ${DEPLOY_SERVICE_NAME}`) return null;
  const match = /^HEAD: ([0-9a-f]{40})$/.exec(lines[3]);
  return match ? { head: match[1], ts: message.ts, user: message.user } : null;
}

export function deployApprovalReady(env: NodeJS.ProcessEnv = process.env): boolean {
  const approvers = (env.DEPLOY_APPROVER_SLACK_USER_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  return env.DEPLOY_ENABLED === 'true' && approvers.length > 0 &&
    Boolean(env.DEPLOY_GITHUB_TOKEN && env.DEPLOY_RENDER_API_KEY && env.SLACK_SIGNING_SECRET);
}

export function renderDeployApproverAuthorized(userId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return deployApprovalReady(env) &&
    (env.DEPLOY_APPROVER_SLACK_USER_IDS ?? '').split(',').map(value => value.trim()).includes(userId);
}

type RenderDeploy = { id: string; status: string; commit?: { id?: string } };
type RenderService = { id: string; name: string; branch: string; repo: string };

async function renderJson<T>(apiKey: string, path: string, init: RequestInit = {}, fetcher: typeof fetch = fetch): Promise<T> {
  const response = await fetcher(`https://api.render.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  // Render errors may contain URLs or secret material; never include response bodies in logs or Slack.
  if (!response.ok) throw new Error(`Render API returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

export async function getControlledDeployStatus(params: {
  head: string;
  deployId: string;
  renderApiKey: string;
  fetcher?: typeof fetch;
}): Promise<'pending' | 'live' | 'failed'> {
  if (!SHA.test(params.head) || !/^dep-[a-z0-9]+$/.test(params.deployId)) {
    throw new Error('Invalid controlled deploy status target');
  }
  const recent = await renderJson<Array<{ deploy: RenderDeploy }>>(params.renderApiKey,
    `/services/${DEPLOY_SERVICE_ID}/deploys?limit=20`, {}, params.fetcher ?? fetch);
  const found = recent.find(entry => entry?.deploy?.id === params.deployId)?.deploy;
  if (!found || found.commit?.id !== params.head) throw new Error('Render deployment identity or commit differs from the approval');
  if (found.status === 'live') return 'live';
  if (['build_failed', 'update_failed', 'pre_deploy_failed', 'canceled', 'deactivated'].includes(found.status)) return 'failed';
  return 'pending';
}

export async function triggerControlledDeploy(params: {
  head: string;
  githubToken: string;
  renderApiKey: string;
  fetcher?: typeof fetch;
  github?: Octokit;
}): Promise<{ status: 'already_live' | 'started'; deployId: string }> {
  if (!SHA.test(params.head)) throw new Error('A full lowercase HEAD SHA is required');
  const api = params.github ?? new Octokit({ auth: params.githubToken, request: { timeout: 15_000 } });
  const [owner, repo] = DEPLOY_REPO.split('/');
  const ref = await api.git.getRef({ owner, repo, ref: 'heads/main' });
  if (ref.data.object.sha !== params.head) throw new Error('main HEAD differs from the requested SHA');

  const checks = await api.checks.listForRef({ owner, repo, ref: params.head, per_page: 100 });
  if (checks.data.total_count >= 100) throw new Error('Check list may be incomplete');
  const validation = checks.data.check_runs.filter(check => check.name === 'validate' && check.app?.slug === 'github-actions');
  if (validation.length !== 1 || validation[0].status !== 'completed' || validation[0].conclusion !== 'success') {
    throw new Error('Required validate check is not green on the requested SHA');
  }

  // Recheck just before the deploy. A racing push cannot silently change the requested target.
  const fetcher = params.fetcher ?? fetch;
  const service = await renderJson<RenderService>(params.renderApiKey, `/services/${DEPLOY_SERVICE_ID}`, {}, fetcher);
  if (service.id !== DEPLOY_SERVICE_ID || service.name !== DEPLOY_SERVICE_NAME ||
      service.branch !== 'main' || service.repo.replace(/\.git$/, '') !== `https://github.com/${DEPLOY_REPO}`) {
    throw new Error('Render service identity or source differs from the allowlist');
  }
  const recent = await renderJson<Array<{ deploy: RenderDeploy }>>(params.renderApiKey,
    `/services/${DEPLOY_SERVICE_ID}/deploys?limit=5`, {}, fetcher);
  if (!Array.isArray(recent) || !recent.every(entry => entry?.deploy?.id && entry?.deploy?.status)) {
    throw new Error('Render deploy list is incomplete');
  }
  for (const entry of recent) {
    if (['created', 'build_in_progress', 'update_in_progress', 'pre_deploy_in_progress'].includes(entry.deploy.status)) {
      throw new Error('A deployment is already in progress');
    }
  }
  if (recent[0]?.deploy.status === 'live' && recent[0].deploy.commit?.id === params.head) {
    return { status: 'already_live', deployId: recent[0].deploy.id };
  }
  const latest = await api.git.getRef({ owner, repo, ref: 'heads/main' });
  if (latest.data.object.sha !== params.head) throw new Error('main changed during deployment validation');
  const started = await renderJson<RenderDeploy>(params.renderApiKey,
    `/services/${DEPLOY_SERVICE_ID}/deploys`, { method: 'POST', body: JSON.stringify({ commitId: params.head }) }, fetcher);
  if (!/^dep-[a-z0-9]+$/.test(started.id ?? '')) throw new Error('Render returned no valid deploy ID');
  return { status: 'started', deployId: started.id };
}
