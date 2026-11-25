import { createHash } from 'node:crypto';
import { access, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

export function makeJournal(configDir, intent) {
  // A different transport, provider or set of seats must not silently start another order.
  const id = createHash('sha256').update(JSON.stringify([intent.event, intent.session])).digest('hex');
  const dir = join(configDir, '.concert-state');
  const path = join(dir, id + '.json');
  return {
    async reserved() {
      try { await access(path); return true; } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    },
    async reserve() {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      let marker;
      try { marker = await open(path, 'wx', 0o600); } catch (error) {
        if (error.code === 'EEXIST') return false;
        throw error;
      }
      try {
        await marker.writeFile(JSON.stringify({ reservedAt: new Date().toISOString() }) + '\n');
        await marker.sync();
      } finally {
        await marker.close();
      }
      return true;
    },
  };
}
