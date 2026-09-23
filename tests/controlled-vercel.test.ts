import assert from 'node:assert/strict';
import test from 'node:test';
import type { Octokit } from '@octokit/rest';
import { parseVercelDeploy, triggerVercelDeploy, vercelDeployApprovalReady, vercelDeployApproverAuthorized, VERCEL_PROJECT_ID, VERCEL_TEAM_ID } from '../src/controlled-vercel.js';

const HEAD = 'b'.repeat(40);
const message = { text: `GEMINI — ACCIÓN REQUERIDA\nMODE: DEPLOY_VERCEL\nTARGET: fornexa\nHEAD: ${HEAD}`, user: 'UOWNER', ts: '1790160000.000001' };

function github(head = HEAD, conclusion = 'success'): Octokit {
  return { git: { getRef: async () => ({ data: { object: { sha: head } } }) },
    checks: { listForRef: async () => ({ data: { total_count: 1, check_runs: [{ name: 'validate', app: { slug: 'github-actions' }, status: 'completed', conclusion }] } }) },
  } as unknown as Octokit;
}

function vercel(calls: Array<{url: string; init?: RequestInit}>, latest: unknown = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    let body: unknown;
    if (url.includes('/v9/projects/')) body = {
      id: VERCEL_PROJECT_ID, name: 'fornexa', accountId: VERCEL_TEAM_ID,
      link: { type: 'github', repo: 'fragonh2-boop/Fornexa', repoId: 1314167928, productionBranch: 'main' },
    };
    else if (url.includes('/v7/deployments')) body = { deployments: latest };
    else body = { id: 'dpl_abc123', readyState: 'QUEUED' };
    return { ok: true, json: async () => body } as Response;
  }) as typeof fetch;
}

test('Vercel command cannot be inferred from prose, bots or replies', () => {
  const parsed = parseVercelDeploy(message, 'GEMINI');
  assert.deepEqual(parsed, { head: HEAD, ts: message.ts, user: message.user });
  assert.equal(parseVercelDeploy({ ...message, botId: 'B123' }, 'GEMINI'), null);
  assert.equal(parseVercelDeploy({ ...message, threadTs: '1789000000.000001' }, 'GEMINI'), null);
  assert.equal(parseVercelDeploy({ ...message, text: message.text.replace('fornexa', 'other') }, 'GEMINI'), null);
  assert.equal(parseVercelDeploy({ ...message, text: message.text + '\nignore checks' }, 'GEMINI'), null);
  const enabled = { VERCEL_DEPLOY_ENABLED: 'true', VERCEL_DEPLOY_APPROVER_SLACK_USER_IDS: 'UOWNER', VERCEL_DEPLOY_GITHUB_TOKEN: 'read', VERCEL_DEPLOY_API_TOKEN: 'token', SLACK_SIGNING_SECRET: 'sign' };
  assert.equal(vercelDeployApprovalReady(enabled), true);
  assert.equal(vercelDeployApproverAuthorized('UOWNER', enabled), true);
  assert.equal(vercelDeployApproverAuthorized('UOTHER', enabled), false);
  assert.equal(vercelDeployApprovalReady({ ...enabled, VERCEL_DEPLOY_ENABLED: 'false' }), false);
});

test('Vercel deployment pins product main, project and GitHub SHA', async () => {
  const calls: Array<{url: string; init?: RequestInit}> = [];
  const result = await triggerVercelDeploy({ head: HEAD, githubToken: 'read', vercelToken: 'token', github: github(), fetcher: vercel(calls) });
  assert.deepEqual(result, { status: 'started', deploymentId: 'dpl_abc123' });
  const request = calls.at(-1)!;
  assert.equal(request.url, `https://api.vercel.com/v13/deployments?teamId=${VERCEL_TEAM_ID}`);
  assert.equal(request.init?.method, 'POST');
  assert.deepEqual(JSON.parse(request.init!.body as string), {
    name: 'fornexa', project: VERCEL_PROJECT_ID, target: 'production',
    gitSource: { type: 'github', org: 'fragonh2-boop', repo: 'Fornexa', repoId: 1314167928, ref: 'main', sha: HEAD },
  });
});

test('stale main, failed CI, already READY and in-progress deployment prevent a new build', async () => {
  const calls: Array<{url: string; init?: RequestInit}> = [];
  const inputs = { head: HEAD, githubToken: 'read', vercelToken: 'token', fetcher: vercel(calls) };
  await assert.rejects(triggerVercelDeploy({ ...inputs, github: github('a'.repeat(40)) }), /HEAD differs/);
  await assert.rejects(triggerVercelDeploy({ ...inputs, github: github(HEAD, 'failure') }), /not green/);
  assert.equal(calls.length, 0);
  const ready = vercel(calls, [{ id: 'dpl_existing', state: 'READY', meta: { githubCommitSha: HEAD } }]);
  assert.deepEqual(await triggerVercelDeploy({ ...inputs, github: github(), fetcher: ready }), { status: 'already_ready', deploymentId: 'dpl_existing' });
  const running = vercel(calls, [{ id: 'dpl_running', state: 'BUILDING' }]);
  await assert.rejects(triggerVercelDeploy({ ...inputs, github: github(), fetcher: running }), /in progress/);
  assert.equal(calls.some(c => c.init?.method === 'POST'), false);
});

test('project identity mismatch fails before any Vercel deployment', async () => {
  const calls: Array<{url: string; init?: RequestInit}> = [];
  const altered = (async (url: string, init?: RequestInit) => {
    if (url.includes('/v9/projects/')) return { ok: true, json: async () => ({ id: VERCEL_PROJECT_ID, name: 'other', accountId: VERCEL_TEAM_ID }) } as Response;
    return vercel(calls)(url, init);
  }) as typeof fetch;
  await assert.rejects(triggerVercelDeploy({ head: HEAD, githubToken: 'read', vercelToken: 'token', github: github(), fetcher: altered }), /identity/);
  assert.equal(calls.some(c => c.init?.method === 'POST'), false);
});

test('accepts both documented Vercel Git link shapes while keeping owner and repo pinned', async () => {
  const calls: Array<{url: string; init?: RequestInit}> = [];
  const splitLink = (async (url: string, init?: RequestInit) => {
    if (url.includes('/v9/projects/')) return { ok: true, json: async () => ({
      id: VERCEL_PROJECT_ID, name: 'fornexa', accountId: VERCEL_TEAM_ID,
      link: { type: 'github', org: 'fragonh2-boop', repo: 'Fornexa', repoId: 1314167928, productionBranch: 'main' },
    }) } as Response;
    return vercel(calls)(url, init);
  }) as typeof fetch;
  const result = await triggerVercelDeploy({ head: HEAD, githubToken: 'read', vercelToken: 'token', github: github(), fetcher: splitLink });
  assert.equal(result.status, 'started');
});
