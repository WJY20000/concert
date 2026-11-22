import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

export async function reserveSubmission(directory, intentKey) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let marker;
  try {
    marker = await open(join(directory, `${intentKey}.json`), 'wx', 0o600);
  } catch (error) {
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
}
