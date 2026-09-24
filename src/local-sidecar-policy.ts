export function parseDirectSidecarPrompt(prompt: string): string | null {
  const match = /^[\s:;,.-]*usa\s+query_local_antigravity\s+para\s+([\s\S]+)$/i.exec(prompt.trim());
  const task = match?.[1]?.trim();
  return task ? task : null;
}

export function sidecarApprovalReady(env: NodeJS.ProcessEnv = process.env): boolean {
  const approvers = (env.SIDECAR_APPROVER_SLACK_USER_IDS ?? "")
    .split(',').map(value => value.trim()).filter(Boolean);
  return env.SIDECAR_APPROVAL_ENABLED === "true" && approvers.length > 0 &&
    approvers.every(value => /^U[A-Z0-9]+$/.test(value)) &&
    Boolean(env.SIDECAR_AUTH_TOKEN && env.SLACK_SIGNING_SECRET &&
      (env.APPROVAL_HMAC_SECRET?.length ?? 0) >= 32);
}

export function sidecarApproverAuthorized(
  userId: string,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return /^U[A-Z0-9]+$/.test(userId) && sidecarApprovalReady(env) &&
    (env.SIDECAR_APPROVER_SLACK_USER_IDS ?? "")
      .split(',').map(value => value.trim()).includes(userId);
}

export function isSafeSidecarReadPath(relativePath: string): boolean {
  if (!/^[A-Za-z0-9_./-]+$/.test(relativePath) ||
      relativePath.split('/').some(part => !part || part === '.' || part === '..')) return false;
  if (/(^|\/)(?:\.git|\.env[^/]*|node_modules|\.npmrc|\.netrc|\.ssh|\.aws|secrets?)(\/|$)/i.test(relativePath)) return false;
  const name = relativePath.split('/').at(-1)!.toLowerCase();
  if (/(?:\.pem|\.key|\.p12|\.pfx|\.tfvars|id_rsa|id_ed25519|credentials(?:\.json)?|service-account\.json|\.pgpass|kubeconfig|database\.ya?ml|docker-compose(?:\.[^.]+)?\.ya?ml|(?:^|[._-])(?:token|password|passwd|secret)(?:[._-]|$))/.test(name)) return false;
  if (/^(?:package(?:-lock)?\.json|tsconfig(?:\.[a-z0-9_-]+)?\.json)$/i.test(name)) return true;
  return /\.(?:md|txt|ts|tsx|js|jsx|mjs|cjs|css|html|sql|py|go|rs|java|kt|swift)$/i.test(name);
}
