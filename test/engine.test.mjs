import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runCheckout } from '../src/engine.mjs';

const saleAt = '2027-01-01T10:00:00+08:00';
const sale = Date.parse(saleAt);
const target = {
  saleAt, event: '演示演出', session: '周六 19:30', tier: '看台甲',
  quantity: 2, seats: ['A排1号', 'A排2号'], attendees: ['演示甲', '演示乙'],
  pendingStatus: '待支付',
};

function button(label, selected = null) {
  return { label, selected, enabled: true };
}

function fixture(t, options = {}) {
  const intent = structuredClone(target);
  const events = [];
  const actions = [];
  const fields = {
    event: intent.event, session: intent.session, tier: intent.tier, quantity: String(intent.quantity),
    seats: [...intent.seats], attendees: [...intent.attendees],
    ...structuredClone(options.fields ?? {}),
  };
  let stage = options.stage ?? 'checkout';
  let time = sale - 80;
  let reserved = false;
  let submissionCount = 0;
  let order = null;
  let snapshots = 0;

  function choices(group, wanted, selected) {
    return Object.fromEntries(wanted.map(value =>
      [group + ':' + value, button(value, selected.includes(value))]));
  }

  const adapter = {
    async snapshot() {
      if (++snapshots > 3_000) throw new Error('fixture exceeded observation limit');
      time += 1;
      const controls = {};
      let visibleFields = fields;
      switch (stage) {
        case 'detail':
          controls.enter = button('网页购票');
          break;
        case 'options':
          Object.assign(controls, choices('session', [intent.session], [fields.session]),
            choices('tier', [intent.tier], [fields.tier]), { increase: button('+'), next: button('确定') });
          break;
        case 'seats':
          Object.assign(controls, choices('seat', intent.seats, fields.seats), { next: button('确认座位') });
          break;
        case 'checkout':
          Object.assign(controls, choices('attendee', intent.attendees, fields.attendees), {
            submit: button('提交订单'), orders: button('我的订单'),
          });
          break;
        case 'orders':
          if (order) controls.openOrder = button('订单详情');
          break;
        case 'order':
          visibleFields = order;
          break;
        default:
          throw new Error('unexpected fixture stage');
      }
      return {
        stage, fields: structuredClone(visibleFields), controls,
        blocked: Boolean(options.blocked), soldOut: Boolean(options.soldOut),
        loggedIn: options.loggedIn ?? true,
      };
    },

    async click(view, key) {
      assert.equal(view.stage, stage);
      assert.ok(view.controls[key]?.enabled, 'action must exist and be enabled');
      actions.push({ key, at: time });
      if (key.startsWith('session:')) fields.session = key.slice(8);
      else if (key.startsWith('tier:')) fields.tier = key.slice(5);
      else if (key.startsWith('seat:')) fields.seats.push(key.slice(5));
      else if (key.startsWith('attendee:')) fields.attendees.push(key.slice(9));
      else if (key === 'increase') fields.quantity = String(Number(fields.quantity) + 1);
      else if (key === 'enter') stage = 'options';
      else if (key === 'next') stage = stage === 'options' ? 'seats' : 'checkout';
      else if (key === 'orders') stage = 'orders';
      else if (key === 'openOrder') stage = 'order';
      else if (key === 'submit') {
        submissionCount++;
        assert.deepEqual([...fields.seats].sort(), [...intent.seats].sort());
        assert.deepEqual([...fields.attendees].sort(), [...intent.attendees].sort());
        assert.equal(fields.quantity, String(intent.quantity));
        order = {
          ...structuredClone(fields), status: intent.pendingStatus,
          orderId: 'fixture-01', createdAt: new Date(time).toISOString(),
          ...options.order,
        };
        if (options.timeout) throw new Error('simulated lost response');
        stage = 'order';
      }
      return true;
    },
  };

  async function run(mode = 'live') {
    return runCheckout(adapter, intent, {
      platform: 'web', mode, now: () => time, sleep: async ms => { time += Math.max(1, ms); },
      pollMs: 10, timeoutMs: 5000, confirmMs: 1000,
      reserve: async () => {
        if (reserved) return false;
        reserved = true;
        return true;
      },
      emit: record => {
        // Keep diagnostics limited to fixed runner event names and timestamps.
        events.push({ event: record.event, at: record.at });
      },
    });
  }

  t.after(async () => {
    const path = new URL('../test-artifacts/', import.meta.url);
    await mkdir(path, { recursive: true });
    await writeFile(new URL(t.name.replace(/[^a-z0-9]+/giu, '-') + '.json', path),
      JSON.stringify({ events, clicks: actions.map(action => ({ action: action.key.split(':')[0], at: action.at })) }, null, 2));
  });
  return {
    run, actions, events,
    get submissions() { return submissionCount; },
    get reserved() { return reserved; },
    returnToCheckout() { stage = 'checkout'; },
  };
}

