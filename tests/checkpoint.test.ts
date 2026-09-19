import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withCheckpoint } from '../src/checkpoint.js';
const id='a'.repeat(24);
test('durable proposal survives failure and concurrent delivery cannot enter', async () => {
  const dir=await mkdtemp(join(tmpdir(),'parity-'));
  try {
    await assert.rejects(withCheckpoint(dir,id,async (state,save) => {
      state.files=[{path:'a',content:'b'}];await save();
      assert.equal(await withCheckpoint(dir,id,async () => {throw new Error('must not enter');}),false);
      throw new Error('simulated provider/process failure');
    }));
    await withCheckpoint(dir,id,async (state,save) => {assert.deepEqual(state.files,[{path:'a',content:'b'}]);state.url='draft';await save();return true;});
    assert.equal(JSON.parse(await readFile(join(dir,`${id}.json`),'utf8')).url,'draft');
  } finally {await rm(dir,{recursive:true,force:true});}
});
