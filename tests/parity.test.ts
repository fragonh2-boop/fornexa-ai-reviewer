import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter, endpoints, type ProviderName } from '../src/providers.js';
import { parseImplementation, proposeImplementation, validateChanges, safePath } from '../src/implementation.js';
import { parseReviewRequest } from '../src/review-request.js';
const head = 'a'.repeat(40);
const text = `GEMINI — ACCIÓN REQUERIDA\nMODE: IMPLEMENT\nHEAD: ${head}\nTASK: Update docs\nPATHS: docs/a.md\nACCEPTANCE: Explain the behavior`;
const request = parseImplementation(text, 'GEMINI')!;
test('implementation protocol rejects missing acceptance, short SHA, duplicate fields and unsafe paths', () => {
  assert.ok(request);
  for (const invalid of [text.replace(head, 'abcdefa'), text.replace('ACCEPTANCE:', 'OTHER:'), text + '\nHEAD: ' + head, text.replace('docs/a.md', '../a')]) assert.equal(parseImplementation(invalid, 'GEMINI'), null);
  assert.equal(parseReviewRequest(text, 'GEMINI'), null);
  assert.equal(parseReviewRequest(`GEMINI — ACCIÓN REQUERIDA\nMODE: PR\nPR #2\nHEAD: abcdefa`, 'GEMINI'), null);
});
test('host rejects write scope expansion, duplicate paths and payload budgets', () => {
  for (const path of ['.env', '../a', 'a//b', '/etc/a']) assert.equal(safePath(path), false);
  for (const files of [[{path:'other',content:'x'}], [{path:'docs/a.md',content:'x'.repeat(200001)}], [{path:'docs/a.md',content:'a'}, {path:'docs/a.md',content:'b'}]]) assert.throws(() => validateChanges(files, request));
});
for (const provider of Object.keys(endpoints) as ProviderName[]) {
  test(`${provider}: same tool round, pinned read and implementation result`, async () => {
    let calls = 0;
    const adapter = createAdapter(provider, 'test-key', 'configured-model', 1000, async (url, init) => {
      assert.ok(String(url).startsWith(endpoints[provider]));
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'configured-model');
      if (calls++) assert.equal(body.messages.at(-1).tool_call_id, 'read-1');
      return new Response(JSON.stringify({choices:[{finish_reason: calls === 1 ? 'tool_calls' : 'stop', message: calls === 1 ? {role:'assistant',content:null,tool_calls:[{id:'read-1',type:'function',function:{name:'get_full_file',arguments:'{"path":"docs/a.md"}'}}]} : {role:'assistant',content:JSON.stringify({files:[{path:'docs/a.md',content:'Updated'}]})}}]}), {headers:{'content-type':'application/json'}});
    });
    const files = await proposeImplementation(adapter, request, async (path, sha) => {assert.equal(sha,head); assert.equal(path,'docs/a.md'); return 'Old';});
    assert.equal(files[0].content, 'Updated'); assert.equal(calls,2);
  });
  test(`${provider}: rejects empty, malformed and truncated responses`, async () => {
    for (const response of [{}, {choices:[{finish_reason:'length',message:{content:'partial'}}]}, {choices:[{finish_reason:'stop',message:{content:''}}]}]) {
      const adapter = createAdapter(provider,'test','model',1000,async () => new Response(JSON.stringify(response),{headers:{'content-type':'application/json'}}));
      await assert.rejects(adapter.complete([],[]));
    }
  });
  test(`${provider}: accepts uppercase STOP finish_reason from Gemini-like responses`, async () => {
    const adapter = createAdapter(provider, 'test', 'model', 1000, async () => new Response(JSON.stringify({
      choices: [{ finish_reason: 'STOP', message: { role: 'assistant', content: 'Respuesta en mayúsculas' } }]
    }), { headers: { 'content-type': 'application/json' } }));
    const msg = await adapter.complete([], []);
    assert.equal(msg.content, 'Respuesta en mayúsculas');
  });
}
test('round exhaustion cannot become a successful implementation', async () => {
  await assert.rejects(proposeImplementation({ complete: async () => ({role:'assistant', content:null, refusal:null, tool_calls:[{id:'a',type:'function',function:{name:'get_full_file',arguments:'{"path":"docs/a.md"}'}}]}) }, request, async () => 'data'), /budget exhausted/);
});