test('early sale button waits then creates exactly one matching pending order', async t => {
  const scenario = fixture(t);
  const result = await scenario.run();
  assert.equal(result.status, 'pending_payment');
  assert.equal(scenario.submissions, 1);
  assert.ok(scenario.actions.every(action => action.at >= sale));
  assert.ok(Date.parse(result.submitAttemptAt) >= sale);
  assert.equal(result.saleToPendingMs, Date.parse(result.confirmedAt) - sale);
  scenario.returnToCheckout();
  assert.equal((await scenario.run()).status, 'previous_submission_requires_review');
  assert.equal(scenario.submissions, 1);
});

test('detail route selects the exact seats and missing attendee once before submission', async t => {
  const scenario = fixture(t, { stage: 'detail', fields: { seats: [], attendees: [target.attendees[0]] } });
  assert.equal((await scenario.run()).status, 'pending_payment');
  assert.deepEqual(scenario.actions.map(action => action.key).sort(), [
    'enter', 'next', 'seat:A排1号', 'seat:A排2号', 'next', 'attendee:演示乙', 'submit',
  ].sort());
  assert.ok(scenario.actions.every(action => action.at >= sale));
});

test('observe only reads the prefilled checkout', async t => {
  const scenario = fixture(t);
  assert.equal((await scenario.run('observe')).status, 'observed');
  assert.equal(scenario.reserved, false);
  assert.deepEqual(scenario.actions, []);
});

test('rehearsal fills missing attendees and stops before submitting or locking', async t => {
  const scenario = fixture(t, { fields: { attendees: [] } });
  assert.equal((await scenario.run('rehearse')).status, 'rehearsed');
  assert.deepEqual(scenario.actions.map(action => action.key).sort(), target.attendees.map(name => 'attendee:' + name).sort());
  assert.equal(scenario.reserved, false);
  assert.equal(scenario.submissions, 0);
});

for (const [name, options] of [
  ['wrong tier', { fields: { tier: '看台乙' } }],
  ['wrong seats', { fields: { seats: ['B排1号', 'B排2号'] } }],
  ['unknown attendee', { fields: { attendees: ['其他观演人'] } }],
  ['missing session', { fields: { session: '' } }],
  ['wrong event', { fields: { event: '其他演出' } }],
  ['challenge', { blocked: true }],
  ['out of stock', { soldOut: true }],
  ['signed out', { loggedIn: false }],
]) {
  test(name + ' prevents submission', async t => {
    const scenario = fixture(t, options);
    const result = await scenario.run();
    assert.notEqual(result.status, 'pending_payment');
    assert.equal(scenario.submissions, 0);
    assert.equal(scenario.reserved, false);
  });
}

test('uncertain submission checks order details and never submits twice', async t => {
  const scenario = fixture(t, { timeout: true });
  assert.equal((await scenario.run()).status, 'pending_payment');
  assert.deepEqual(scenario.actions.map(action => action.key), ['submit', 'orders', 'openOrder']);
  assert.equal(scenario.submissions, 1);
});

for (const [name, order] of [
  ['old matching order', { createdAt: new Date(sale - 60_000).toISOString() }],
  ['order for a different tier', { tier: '看台乙' }],
  ['order with the wrong payment status', { status: '已取消' }],
]) {
  test(name + ' cannot resolve an uncertain submission', async t => {
    const scenario = fixture(t, { timeout: true, order });
    assert.equal((await scenario.run()).status, 'order_status_unknown');
    assert.equal(scenario.submissions, 1);
    scenario.returnToCheckout();
    assert.equal((await scenario.run()).status, 'previous_submission_requires_review');
    assert.equal(scenario.submissions, 1);
  });
}
