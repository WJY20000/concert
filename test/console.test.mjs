import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createConsole } from '../src/console.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'concert-panel-'));
  const configFile = join(dir, 'config.json');
  const privateText = 'SyntheticPrivateName';
  await writeFile(configFile, JSON.stringify({
    provider: 'damai', platform: 'android',
    providers: { damai: { web: 'local-web', android: 'local-android' }, demo: { web: 'demo-web' } },
    intent: { attendees: [privateText] },
  }));
  let child;
  let launched;
  const panel = await createConsole({
    configFile,
    startRunner(options) {
      launched = options;
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.kill = signal => { child.signal = signal; };
      return child;
    },
  });
  t.after(async () => {
    await panel.close();
    await rm(dir, { recursive: true, force: true });
  });
  const read = async () => (await fetch(panel.url + '/api/state')).json();
  const state = await read();
  function post(path, payload, headers = {}) {
    return fetch(panel.url + '/api/' + path, {
      method: 'POST',
      headers: { origin: panel.url, 'content-type': 'application/json', 'x-console-token': state.token, ...headers },
      body: JSON.stringify(payload),
    });
  }
  return {
    ...panel, state, read, post, configFile, privateText,
    process: () => child, launched: () => launched,
    command: { provider: 'damai', mode: 'observe', platform: 'android' },
  };
}

test('console serves its UI and exposes configured provider choices without intent data', async t => {
  const f = await fixture(t);
  const page = await fetch(f.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /购票控制台/);
  for (const path of ['/ui.css', '/ui.js']) assert.equal((await fetch(f.url + path)).status, 200);
  assert.deepEqual(f.state.defaults, { provider: 'damai', platform: 'android' });
  assert.deepEqual(f.state.providers, [
    { key: 'damai', platforms: ['web', 'android'] }, { key: 'demo', platforms: ['web'] },
  ]);
  assert.ok(!JSON.stringify(f.state).includes(f.privateText));
  assert.equal((await fetch(f.url + '/config.json')).status, 404);
});

test('console denies off-origin or tokenless mutations and invalid provider/platform combinations', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('start', f.command, { origin: 'https://untrusted.invalid' })).status, 403);
  assert.equal((await f.post('start', f.command, { 'x-console-token': '' })).status, 403);
  assert.equal((await f.post('start', f.command, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await f.post('start', { ...f.command, provider: 'demo' })).status, 400);
  assert.equal((await f.post('start', { ...f.command, mode: 'go' })).status, 400);
  assert.equal((await f.post('start', { ...f.command, command: 'another executable' })).status, 400);
  assert.equal(f.launched(), undefined);
});

test('console serializes tasks, sanitizes timelines and stops only the intended active child', async t => {
  const f = await fixture(t);
  const response = await f.post('start', f.command);
  assert.equal(response.status, 202);
  const id = (await response.json()).run.id;
  assert.deepEqual(f.launched(), { ...f.command, configFile: f.configFile });
  const child = f.process();
  assert.equal((await f.post('start', f.command)).status, 409);
  child.stdout.write('ordinary output ' + f.privateText + '\n');
  child.stdout.write(JSON.stringify({ event: f.privateText }) + '\n');
  child.stdout.write(JSON.stringify({ event: 'preflight', stage: f.privateText, attendees: [f.privateText] }) + '\n');
  child.stdout.write(JSON.stringify({ event: 'finished', status: 'observed', saleToPendingMs: 152, at: f.privateText }) + '\n');
  const visible = (await f.read()).run;
  assert.ok(!JSON.stringify(visible).includes(f.privateText));
  assert.deepEqual(visible.timeline.map(item => item.event), ['preflight', 'finished']);
  assert.equal(visible.timeline[1].saleToPendingMs, 152);
  assert.equal((await f.post('stop', { id: 'previous-run' })).status, 409);
  assert.equal(child.signal, undefined);
  assert.equal((await f.post('stop', { id })).status, 202);
  assert.equal(child.signal, 'SIGTERM');
  assert.equal((await f.read()).run.phase, 'stopping');
  assert.equal((await f.post('start', f.command)).status, 409);
  child.emit('close', null, 'SIGTERM');
  assert.equal((await f.read()).run.phase, 'stopped');
  assert.equal((await f.post('start', { provider: 'demo', platform: 'web', mode: 'rehearse' })).status, 202);
  f.process().emit('close', 0);
  assert.equal((await f.read()).run.phase, 'completed');
});
