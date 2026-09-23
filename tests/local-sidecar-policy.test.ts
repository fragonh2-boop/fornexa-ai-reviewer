import assert from 'node:assert/strict';
import test from 'node:test';
import { isAuthorizedSidecarUser, isSafeSidecarReadPath, parseDirectSidecarPrompt } from '../src/local-sidecar-policy.js';

test('explicit Slack sidecar command is routed without provider interpretation', () => {
  assert.equal(
    parseDirectSidecarPrompt(': usa query_local_antigravity para consultar el estado del repositorio'),
    'consultar el estado del repositorio'
  );
  assert.equal(parseDirectSidecarPrompt('consulta el repositorio local'), null);
  assert.equal(parseDirectSidecarPrompt('usa query_local_antigravity para   '), null);
});

test('local sidecar file reads exclude secrets and traversal', () => {
  for (const path of ['README.md', 'src/index.ts', 'docs/provider-parity.md']) {
    assert.equal(isSafeSidecarReadPath(path), true);
  }
  for (const path of ['.env', '.env.local', 'config/.env.prod', '.git/config', '../secret', 'node_modules/x', '.npmrc', '.ssh/config', '.aws/credentials', 'secrets/value.txt', 'service-account.json', 'keys/prod.pem', 'config/api-token.txt']) {
    assert.equal(isSafeSidecarReadPath(path), false);
  }
});

test('direct sidecar access fails closed to an explicit Slack user allowlist', () => {
  assert.equal(isAuthorizedSidecarUser('UOWNER', 'UOWNER, UBACKUP'), true);
  assert.equal(isAuthorizedSidecarUser('UOTHER', 'UOWNER, UBACKUP'), false);
  assert.equal(isAuthorizedSidecarUser('UOWNER', ''), false);
  assert.equal(isAuthorizedSidecarUser('invalid', 'invalid'), false);
});
