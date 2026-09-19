import test from 'node:test';
import assert from 'node:assert/strict';
import { safePath, safeWritePath, parseImplementation, validateChanges } from '../src/implementation.js';
import { createDiagnosticReporter, malformedHandoff } from '../src/request-diagnostics.js';
import { supportsLegacyOnboarding } from '../src/providers.js';
const sha = 'a'.repeat(40);
const task = `GEMINI — ACCIÓN REQUERIDA\nMODE: IMPLEMENT\nHEAD: ${sha}\nTASK: Fix\nPATHS: src/a.ts\nACCEPTANCE: Tests`;
test('write parser and publisher reject control-plane files including nested manifests', () => {
  const request = parseImplementation(task, 'GEMINI')!;
  for (const path of ['package.json','mobile-driver/package.json','pnpm-lock.yaml','package-lock.json','yarn.lock','next.config.ts','tsconfig.json','tsconfig.build.json','vercel.json','render.yaml','.npmrc','.github/workflows/ci.yml','.husky/pre-commit']) {
    assert.equal(safeWritePath(path),false,path);
    assert.equal(parseImplementation(task.replace('src/a.ts',path),'GEMINI'),null,path);
    assert.throws(() => validateChanges([{path,content:'untrusted'}],{...request,paths:[path]}),undefined,path);
  }
  assert.equal(safeWritePath('src/service.ts'),true);
  assert.equal(safePath('.github/workflows/ci.yml'),true,'review can read control files');
});
test('malformed marker/short HEAD gets diagnostic while valid requests, bots and replies do not', () => {
  const message={user:'U1',ts:'1000',text:'GEMINI — ACCIÓN REQUERIDA\nPR #2\nHEAD: abcdefa'};
  assert.equal(malformedHandoff(message,'GEMINI'),true);
  assert.equal(malformedHandoff({...message,text:task},'GEMINI'),false);
  assert.equal(malformedHandoff({...message,botId:'B1'},'GEMINI'),false);
  assert.equal(malformedHandoff({...message,threadTs:'999'},'GEMINI'),false);
  assert.equal(malformedHandoff({...message,text:'Preface\n'+task},'GEMINI'),true);
});
test('diagnostics redact content, deduplicate concurrent events and limit polling floods', async () => {
  const sent: string[]=[];
  const report=createDiagnosticReporter('GEMINI',async text=>{sent.push(text);},()=>1_000_000);
  const message={user:'U1',ts:'1000',text:'GEMINI — ACCIÓN REQUERIDA\nprivate-secret'};
  await Promise.all([report(message),report(message)]);
  assert.equal(sent.length,1);
  assert.ok(!sent[0].includes('private-secret'));
  for(let n=1;n<8;n++) await report({...message,ts:String(1000+n)});
  assert.equal(sent.length,3);
  await report({...message,ts:'1'});assert.equal(sent.length,3);
});
test('phase-zero onboarding is exclusively DeepSeek until its protocol is generalized', () => {
  for(const name of ['gpt','claude','gemini'] as const) assert.equal(supportsLegacyOnboarding(name),false);
  assert.equal(supportsLegacyOnboarding('deepseek'),true);
});
