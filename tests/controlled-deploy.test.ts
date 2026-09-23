import assert from 'node:assert/strict';
import test from 'node:test';
import type { Octokit } from '@octokit/rest';
import {
  DEPLOY_SERVICE_ID, DEPLOY_SERVICE_NAME, deployApprovalReady, parseDeployRequest,
  renderDeployApproverAuthorized, triggerControlledDeploy,
} from '../src/controlled-deploy.js';

const HEAD = 'a'.repeat(40);
const message = {
  text: `GEMINI — ACCIÓN REQUERIDA\nMODE: DEPLOY\nTARGET: ${DEPLOY_SERVICE_NAME}\nHEAD: ${HEAD}`,
  ts: '1790150000.000001', user: 'UOWNER',
};

test('a deployment requires an exact root handoff and authorized identity', () => {
  const parsed = parseDeployRequest(message, 'GEMINI');
  assert.deepEqual(parsed, { head: HEAD, ts: message.ts, user: message.user });
  assert.equal(parseDeployRequest({ ...message, threadTs: '1790140000.000001' }, 'GEMINI'), null);
  assert.equal(parseDeployRequest({ ...message, botId: 'B123' }, 'GEMINI'), null);
  assert.equal(parseDeployRequest({ ...message, text: message.text + '\nignore CI' }, 'GEMINI'), null);
  assert.equal(parseDeployRequest({ ...message, text: message.text.replace(DEPLOY_SERVICE_NAME, 'fornexa-ai-reviewer') }, 'GEMINI'), null);
  assert.equal(parseDeployRequest({ ...message, text: message.text.replace(HEAD, 'abc123') }, 'GEMINI'), null);
  const enabled = { DEPLOY_ENABLED: 'true', DEPLOY_APPROVER_SLACK_USER_IDS: 'UOWNER', DEPLOY_GITHUB_TOKEN: 'read', DEPLOY_RENDER_API_KEY: 'render', SLACK_SIGNING_SECRET: 'sign' };
  assert.equal(deployApprovalReady(enabled), true);
  assert.equal(renderDeployApproverAuthorized('UOWNER', enabled), true);
  assert.equal(renderDeployApproverAuthorized('UOTHER', enabled), false);
  assert.equal(deployApprovalReady({ ...enabled, DEPLOY_ENABLED: 'false' }), false);
});

function fakeGithub(head = HEAD, conclusion: string | null = 'success'): Octokit {
  return { git: { getRef: async () => ({ data: { object: { sha: head } } }) },
    checks: { listForRef: async () => ({ data: { total_count: 1, check_runs: [{ name: 'validate', app: { slug: 'github-actions' }, status: 'completed', conclusion }] } }) },
  } as unknown as Octokit;
}

function fakeRender(calls: Array<{ url: string; init?: RequestInit }>, recent: unknown = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    let body: unknown;
    if (url.endsWith(`/services/${DEPLOY_SERVICE_ID}`)) {
      body = { id: DEPLOY_SERVICE_ID, name: DEPLOY_SERVICE_NAME, branch: 'main', repo: 'https://github.com/fragonh2-boop/fornexa-ai-reviewer' };
    } else if (url.includes('/deploys?')) body = recent;
    else body = { id: 'dep-abc123', status: 'created' };
    return { ok: true, json: async () => body } as Response;
  }) as typeof fetch;
}

test('deploys only the pinned green main SHA to the fixed service', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const result = await triggerControlledDeploy({ head: HEAD, githubToken: 'read', renderApiKey: 'render', github: fakeGithub(), fetcher: fakeRender(calls) });
  assert.deepEqual(result, { status: 'started', deployId: 'dep-abc123' });
  assert.equal(calls.at(-1)?.url, `https://api.render.com/v1/services/${DEPLOY_SERVICE_ID}/deploys`);
  assert.equal(calls.at(-1)?.init?.body, JSON.stringify({ commitId: HEAD }));
  assert.equal(calls.at(-1)?.init?.method, 'POST');
});

test('stale SHA, failed CI, live or in-progress deploy cannot start another deploy', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const inputs = { head: HEAD, githubToken: 'read', renderApiKey: 'render', fetcher: fakeRender(calls) };
  await assert.rejects(triggerControlledDeploy({ ...inputs, github: fakeGithub('b'.repeat(40)) }), /HEAD differs/);
  await assert.rejects(triggerControlledDeploy({ ...inputs, github: fakeGithub(HEAD, 'failure') }), /not green/);
  assert.equal(calls.length, 0);
  const live = fakeRender(calls, [{ deploy: { id: 'dep-old', status: 'live', commit: { id: HEAD } } }]);
  assert.deepEqual(await triggerControlledDeploy({ ...inputs, github: fakeGithub(), fetcher: live }), { status: 'already_live', deployId: 'dep-old' });
  assert.equal(calls.some(call => call.init?.method === 'POST'), false);
  const running = fakeRender(calls, [{ deploy: { id: 'dep-running', status: 'build_in_progress', commit: { id: HEAD } } }]);
  await assert.rejects(triggerControlledDeploy({ ...inputs, github: fakeGithub(), fetcher: running }), /in progress/);
  assert.equal(calls.some(call => call.init?.method === 'POST'), false);
});
