import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardDamaiH5 } from '../src/damai-h5.mjs';
import { runCheckout } from '../src/engine.mjs';

const itemId = '1102631725191';
const rule = { tier: '早鸟票88元', amountCents: 8800 };
const intent = {
  event: '【南京】示例演出', session: '2026-12-04 周五 22:00', tier: rule.tier,
  quantity: 2, attendees: ['演示甲', '演示乙'], seats: [], pendingStatus: '待支付',
  saleAt: '2026-11-26T19:00:00+08:00',
};
const choice = (label, selected = false) => ({ label, enabled: true, selected });

function fixture(options = {}) {
  let stage = options.skipEntry ? 'checkout' : 'detail';
  const selected = [];
  const clicks = [];
  let detailReads = 0;
  let quantity = options.delayedQuantity ? 1 : 2;
  const raw = {
    async snapshot() {
      const result = { stage, loggedIn: true, blocked: false, soldOut: false };
      if (stage === 'detail') return {
        ...result,
        fields: { event: intent.event, session: intent.session, tier: intent.tier,
          ...(!options.delayedQuantity || ++detailReads >= 3 ? { quantity: quantity + '张' } : {}) },
        controls: {
          ...(options.delayedQuantity ? { increase: choice('+') } : {}),
          ...(!options.noEntry ? { enter: choice('不，立即购票') } : {}),
          ['tier:' + intent.tier]: choice(intent.tier, true),
          'tier:预售票138元': choice('预售票138元'),
          ...(options.duplicatePrice ? { 'tier:其他票88元': choice('其他票88元') } : {}),
        },
      };
      if (stage === 'order') return {
        ...result, fields: { event: intent.event, session: intent.session, tier: intent.tier,
          quantity: '2张', attendees: [...selected], orderId: 'fixture-h5-order', status: '待支付' },
        controls: {},
      };
      return {
        ...result, layout: 'damai_h5', checkoutRef: options.ref ?? (itemId + '_2_99'),
        fields: {
          event: intent.event, session: options.session ?? '2026.12.04 22:00',
          tier: options.ticket ?? '¥88.00票档 ×2张', quantity: '×2张', attendees: [...selected],
        },
        controls: {
          submit: choice('立即提交'),
          ...Object.fromEntries(intent.attendees.map(name => ['attendee:' + name, choice(name, selected.includes(name))])),
        },
      };
    },
    async reloadDetail() {
      clicks.push('reload');
    },
    async click(view, key) {
      if (view.stage === 'checkout') assert.equal(view.fields.tier, options.ticket ?? '¥88.00票档 ×2张');
      clicks.push(key);
      if (key === 'enter') stage = 'checkout';
      else if (key.startsWith('attendee:')) selected.push(key.slice('attendee:'.length));
      else if (key === 'submit') stage = 'order';
      else if (key === 'increase') quantity++;
      return true;
    },
  };
  return { adapter: guardDamaiH5(raw, intent, itemId, rule), clicks };
}

test('H5 trusts only the verified 88-yuan detail entry and passes the original view to clicks', async () => {
  const { adapter, clicks } = fixture();
  const result = await runCheckout(adapter, intent, { mode: 'rehearse' });
  assert.equal(result.status, 'rehearsed');
  assert.deepEqual(clicks, ['enter', 'attendee:演示甲', 'attendee:演示乙']);
});

test('H5 live flow submits only once after all checks and verifies the simulated order', async () => {
  const { adapter, clicks } = fixture();
  let reservations = 0;
  const result = await runCheckout(adapter, intent, {
    mode: 'live', now: () => Date.parse(intent.saleAt) + 100,
    reserve: async () => ++reservations === 1,
  });
  assert.equal(result.status, 'pending_payment');
  assert.equal(reservations, 1);
  assert.deepEqual(clicks, ['enter', 'attendee:演示甲', 'attendee:演示乙', 'submit']);
});

test('H5 waits for the quantity controls before entering when the buy button appears first', async () => {
  const { adapter, clicks } = fixture({ delayedQuantity: true });
  let now = Date.parse(intent.saleAt) - 30;
  const result = await runCheckout(adapter, intent, {
    mode: 'live', now: () => now, sleep: async ms => { now += ms; },
    reserve: async () => true,
  });
  assert.equal(result.status, 'pending_payment');
  assert.deepEqual(clicks, ['increase', 'enter', 'attendee:演示甲', 'attendee:演示乙', 'submit']);
});

test('the live runner reloads only once if the entry remains absent', async () => {
  const { adapter, clicks } = fixture({ noEntry: true });
  let now = Date.parse(intent.saleAt);
  const result = await runCheckout(adapter, intent, {
    mode: 'live', now: () => now, sleep: async ms => { now += ms; }, timeoutMs: 200,
  });
  assert.equal(result.status, 'timeout');
  assert.deepEqual(clicks, ['reload']);
});

for (const [label, options] of [
  ['direct confirmation without a verified entry', { skipEntry: true }],
  ['other event reference', { ref: '1100435904158_2_99' }],
  ['other session', { session: '2026.12.05 22:00' }],
  ['other displayed price', { ticket: '¥138.00票档 ×2张' }],
  ['other displayed quantity', { ticket: '¥88.00票档 ×1张' }],
  ['other quantity reference', { ref: itemId + '_1_99' }],
  ['two tiers at the same price', { duplicatePrice: true }],
]) {
  test('H5 refuses ' + label + ' before selecting or submitting', async () => {
    const { adapter, clicks } = fixture(options);
    assert.equal((await runCheckout(adapter, intent, { mode: 'rehearse' })).status, 'selection_mismatch');
    assert.deepEqual(clicks, options.skipEntry ? [] : ['enter']);
  });
}
