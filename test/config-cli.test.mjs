import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config.mjs';
import { makeJournal } from '../src/journal.mjs';

const sample = fileURLToPath(new URL('../config.example.json', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const exec = promisify(execFile);

async function temporaryConfig(t) {
  const directory = await mkdtemp(join(tmpdir(), 'concert-qa-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = JSON.parse(await readFile(sample, 'utf8'));
  config.providers = {
    primary: { web: 'web.json' },
    test_provider: { web: 'second.json', android: 'device.json' },
  };
  config.provider = 'primary';
  const filename = join(directory, 'config.local.json');
  await Promise.all([
    writeFile(join(directory, 'web.json'), '{"tag":"first"}'),
    writeFile(join(directory, 'second.json'), '{"tag":"second-web"}'),
    writeFile(join(directory, 'device.json'), '{"tag":"second-android"}'),
    writeFile(filename, JSON.stringify(config)),
  ]);
  return { directory, filename, config };
}

test('sample permits read-only observation before sale time has been set', async () => {
  const loaded = await loadConfig(sample);
  assert.equal(loaded.intent.saleAt, null);
  assert.ok(loaded.profile.stages.checkout);
});

test('explicit provider and platform load the matching profile relative to the configuration file', async t => {
  const { filename } = await temporaryConfig(t);
  assert.equal((await loadConfig(filename)).profile.tag, 'first');
  assert.equal((await loadConfig(filename, { provider: 'test_provider', platform: 'android' })).profile.tag, 'second-android');
  assert.equal((await loadConfig(filename, { provider: 'test_provider', platform: 'web' })).profile.tag, 'second-web');
  await assert.rejects(loadConfig(filename, { platform: 'android' }), /invalid_profile/);
  await assert.rejects(loadConfig(filename, { provider: 'missing_provider' }), /invalid_provider/);
});

test('CLI rejects missing sale time and undeclared providers before connecting', async t => {
  const { filename } = await temporaryConfig(t);
  for (const [args, reason] of [
    [['live', filename], 'invalid_sale_time'],
    [['observe', filename, '--provider', 'missing_provider'], 'invalid_provider'],
  ]) {
    await assert.rejects(exec(process.execPath, [cli, ...args]), error => {
      const last = JSON.parse(error.stdout.trim());
      assert.equal(error.code, 2);
      assert.equal(last.event, 'finished');
      assert.equal(last.status, 'invalid_config');
      assert.equal(last.reason, reason);
      return true;
    });
  }
});

test('atomic reservation survives changes to platform, provider and ticket preferences', async t => {
  const { directory, filename, config } = await temporaryConfig(t);
  const initial = makeJournal(directory, config.intent);
  const changed = makeJournal(directory, { ...config.intent, tier: 'VIP', seats: ['演示一座', '演示二座'] });
  assert.equal(await initial.reserved(), false);
  const attempts = await Promise.all([initial.reserve(), changed.reserve(), initial.reserve()]);
  assert.deepEqual(attempts.sort(), [false, false, true]);
  assert.equal(await changed.reserved(), true);
  const files = await readdir(join(directory, '.concert-state'));
  assert.equal(files.length, 1);
  const data = await readFile(join(directory, '.concert-state', files[0]), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(data)), ['reservedAt']);

  config.intent.saleAt = '2030-07-01T12:00:00+08:00';
  await writeFile(filename, JSON.stringify(config));
  await assert.rejects(exec(process.execPath, [cli, 'live', filename, '--provider', 'test_provider', '--platform', 'android']), error => {
    const last = JSON.parse(error.stdout.trim());
    assert.equal(error.code, 2);
    assert.equal(last.status, 'previous_submission_requires_review');
    return true;
  });
  assert.equal(await makeJournal(directory, { ...config.intent, session: '另一场次' }).reserved(), false);
});
