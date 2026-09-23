import { Octokit } from '@octokit/rest';

const OWNER = 'fragonh2-boop';
const REPO = 'Fornexa';
export const VERCEL_TEAM_ID = 'team_TncTsWvpnA2a3P20ucYJGtg6';
export const VERCEL_PROJECT_ID = 'prj_KxPMaXDQWxFQUiBjnpCSYKFOnlMW';
export const VERCEL_PROJECT_NAME = 'fornexa';
const FULL_SHA = /^[0-9a-f]{40}$/;

export interface VercelDeployRequest { head: string; ts: string; user: string }

export function parseVercelDeploy(message: { text: string; ts: string; user?: string; botId?: string; threadTs?: string }, label: string): VercelDeployRequest | null {
  if (!message.user || message.botId || (message.threadTs && message.threadTs !== message.ts)) return null;
  const lines = message.text.trim().split(/\r?\n/).map(line => line.trim());
  if (lines.length !== 4 || lines[0] !== `${label} — ACCIÓN REQUERIDA` ||
      lines[1] !== 'MODE: DEPLOY_VERCEL' || lines[2] !== `TARGET: ${VERCEL_PROJECT_NAME}`) return null;
  const match = /^HEAD: ([0-9a-f]{40})$/.exec(lines[3]);
  return match ? { head: match[1], ts: message.ts, user: message.user } : null;
}

export function vercelDeployAuthorized(request: VercelDeployRequest, env: NodeJS.ProcessEnv = process.env): boolean {
  return env.VERCEL_DEPLOY_ENABLED === 'true' &&
    (env.VERCEL_DEPLOY_SLACK_USER_IDS ?? '').split(',').map(v => v.trim()).includes(request.user) &&
    Boolean(env.VERCEL_DEPLOY_GITHUB_TOKEN && env.VERCEL_DEPLOY_API_TOKEN) && FULL_SHA.test(request.head);
}

async function vercelJson<T>(token: string, path: string, init: RequestInit, fetcher: typeof fetch): Promise<T> {
  const response = await fetcher(`https://api.vercel.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  // Never echo response bodies, bearer tokens or URLs that may carry access parameters.
  if (!response.ok) throw new Error(`Vercel API returned HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

interface VercelProject {
  id: string; name: string; accountId: string;
  link?: { type?: string; repo?: string; repoId?: number | string; productionBranch?: string };
}
interface VercelDeployment {
  id: string; state?: string; readyState?: string; target?: string;
  meta?: { githubCommitSha?: string; githubRepo?: string; githubOrg?: string };
}

export async function triggerVercelDeploy(params: {
  head: string; githubToken: string; vercelToken: string; github?: Octokit; fetcher?: typeof fetch;
}): Promise<{ status: 'already_ready' | 'started'; deploymentId: string }> {
  if (!FULL_SHA.test(params.head)) throw new Error('A full lowercase HEAD SHA is required');
  const github = params.github ?? new Octokit({ auth: params.githubToken, request: { timeout: 15_000 } });
  const main = await github.git.getRef({ owner: OWNER, repo: REPO, ref: 'heads/main' });
  if (main.data.object.sha !== params.head) throw new Error('Fornexa main HEAD differs from the requested SHA');
  const checks = await github.checks.listForRef({ owner: OWNER, repo: REPO, ref: params.head, per_page: 100 });
  if (checks.data.total_count >= 100) throw new Error('Check list may be incomplete');
  const valid = checks.data.check_runs.filter(c => c.name === 'validate' && c.app?.slug === 'github-actions');
  if (valid.length !== 1 || valid[0].status !== 'completed' || valid[0].conclusion !== 'success') {
    throw new Error('Fornexa CI validate is not green on the requested SHA');
  }

  const fetcher = params.fetcher ?? fetch;
  const suffix = `teamId=${encodeURIComponent(VERCEL_TEAM_ID)}`;
  const project = await vercelJson<VercelProject>(params.vercelToken,
    `/v9/projects/${VERCEL_PROJECT_ID}?${suffix}`, {}, fetcher);
  if (project.id !== VERCEL_PROJECT_ID || project.name !== VERCEL_PROJECT_NAME ||
      project.accountId !== VERCEL_TEAM_ID || project.link?.type !== 'github' ||
      project.link.repo?.toLowerCase() !== `${OWNER}/${REPO}`.toLowerCase() ||
      String(project.link.repoId) !== '1314167928' ||
      (project.link.productionBranch && project.link.productionBranch !== 'main')) {
    throw new Error('Vercel project identity or Git source differs from the allowlist');
  }
  const list = await vercelJson<{ deployments: VercelDeployment[] }>(params.vercelToken,
    `/v7/deployments?${suffix}&projectId=${VERCEL_PROJECT_ID}&target=production&limit=5`, {}, fetcher);
  if (!Array.isArray(list.deployments) || list.deployments.some(d => !d.id || !d.state)) {
    throw new Error('Vercel deployment list is incomplete');
  }
  if (list.deployments.some(d => ['QUEUED', 'INITIALIZING', 'BUILDING'].includes(d.state!))) {
    throw new Error('A Vercel deployment is already in progress');
  }
  if (list.deployments[0]?.state === 'READY' && list.deployments[0].meta?.githubCommitSha === params.head) {
    return { status: 'already_ready', deploymentId: list.deployments[0].id };
  }
  const freshMain = await github.git.getRef({ owner: OWNER, repo: REPO, ref: 'heads/main' });
  if (freshMain.data.object.sha !== params.head) throw new Error('Fornexa main changed during deployment validation');
  const created = await vercelJson<VercelDeployment>(params.vercelToken,
    `/v13/deployments?${suffix}`,
    { method: 'POST', body: JSON.stringify({
      name: VERCEL_PROJECT_NAME, project: VERCEL_PROJECT_ID, target: 'production',
      gitSource: { type: 'github', org: OWNER, repo: REPO, repoId: 1314167928, ref: 'main', sha: params.head },
    }) }, fetcher);
  if (!/^dpl_[a-zA-Z0-9]+$/.test(created.id ?? '')) throw new Error('Vercel returned no valid deployment ID');
  return { status: 'started', deploymentId: created.id };
}
