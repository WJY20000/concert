import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { createBrowser } from '../src/browser.mjs';
import { validate } from '../src/config.mjs';
import { reserveSubmission } from '../src/journal.mjs';
import { runCheckout } from '../src/run.mjs';

const origin = 'https://fixture.invalid';
const artifacts = new URL('../test-artifacts/', import.meta.url);
const fields = { event: 'Demo show', session: 'Evening', ticket: 'Tier A', quantity: '2', attendees: 'Demo guests' };
let chromiumInstance;

before(async () => {
  chromiumInstance = await chromium.launch({ executablePath: process.env.TEST_CHROMIUM_PATH || undefined });
});

after(async () => {
  await chromiumInstance?.close();
});

test('example config parses and remote debugging stays local', async () => {
  const config = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
  assert.equal(validate(config), config);
  assert.throws(() => validate({ ...config, cdp: 'http://example.com:9222' }));
  assert.throws(() => validate({ ...config, saleAt: '2027-01-01T10:00:00Z' }));
  assert.throws(() => validate({ ...config, order: { ...config.order, route: { origin, path: '/read' } } }));
});

function stage(path) {
  return { route: { path }, ready: '#loaded', login: '#signed-in', button: '#action', soldOut: '#sold-out' };
}

function fixtureConfig(saleAt) {
  const localTime = new Date(saleAt + 8 * 60 * 60 * 1_000).toISOString().replace('Z', '+08:00');
  return {
    origin,
    saleAt: localTime,
    detail: stage('/detail'),
    checkout: stage('/checkout'),
    order: { ...stage('/order'), id: '#order-id', pending: '#pending' },
    orders: {
      url: origin + '/orders', route: { path: '/orders' }, ready: '#loaded',
      rows: '.row', id: '.id', link: '.details', empty: '#empty',
    },
    blockers: ['#captcha', '#login-dialog'],
    fields: Object.fromEntries(Object.entries(fields).map(([name, expected]) => [name, {
      expected,
      checkout: '#' + name,
      order: '#' + name,
      ...(name === 'event' ? { detail: '#' + name } : {}),
    }])),
  };
}

const display = values => Object.entries(values).map(([key, value]) =>
  `<p id="${key}">${value}</p>`).join('');
const user = '<main id="loaded"><p id="signed-in">Signed in</p>';
const match = { id: 'mock-new', fields };

async function runScenario(t, scenario = {}) {
  const timeline = [];
  const directory = await mkdtemp(join(tmpdir(), 'concert-fixture-'));
  const context = await chromiumInstance.newContext({ offline: true, serviceWorkers: 'block' });
  let releaseHangingRequest;
  t.after(async () => {
    // These artifacts contain synthetic event names, relative ordering and timestamps only.
    await mkdir(artifacts, { recursive: true });
    await writeFile(new URL(`${t.name.replace(/[^a-z0-9]+/giu, '-')}.json`, artifacts),
      JSON.stringify(timeline, null, 2) + '\n');
    releaseHangingRequest?.();
    await context.close();
    await rm(directory, { recursive: true, force: true });
  });
  const page = await context.newPage();
  let saleAt;
  let submissions = 0;
  let storedOrder;
  let early = 0;
  let entries = 0;
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    function html(body) {
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html>' + body });
    }
    switch (url.pathname) {
      case '/detail':
        return html(user + display({ event: fields.event }) +
          `<button id="action" onclick="location.href='/checkout?entered=1'">Open checkout</button></main>`);
      case '/checkout': {
        if (url.searchParams.has('entered')) {
          entries += 1;
          timeline.push({ event: 'fixture_entry', at: new Date().toISOString() });
        }
        const values = { ...fields, ...(scenario.values ?? {}) };
        if (scenario.missing) delete values[scenario.missing];
        const soldOut = scenario.soldOut ? '<p id="sold-out">Sold out</p>' : '';
        const captcha = scenario.captcha ? '<p id="captcha">Challenge</p>' : '';
        const delayed = scenario.opensLate ? 'disabled' : '';
        const unlock = scenario.opensLate
          ? `<script>setTimeout(() => document.querySelector('#action').disabled = false, Math.max(0, ${saleAt + 250} - Date.now()));</script>`
          : '';
        return html(user + display(values) + soldOut + captcha +
          `<button id="action" ${delayed}>Create order</button>${unlock}
          <script>
          document.querySelector('#action').onclick = async () => {
            const response = await fetch('/submit', { method: 'POST' });
            if (response.ok) location.assign('/order?id=mock-new');
          };
          </script></main>`);
      }
      case '/submit':
        if (request.method() !== 'POST') return route.abort();
        submissions += 1;
        timeline.push({ event: 'fixture_submit_received', at: new Date().toISOString() });
        if (Date.now() < saleAt) {
          early += 1;
          return route.fulfill({ status: 409, body: 'Sale not open' });
        }
        if (!scenario.noOrder) {
          storedOrder = scenario.wrongOrder ? { ...match, fields: { ...fields, ticket: 'Tier B' } } : match;
        }
        if (scenario.timeout) {
          // The server may have saved the order while the browser still waits for a response.
          await new Promise(resolve => { releaseHangingRequest = resolve; });
          return route.abort().catch(() => {});
        }
        return route.fulfill({ status: 201, body: '{}' });
      case '/orders':
        return html('<main id="loaded">' + (storedOrder
          ? '<article class="row"><b class="id">mock-new</b> <a class="details" href="/order?id=mock-new">Details</a></article>'
          : '<p id="empty">No orders</p>') + '</main>');
      case '/order':
        if (!storedOrder || url.searchParams.get('id') !== storedOrder.id) return html('<p>Missing order</p>');
        return html('<main id="loaded"><p id="order-id">mock-new</p><p id="pending">Pending payment</p>' +
          display(storedOrder.fields) + '</main>');
      default:
        return route.abort();
    }
  });

  saleAt = Date.now() + (scenario.checkPreSale ? 1_600 : 300);
  const config = fixtureConfig(saleAt);
  await page.goto(origin + (scenario.detail ? '/detail' : '/checkout'));
  const browser = createBrowser(page, config);
  const settings = {
    reserveSubmission: () => reserveSubmission(directory, 'same-intent'),
    emit: event => timeline.push(event),
    entryWindow: 4_000,
    transitionTimeout: 900,
    reconcileWindow: 1_200,
    lookupTimeout: 1_000,
    pollMs: 35,
  };
  async function run(mode = 'live') {
    return runCheckout(browser, config, { ...settings, mode });
  }
  return {
    run, saleAt, timeline,
    counts: () => ({ entries, submissions, early }),
    async returnToCheckout() {
      await page.goto(origin + '/checkout');
    },
  };
}

