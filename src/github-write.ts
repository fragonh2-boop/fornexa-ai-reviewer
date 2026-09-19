import { Octokit } from '@octokit/rest';
import { validateChanges, type ImplementationRequest, type FileChange } from './implementation.js';
/** Dedicated repository-scoped credential. Never reuse the read token as a fallback. */
export async function publishDraft(token: string, owner: string, repo: string, request: ImplementationRequest, files: FileChange[], client?: Octokit): Promise<string> {
  validateChanges(files, request);
  const api = client ?? new Octokit({ auth: token, request: { timeout: 30_000 } });
  const branch = `ai/implement-${request.id}`;
  const existing = await api.pulls.list({ owner, repo, head: `${owner}:${branch}`, state: 'all' });
  if (existing.data.length) return existing.data[0].html_url;
  const base = await api.git.getRef({ owner, repo, ref: 'heads/main' });
  if (base.data.object.sha !== request.head) throw new Error('Base HEAD changed; request a new task');
  const commit = await api.git.getCommit({ owner, repo, commit_sha: request.head });
  const snapshot = await api.git.getTree({ owner, repo, tree_sha: commit.data.tree.sha, recursive: '1' });
  if (snapshot.data.truncated) throw new Error('Repository tree incomplete');
  for (const file of files) {
    for (const entry of snapshot.data.tree) {
      if ((entry.path === file.path || file.path.startsWith(`${entry.path}/`)) && !['100644', '100755', '040000'].includes(entry.mode ?? '')) throw new Error('Unsafe tree entry');
    }
  }
  const tree = await api.git.createTree({ owner, repo, base_tree: commit.data.tree.sha,
    tree: files.map(f => ({ path: f.path, mode: (snapshot.data.tree.find(e => e.path === f.path)?.mode === '100755' ? '100755' : '100644') as '100644' | '100755', type: 'blob' as const, content: f.content })) });
  const created = await api.git.createCommit({ owner, repo, message: `AI implementation ${request.id}`, tree: tree.data.sha, parents: [request.head] });
  try { await api.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: created.data.sha }); }
  catch (error) {
    if ((error as { status?: number }).status !== 422) throw error;
    const ref = await api.git.getRef({ owner, repo, ref: `heads/${branch}` });
    const previous = await api.git.getCommit({ owner, repo, commit_sha: ref.data.object.sha });
    if (previous.data.tree.sha !== tree.data.sha || previous.data.parents.length !== 1 || previous.data.parents[0].sha !== request.head) throw new Error('Recovery branch differs; manual reconciliation required');
  }
  const pr = await api.pulls.create({ owner, repo, head: branch, base: 'main', draft: true,
    title: `AI implementation ${request.id}`, body: `Risk: HIGH (default).\n\nTask: ${request.task}\n\nAcceptance: ${request.acceptance}\n\nBase: ${request.head}\n\nTests/build NOT executed by this service. CI and independent exact-HEAD review required under docs/ai/HANDOFF.md. No merge/deploy authorization.` });
  return pr.data.html_url;
}
