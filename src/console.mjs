import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/ui.css', ['ui.css', 'text/css']],
  ['/ui.js', ['ui.js', 'text/javascript']],
]);

const modes = new Set(['observe', 'rehearse', 'live']);
const platforms = new Set(['web', 'android']);
const stages = new Set(['detail', 'options', 'seats', 'checkout', 'order', 'orders', 'unknown']);
const events = new Set([
  'connected', 'preflight', 'waiting', 'first_action', 'selected', 'navigated',
  'submit_attempt', 'reconciling', 'confirmed', 'finished',
]);
const outcomes = new Set([
  'observed', 'rehearsed', 'pending_payment', 'order_status_unknown',
  'previous_submission_requires_review', 'challenge', 'sold_out', 'wrong_event',
  'selection_mismatch', 'selection_unavailable', 'unexpected_submit_label', 'login_unverified', 'page_unrecognized',
  'timeout', 'invalid_config', 'adapter_error', 'cancelled', 'unexpected_submit_label',
]);
const clockKeys = ['at', 'saleAt', 'firstActionAt', 'submitAttemptAt', 'confirmedAt'];

function safeEntry(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!events.has(value?.event)) return null;
  const entry = { event: value.event };
  if (stages.has(value.stage)) entry.stage = value.stage;
  if (outcomes.has(value.status)) entry.status = value.status;
  for (const key of clockKeys) {
    const time = value[key];
    if (typeof time === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/u.test(time) && Number.isFinite(Date.parse(time))) {
      entry[key] = new Date(time).toISOString();
    }
  }
  if (Number.isSafeInteger(value.saleToPendingMs) && value.saleToPendingMs >= 0) {
    entry.saleToPendingMs = value.saleToPendingMs;
  }
  entry.at ??= new Date().toISOString();
  return entry;
}

function readTimeline(stream, onEntry) {
  let pending = '';
  let discard = false;
  function finishLine() {
    if (!discard && pending) {
      const entry = safeEntry(pending);
      if (entry) onEntry(entry);
    }
    pending = '';
    discard = false;
  }
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    const parts = chunk.split('\n');
    for (const [index, part] of parts.entries()) {
      if (index) finishLine();
      if (pending.length + part.length > 4096) discard = true;
      if (!discard) pending += part;
    }
  });
  stream.on('end', finishLine);
}

function launch({ configFile, provider, mode, platform }) {
  return spawn(process.execPath, [cliPath, mode, configFile, '--platform', platform, '--provider', provider], {
    shell: false,
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
}

function reply(response, code, body) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function readCommand(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= 1024) chunks.push(chunk);
  }
  if (!size || size > 1024) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

export async function createConsole({ configFile, port = 0, startRunner = launch }) {
  const absoluteConfig = resolve(configFile);
  const config = JSON.parse(await readFile(absoluteConfig, 'utf8'));
  const providers = Object.entries(config.providers ?? {}).filter(([key]) => /^[a-z][a-z0-9_-]{0,63}$/u.test(key))
    .map(([key, details]) => ({ key, platforms: [...platforms].filter(side => typeof details?.[side] === 'string') }))
    .filter(item => item.platforms.length);
  if (!providers.length) throw new Error('No configured provider profiles');
  const defaultProvider = providers.find(item => item.key === config.provider) ?? providers[0];
  const defaults = {
    provider: defaultProvider.key,
    platform: defaultProvider.platforms.includes(config.platform) ? config.platform : defaultProvider.platforms[0],
  };
  const token = randomBytes(32).toString('hex');
  let url;
  let child = null;
  let run = { id: null, phase: 'idle', timeline: [] };

  function start(provider, mode, platform) {
    const next = startRunner({ configFile: absoluteConfig, provider, mode, platform });
    child = next;
    run = { id: randomUUID(), phase: 'running', provider, mode, platform, timeline: [] };
    readTimeline(next.stdout, entry => {
      if (child !== next) return;
      run.timeline.push(entry);
      if (run.timeline.length > 160) run.timeline.shift();
    });
    next.on('error', () => {
      if (child === next) run.phase = 'failed';
    });
    next.on('close', code => {
      if (child !== next) return;
      if (run.phase === 'stopping') run.phase = 'stopped';
      else run.phase = code === 0 ? 'completed' : 'failed';
      child = null;
    });
  }

  function stop() {
    if (child && run.phase !== 'stopping') {
      run.phase = 'stopping';
      child.kill('SIGTERM');
    }
  }

  const server = createServer((request, response) => {
    async function handle() {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
      if (request.headers.host !== new URL(url).host || request.headers['sec-fetch-site'] === 'cross-site') {
        return reply(response, 403, { error: 'forbidden' });
      }
      const path = request.url;
      if (request.method === 'GET') {
        if (path === '/api/state') return reply(response, 200, { token, providers, defaults, run });
        const asset = assets.get(path);
        if (!asset) return reply(response, 404, { error: 'not_found' });
        const body = await readFile(new URL('../ui/' + asset[0], import.meta.url));
        response.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8' });
        response.end(body);
        return;
      }
      if (request.method !== 'POST' || !['/api/start', '/api/stop'].includes(path)) {
        return reply(response, 404, { error: 'not_found' });
      }
      if (request.headers.origin !== url || request.headers['x-console-token'] !== token) {
        return reply(response, 403, { error: 'forbidden' });
      }
      const command = await readCommand(request);
      if (!command || typeof command !== 'object' || Array.isArray(command)) {
        return reply(response, 400, { error: 'invalid_command' });
      }
      if (path === '/api/start') {
        if (child) return reply(response, 409, { error: 'busy' });
        const selected = providers.find(item => item.key === command.provider);
        if (!selected?.platforms.includes(command.platform) || !modes.has(command.mode) ||
            Object.keys(command).some(key => !['mode', 'platform', 'provider'].includes(key))) {
          return reply(response, 400, { error: 'invalid_command' });
        }
        start(command.provider, command.mode, command.platform);
      } else {
        if (!child || command.id !== run.id) return reply(response, 409, { error: 'stale_run' });
        stop();
      }
      return reply(response, 202, { run });
    }
    handle().catch(() => {
      if (!response.headersSent) reply(response, 500, { error: 'console_error' });
      else response.end();
    });
  });
  server.requestTimeout = 10_000;
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', fail);
      done();
    });
  });
  url = 'http://127.0.0.1:' + server.address().port;
  return {
    url,
    async close() {
      stop();
      await new Promise(done => server.close(done));
    },
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [configFile, extra] = process.argv.slice(2);
  if (!configFile || extra) {
    console.error('Usage: node src/console.mjs config.local.json');
    process.exitCode = 2;
  } else {
    try {
      const panel = await createConsole({ configFile });
      console.log('在本机浏览器打开 ' + panel.url);
      const shutdown = () => { void panel.close(); };
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
    } catch {
      console.error('控制台启动失败，请检查本机配置文件与 providers 设置。');
      process.exitCode = 2;
    }
  }
}