test('early enabled button waits for the Beijing sale time and creates exactly one pending order', async t => {
  const scenario = await runScenario(t, { checkPreSale: true });
  const result = await scenario.run();
  assert.equal(result.status, 'pending_payment');
  const preflight = scenario.timeline.find(event => event.event === 'preflight_checked');
  assert.ok(Date.parse(preflight.at) < scenario.saleAt, 'preflight ran before sale');
  assert.ok(Date.parse(result.firstActionAt) >= scenario.saleAt);
  assert.ok(Date.parse(result.submitAttemptAt) >= scenario.saleAt);
  assert.ok(Date.parse(result.confirmedAt) >= Date.parse(result.submitAttemptAt));
  assert.equal(result.saleToPendingMs, Date.parse(result.confirmedAt) - scenario.saleAt);
  assert.deepEqual(scenario.counts(), { entries: 0, submissions: 1, early: 0 });
  await scenario.returnToCheckout();
  assert.equal((await scenario.run()).status, 'previous_submission_requires_review');
  assert.equal(scenario.counts().submissions, 1);
});

test('detail entry preserves prefill and waits for an asynchronously enabled submit button', async t => {
  const scenario = await runScenario(t, { detail: true, opensLate: true });
  const result = await scenario.run();
  assert.equal(result.status, 'pending_payment');
  assert.ok(Date.parse(scenario.timeline.find(event => event.event === 'fixture_entry').at) >= scenario.saleAt);
  assert.ok(Date.parse(result.submitAttemptAt) >= scenario.saleAt + 250);
  assert.deepEqual(scenario.counts(), { entries: 1, submissions: 1, early: 0 });
});

for (const [name, setup, expectedStatus, field] of [
  ['wrong tier', { values: { ticket: 'Tier B' } }, 'prefill_mismatch', 'ticket'],
  ['wrong session', { values: { session: 'Matinee' } }, 'prefill_mismatch', 'session'],
  ['lost prefill', { missing: 'attendees' }, 'prefill_missing', 'attendees'],
  ['sold out', { soldOut: true }, 'sold_out'],
  ['captcha', { captcha: true }, 'challenge_or_login'],
  ['observe mode', {}, 'observed'],
]) {
  test(`${name} never submits`, async t => {
    const scenario = await runScenario(t, setup);
    const result = await scenario.run(name === 'observe mode' ? 'observe' : 'live');
    assert.equal(result.status, expectedStatus);
    assert.equal(result.field, field);
    assert.deepEqual(scenario.counts(), { entries: 0, submissions: 0, early: 0 });
  });
}

test('submit timeout reconciles a matching order through the order list without resubmitting', async t => {
  const scenario = await runScenario(t, { timeout: true });
  const result = await scenario.run();
  assert.equal(result.status, 'pending_payment');
  assert.equal(scenario.timeline.find(event => event.event === 'order_confirmed')?.source, 'order_list');
  assert.deepEqual(scenario.counts(), { entries: 0, submissions: 1, early: 0 });
});

for (const [name, setup] of [
  ['no visible order', { timeout: true, noOrder: true }],
  ['mismatched returned order', { timeout: true, wrongOrder: true }],
]) {
  test(`${name} remains unresolved and a new run does not resubmit`, async t => {
    const scenario = await runScenario(t, setup);
    assert.equal((await scenario.run()).status, 'order_status_unknown');
    assert.equal((await scenario.run()).status, 'previous_submission_requires_review');
    assert.deepEqual(scenario.counts(), { entries: 0, submissions: 1, early: 0 });
  });
}

test('submission reservation is atomic across competing workers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'concert-journal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const results = await Promise.all([
    reserveSubmission(directory, 'same-key'),
    reserveSubmission(directory, 'same-key'),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
});
