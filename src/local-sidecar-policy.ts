export function parseDirectSidecarPrompt(prompt: string): string | null {
  const match = /^[\s:;,.-]*usa\s+query_local_antigravity\s+para\s+([\s\S]+)$/i.exec(prompt.trim());
  const task = match?.[1]?.trim();
  return task ? task : null;
}

export function isAuthorizedSidecarUser(userId: string, allowlist: string): boolean {
  if (!/^U[A-Z0-9]+$/.test(userId)) return false;
  return allowlist.split(',').map(value => value.trim()).filter(Boolean).includes(userId);
}

export function isSafeSidecarReadPath(relativePath: string): boolean {
  if (!/^[A-Za-z0-9_./-]+$/.test(relativePath) ||
      relativePath.split('/').some(part => !part || part === '.' || part === '..')) return false;
  if (/(^|\/)(?:\.git|\.env[^/]*|node_modules|\.npmrc|\.netrc|\.ssh|\.aws|secrets?)(\/|$)/i.test(relativePath)) return false;
  const name = relativePath.split('/').at(-1)!.toLowerCase();
  return !/(?:\.pem|\.key|\.p12|\.pfx|id_rsa|id_ed25519|credentials(?:\.json)?|service-account\.json|(?:^|[._-])(?:token|password|passwd|secret)(?:[._-]|$))/.test(name);
}
