import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APPROVAL_ACTION_IDS,
  createDeploymentApprovalToken,
  parseDeploymentApprovalToken,
  parseSlackDeploymentInteraction,
} from '../src/deployment-approval.js';

const approval = {
  mode: 'render' as const,
  head: 'a'.repeat(40),
  threadTs: '1790190000.000001',
  expiresAt: 1_790_200_000_000,
};

test('deployment approval is bound to mode, exact HEAD, thread and expiry', () => {
  const token = createDeploymentApprovalToken(approval, 'slack-signing-secret');
  assert.deepEqual(parseDeploymentApprovalToken(token, 'slack-signing-secret', approval.expiresAt - 1), approval);
  assert.equal(parseDeploymentApprovalToken(token, 'other-secret', approval.expiresAt - 1), null);
  assert.equal(parseDeploymentApprovalToken(token, 'slack-signing-secret', approval.expiresAt + 1), null);
  const [payload, signature] = token.split('.');
  assert.equal(parseDeploymentApprovalToken(`${payload}x.${signature}`, 'slack-signing-secret', approval.expiresAt - 1), null);
});

test('only a single well-formed Slack block action becomes an approval interaction', () => {
  const body = new URLSearchParams({ payload: JSON.stringify({
    type: 'block_actions',
    user: { id: 'UOWNER' },
    channel: { id: 'C0BT661FYLW' },
    actions: [{ action_id: APPROVAL_ACTION_IDS.render, value: 'signed.token' }],
  }) }).toString();
  assert.deepEqual(parseSlackDeploymentInteraction(body), {
    userId: 'UOWNER', channelId: 'C0BT661FYLW',
    actionId: APPROVAL_ACTION_IDS.render, token: 'signed.token',
  });
  assert.equal(parseSlackDeploymentInteraction('payload=%7Bbad'), null);
});
