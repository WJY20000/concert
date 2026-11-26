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
  config.intent.saleAt = null;
  const filename = join(directory, 'config.local.json');
  await Promise.all([
    writeFile(join(directory, 'web.json'), '{"tag":"first"}'),
    writeFile(join(directory, 'second.json'), '{"tag":"second-web"}'),
    writeFile(join(directory, 'device.json'), '{"tag":"second-android"}'),
    writeFile(filename, JSON.stringify(config)),
  ]);
  return { directory, filename, config };
}

test('sample targets the Nanjing show and ¥88 tier, and read-only config can omit sale time', async t => {
  const loaded = await loadConfig(sample);
  assert.equal(loaded.intent.saleAt, '2026-11-26T19:00:00+08:00');
  assert.equal(loaded.intent.session, '2026-12-04 周五 22:00');
  assert.equal(loaded.intent.tier, '早鸟票88元');
  assert.deepEqual(loaded.intent.seats, []);
  assert.equal(loaded.profile.stages.detail.query.id, '1102631725191');
  assert.equal((await loadConfig((await temporaryConfig(t)).filename)).intent.saleAt, null);
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

test('practice setup isolates its item, confirmation route, and number of attendees', async () => {
  const { rehearsalProfile, rehearsalIntent } = await import('../tools/prepare-rehearsal.mjs');
  const original = await loadConfig(sample);
  const { detail, checkout } = rehearsalProfile(original.profile, '1100435904158', 'h5').stages;
  assert.equal(detail.query.id, '1100435904158');
  assert.match(detail.actions.enter.selector, /\.buy-link/u);
  assert.equal(checkout.origin, 'https://m.damai.cn');
  assert.equal(checkout.path, '/app/dmfe/h5-ultron-buy/index.html');
  assert.equal(checkout.query, undefined);
  const result = rehearsalIntent(original.intent, {
    stage: 'detail', loggedIn: true, blocked: false, soldOut: false,
    fields: { event: '演练演出', session: '周四 20:30', tier: '演练票档' },
    controls: { enter: { enabled: true } },
  });
  assert.equal(result.saleAt, null);
  assert.equal(result.quantity, original.intent.attendees.length);
  assert.deepEqual(result.attendees, original.intent.attendees);
  assert.equal(original.profile.stages.detail.query.id, '1102631725191');
  assert.ok(original.intent.saleAt);
  assert.throws(() => rehearsalProfile(original.profile, 'not-an-id', 'h5'), /invalid_rehearsal_arguments/);
  assert.throws(() => rehearsalProfile(original.profile, '1100435904158', 'generic'), /invalid_rehearsal_arguments/);
});
