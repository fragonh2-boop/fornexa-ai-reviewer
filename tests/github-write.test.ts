import test from 'node:test';
import assert from 'node:assert/strict';
import { publishDraft } from '../src/github-write.js';
import type { Octokit } from '@octokit/rest';
const head = 'a'.repeat(40);
const request = {head,id:'123',task:'docs',acceptance:'clear',paths:['docs/a.md']};
const files = [{path:'docs/a.md',content:'new'}];
function fake(options: {stale?: boolean; existing?: boolean; collision?: boolean; different?: boolean; unsafe?: boolean} = {}) {
  const calls: string[] = [];
  const api = {
    pulls: {
      list: async () => ({data: options.existing ? [{html_url:'existing'}] : []}),
      create: async (args: Record<string, unknown>) => { assert.equal(args.draft,true); assert.equal(args.base,'main'); calls.push('pr'); return {data:{html_url:'draft'}}; },
    },
    git: {
      getRef: async ({ref}: {ref:string}) => ({data:{object:{sha: ref === 'heads/main' ? (options.stale ? 'b'.repeat(40) : head) : 'prior'}}}),
      getCommit: async ({commit_sha}: {commit_sha:string}) => ({data:{tree:{sha:commit_sha === head ? 'base-tree' : options.different ? 'different' : 'new-tree'},parents:[{sha:head}]}}),
      getTree: async () => ({data:{truncated:false,tree:options.unsafe ? [{path:'docs',mode:'120000'}] : []}}),
      createTree: async () => {calls.push('tree');return {data:{sha:'new-tree'}};},
      createCommit: async () => {calls.push('commit');return {data:{sha:'new-commit'}};},
      createRef: async ({ref}: {ref:string}) => { assert.equal(ref,'refs/heads/ai/implement-123');calls.push('branch');if(options.collision) throw {status:422}; },
    },
  } as unknown as Octokit;
  return {api,calls};
}
test('publishes only a new task branch and draft PR', async () => {
  const {api,calls}=fake();assert.equal(await publishDraft('test','owner','repo',request,files,api),'draft');assert.deepEqual(calls,['tree','commit','branch','pr']);
});
test('existing PR is idempotent without writes', async () => {
  const {api,calls}=fake({existing:true});assert.equal(await publishDraft('test','owner','repo',request,files,api),'existing');assert.deepEqual(calls,[]);
});
test('stale base and unsafe tree entries reject before write', async () => {
  for (const options of [{stale:true},{unsafe:true}]) {const {api,calls}=fake(options);await assert.rejects(publishDraft('test','owner','repo',request,files,api));assert.deepEqual(calls,[]);}
});
test('recovers a matching branch but never overwrites a differing branch', async () => {
  const match=fake({collision:true});assert.equal(await publishDraft('test','owner','repo',request,files,match.api),'draft');
  const mismatch=fake({collision:true,different:true});await assert.rejects(publishDraft('test','owner','repo',request,files,mismatch.api), /differs/);assert.ok(!mismatch.calls.includes('pr'));
});
