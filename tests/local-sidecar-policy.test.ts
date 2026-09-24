import assert from 'node:assert/strict';
import test from 'node:test';
import { isSafeSidecarReadPath, parseDirectSidecarPrompt, sidecarApprovalReady, sidecarApproverAuthorized } from '../src/local-sidecar-policy.js';

test('explicit Slack sidecar command is routed without provider interpretation', () => {
  assert.equal(
    parseDirectSidecarPrompt(': usa query_local_antigravity para consultar el estado del repositorio'),
    'consultar el estado del repositorio'
  );
  assert.equal(parseDirectSidecarPrompt('consulta el repositorio local'), null);
  assert.equal(parseDirectSidecarPrompt('usa query_local_antigravity para   '), null);
});

test('local sidecar file reads exclude secrets and traversal', () => {
  for (const path of ['README.md', 'src/index.ts', 'docs/provider-parity.md', 'package.json', 'tsconfig.json']) {
    assert.equal(isSafeSidecarReadPath(path), true);
  }
  for (const path of ['.env', '.env.local', 'config/.env.prod', '.git/config', '../secret', 'node_modules/x', '.npmrc', '.ssh/config', '.aws/credentials', 'secrets/value.txt', 'service-account.json', 'keys/prod.pem', 'config/api-token.txt', '.pgpass', 'kubeconfig', 'prod.tfvars', 'config/database.yml', 'docker-compose.override.yml', 'config/settings.json']) {
    assert.equal(isSafeSidecarReadPath(path), false);
  }
});

test('direct sidecar access requires a signed-interaction configuration and approver allowlist', () => {
  const enabled = { SIDECAR_APPROVAL_ENABLED: 'true', SIDECAR_APPROVER_SLACK_USER_IDS: 'UOWNER, UBACKUP', SIDECAR_AUTH_TOKEN: 'sidecar', SLACK_SIGNING_SECRET: 'slack', APPROVAL_HMAC_SECRET: 'a'.repeat(32) };
  assert.equal(sidecarApprovalReady(enabled), true);
  assert.equal(sidecarApproverAuthorized('UOWNER', enabled), true);
  assert.equal(sidecarApproverAuthorized('UOTHER', enabled), false);
  assert.equal(sidecarApprovalReady({ ...enabled, SIDECAR_APPROVER_SLACK_USER_IDS: '' }), false);
  assert.equal(sidecarApprovalReady({ ...enabled, APPROVAL_HMAC_SECRET: 'short' }), false);
  assert.equal(sidecarApproverAuthorized('invalid', enabled), false);
});
