import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
export interface Checkpoint { files?: unknown; url?: string; notified?: boolean }
/** Atomic local persistence. Requires one durable volume shared by all workers. */
export async function withCheckpoint(directory: string, id: string, run: (state: Checkpoint, save: () => Promise<void>) => Promise<boolean>): Promise<boolean> {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid checkpoint identity');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${id}.json`);
  const lock = `${path}.lock`;
  try { await writeFile(lock, '', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error; }
  try {
    let state: Checkpoint = {};
    try { state = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid checkpoint');
    const save = async () => { await writeFile(`${path}.tmp`, JSON.stringify(state), { mode: 0o600 }); await rename(`${path}.tmp`, path); };
    return await run(state, save);
  } finally { await unlink(lock); }
}
