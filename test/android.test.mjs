import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { connectAndroid } from '../src/android.mjs';
import { runCheckout } from '../src/engine.mjs';

const packageName = 'cn.damai';
const elementKey = 'element-6066-11e4-a52e-4f735466cecf';

function node(id, text, extra = '', children = '') {
  return `<android.view.View resource-id="${packageName}:id/${id}" text="${text}" package="${packageName}" enabled="true" ${extra}>${children}</android.view.View>`;
}

const commonFields = { event: { id: 'title' }, session: { id: 'session' }, tier: { id: 'tier' }, quantity: { id: 'count' } };
const seatName = 'A区3排12座';
const profile = {
  udid: 'fixture', blockers: [{ text: '安全验证' }], soldOut: [{ text: '售罄' }],
  stages: {
    options: {
      marker: { id: 'options' }, login: { id: 'logged' }, fields: commonFields,
      choices: { tier: { row: { id: 'choose_tier' }, stateAttribute: 'selected' } },
      actions: { next: { target: { id: 'start_seats' }, labels: ['选座'] } },
    },
    seats: {
      marker: { id: 'seats' }, login: { id: 'logged' },
      fields: { ...commonFields, seats: { id: 'seat', selected: true } },
      choices: { seat: { row: { id: 'seat' }, stateAttribute: 'selected' } },
      actions: { next: { target: { id: 'confirm_seats' }, labels: ['确认选座'] } },
    },
    checkout: {
      marker: { id: 'main' }, login: { id: 'logged' },
      fields: {
        ...commonFields, seats: { id: 'seat', selected: true },
        attendees: { id: 'name', within: { id: 'row', has: { id: 'check', checked: true } } },
      },
      choices: {
        attendee: {
          row: { id: 'row' }, name: { id: 'name' }, state: { id: 'check' },
          target: { id: 'check' }, stateAttribute: 'checked',
        },
      },
      actions: { submit: { target: { id: 'send' }, name: { id: 'submit_label' }, labels: ['提交订单'] } },
    },
    order: {
      marker: { id: 'order' }, login: { id: 'logged' },
      fields: { ...commonFields, seats: { id: 'seat', selected: true }, attendees: { id: 'order_name' }, orderId: { id: 'oid' }, status: { id: 'status' }, createdAt: { id: 'created' } },
    },
  },
};

async function device(t, start = 'checkout') {
  const state = { phase: start, tierSelected: false, seatSelected: false, createdAt: '', selected: false, order: false, blocked: false, duplicate: false, app: packageName };
  const requests = [];
  const viewer = '演示甲';
  function source() {
    const row = node('row', '', '', node('name', viewer) + node('check', '', `clickable="true" checked="${state.selected}"`));
    const common = node('title', '示例演出') + node('session', '周六 19:30') + node('count', '1');
    const tier = node('tier', '看台 A');
    const seat = node('seat', seatName, 'clickable="true" selected="' + state.seatSelected + '"');
    const checkout = node('main', '', '', common + tier + seat + row + (state.duplicate ? row : '') +
      node('send', '', 'clickable="true"', node('submit_label', '提交订单')));
    const screens = {
      checkout,
      options: node('options', '', '', common + (state.tierSelected ? tier : '') +
        node('choose_tier', '看台 A', 'clickable="true" selected="' + state.tierSelected + '"') +
        node('start_seats', '选座', 'clickable="true"')),
      seats: node('seats', '', '', common + tier + seat + node('confirm_seats', '确认选座', 'clickable="true"')),
      order: node('order', '', '', common + tier + seat + node('order_name', viewer) +
        node('oid', 'demo') + node('status', '待支付') + node('created', state.createdAt)),
    };
    return '<?xml version="1.0"?><hierarchy>' + node('logged', 'Demo') + screens[state.order ? 'order' : state.phase] +
      (state.blocked ? node('challenge', '安全验证') : '') + '</hierarchy>';
  }
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : null;
    const path = req.url;
    requests.push({ path, method: req.method, body });
    let value = null;
    let status = 200;
    if (path === '/session' && req.method === 'POST') {
      value = { sessionId: 'session-A', capabilities: {} };
    } else if (path === '/session/session-A/source') {
      value = source();
    } else if (path === '/session/session-A/execute/sync' && body.script === 'mobile: getCurrentPackage') {
      value = state.app;
    } else if (path === '/session/session-A/elements') {
      if (body.using === 'xpath' && body.value.includes("'演示甲'") && body.value.includes("@checked='false'") && !state.selected) {
        value = [{ [elementKey]: 'viewer-A' }];
      } else if (body.using === 'xpath' && body.value.includes("'提交订单'")) {
        value = [{ [elementKey]: 'submit-A' }];
      } else {
        const id = ['choose_tier', 'start_seats', 'seat', 'confirm_seats']
          .find(id => body.value.includes("'cn.damai:id/" + id + "'"));
        value = id ? [{ [elementKey]: id }] : [];
      }
    } else if (path === '/session/session-A/element/viewer-A/click') {
      state.selected = true;
    } else if (path === '/session/session-A/element/submit-A/click' && state.selected) {
      state.order = true;
      state.createdAt = new Date().toISOString();
    } else if (path === '/session/session-A/element/choose_tier/click') {
      state.tierSelected = true;
    } else if (path === '/session/session-A/element/start_seats/click' && state.tierSelected) {
      state.phase = 'seats';
    } else if (path === '/session/session-A/element/seat/click' && state.phase === 'seats') {
      state.seatSelected = true;
    } else if (path === '/session/session-A/element/confirm_seats/click' && state.seatSelected) {
      state.phase = 'checkout';
    } else if (path !== '/session/session-A' || req.method !== 'DELETE') {
      status = 400;
      value = { error: 'invalid argument' };
    }
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const adapter = await connectAndroid({ ...profile, endpoint: 'http://127.0.0.1:' + server.address().port });
  return { adapter, requests, state };
}

test('Android W3C session attaches to the active package, resolves the named row and reads the resulting order', async t => {
  const { adapter, requests } = await device(t);
  const initial = await adapter.snapshot();
  assert.equal(initial.stage, 'checkout');
  assert.deepEqual(initial.fields.attendees, []);
  assert.equal(initial.controls['attendee:演示甲'].selected, false);
  assert.deepEqual(await adapter.inspectLocator({ id: 'name', text: '演示甲' }), { matches: 1, visible: 1, enabled: 1, selected: 0 });
  assert.ok(await adapter.click(initial, 'attendee:演示甲'));
  const selected = await adapter.snapshot();
  assert.deepEqual(selected.fields.attendees, ['演示甲']);
  assert.ok(selected.controls['attendee:演示甲'].selected);
  await assert.rejects(adapter.click(selected, 'attendee:演示甲'), /android_page_changed/u);
  assert.ok(await adapter.click(selected, 'submit'));
  const order = await adapter.snapshot();
  assert.equal(order.stage, 'order');
  assert.equal(order.fields.orderId, 'demo');
  assert.equal(order.fields.status, '待支付');
  assert.ok(Number.isFinite(Date.parse(order.fields.createdAt)));
  await adapter.close();
  assert.equal(requests.at(-1).method, 'DELETE');
  const caps = requests[0].body.capabilities.alwaysMatch;
  assert.equal(caps['appium:autoLaunch'], false);
  assert.equal(caps['appium:shouldTerminateApp'], false);
});

test('Android declines a stale view, duplicate name, challenge, and foreign active package before tapping', async t => {
  const { adapter, state, requests } = await device(t);
  const initial = await adapter.snapshot();
  state.selected = true;
  await assert.rejects(adapter.click(initial, 'attendee:演示甲'), /android_page_changed/u);
  state.selected = false;
  state.duplicate = true;
  const duplicate = await adapter.snapshot();
  assert.equal(duplicate.controls['attendee:演示甲'].enabled, false);
  await assert.rejects(adapter.click(duplicate, 'attendee:演示甲'));
  state.duplicate = false;
  state.blocked = true;
  await assert.rejects(adapter.click(initial, 'submit'));
  state.app = 'foreign.app';
  await assert.rejects(adapter.snapshot(), /android_wrong_package/u);
  assert.equal(requests.filter(entry => entry.path.endsWith('/click')).length, 0);
  await adapter.close();
});

test('Android refuses network Appium services', async () => {
  await assert.rejects(connectAndroid({ ...profile, endpoint: 'http://192.0.2.1:4723' }), /android_endpoint_invalid/u);
});

test('runCheckout selects the configured tier, exact seat and viewer through W3C, then confirms a fresh matching order', async t => {
  const { adapter, requests } = await device(t, 'options');
  const intent = {
    saleAt: new Date().toISOString(), event: '示例演出', session: '周六 19:30',
    tier: '看台 A', seats: [seatName], attendees: ['演示甲'], quantity: 1, pendingStatus: '待支付',
  };
  const result = await runCheckout(adapter, intent, { mode: 'live', reserve: async () => true });
  await adapter.close();
  assert.equal(result.status, 'pending_payment');
  assert.deepEqual(requests.filter(entry => entry.path.endsWith('/click')).map(entry => entry.path.split('/')[4]),
    ['choose_tier', 'start_seats', 'seat', 'confirm_seats', 'viewer-A', 'submit-A']);
});

test('Android rejects payment actions and submit mapped outside checkout at profile load', async () => {
  const payment = structuredClone(profile);
  payment.stages.checkout.actions.submit.labels = ['立即支付'];
  await assert.rejects(connectAndroid(payment), /android_action_invalid/u);
  const misplaced = structuredClone(profile);
  misplaced.stages.seats.actions.submit = misplaced.stages.checkout.actions.submit;
  await assert.rejects(connectAndroid(misplaced), /android_action_invalid/u);
});
