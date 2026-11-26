import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { attachWebPage } from '../src/web.mjs';

const detailUrl = 'https://detail.damai.cn/item.htm?id=123';
const checkoutUrl = 'https://buy.damai.cn/checkout';
const profile = {
  cdp: 'http://127.0.0.1:9222',
  blockers: ['.captcha'],
  soldOut: ['.sold-out'],
  stages: {
    detail: {
      origin: 'https://detail.damai.cn',
      path: '/item.htm',
      query: { id: '123' },
      ready: 'main',
      login: '.account',
      fields: { event: '.title' },
      actions: { enter: { selector: 'a', labels: ['不，立即购票'] } },
    },
    checkout: {
      origin: 'https://buy.damai.cn',
      path: '/checkout',
      ready: '.confirm',
      login: '.account',
      fields: { event: '.title', seats: '.selected-seat' },
      choices: {
        attendee: { rows: '.person', label: '.name', control: 'input', selected: 'input:checked' },
      },
      actions: { submit: { selector: 'button', labels: ['提交订单'] } },
    },
  },
};

let browser;
before(async () => {
  browser = await chromium.launch({ executablePath: process.env.TEST_CHROMIUM_PATH || undefined });
});
after(async () => { await browser?.close(); });

const detail = `<main><span class="account">已登录</span><h1 class="title">演示演出</h1>
<a href="/other">扫码购买</a><a href="${checkoutUrl}">不，立即购票</a></main>`;
const checkout = `<main class="confirm"><span class="account">已登录</span><h1 class="title">演示演出</h1>
<span class="selected-seat">A 排 7 号</span><span class="selected-seat">A 排 8 号</span>
<label class="person"><span class="name">演示甲</span><input type="checkbox" checked></label>
<label class="person"><span class="name">演示乙</span><input type="checkbox"></label>
<button>确认支付</button><button>提交订单</button>
<output id="click"></output>
<script>document.addEventListener('click', event => {
  if (event.target.tagName === 'BUTTON') document.getElementById('click').textContent = event.target.textContent;
});</script></main>`;

// Real browser actions are confined to intercepted fixture documents, including redirects and popups.
async function fixture(t, { start = checkoutUrl, detailHtml = detail, checkoutHtml = checkout } = {}) {
  const context = await browser.newContext({ offline: true, serviceWorkers: 'block' });
  context.setDefaultTimeout(4000);
  t.after(() => context.close());
  await context.route('**/*', route => {
    const u = new URL(route.request().url());
    let body;
    if (u.origin === profile.stages.detail.origin && u.pathname === profile.stages.detail.path) body = detailHtml;
    if (u.href === checkoutUrl) body = checkoutHtml;
    if (!body) return route.abort();
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html>' + body });
  });
  const page = await context.newPage();
  await page.goto(start);
  const adapter = attachWebPage(page, profile);
  return { adapter, page };
}

test('web selects the QR fallback and the exact attendee through DOM controls', async t => {
  const { adapter, page } = await fixture(t, { start: detailUrl });
  const entry = await adapter.snapshot();
  assert.equal(entry.stage, 'detail');
  assert.equal(entry.fields.event, '演示演出');
  assert.equal(entry.loggedIn, true);
  await adapter.click(entry, 'enter');
  await page.waitForURL(checkoutUrl);

  const view = await adapter.snapshot();
  assert.equal(view.stage, 'checkout');
  assert.deepEqual(view.fields.seats, ['A 排 7 号', 'A 排 8 号']);
  assert.equal(view.controls['attendee:演示甲'].selected, true);
  assert.equal(view.controls['attendee:演示乙'].selected, false);
  await adapter.click(view, 'attendee:演示乙');
  const selected = await adapter.snapshot();
  assert.equal(selected.controls['attendee:演示甲'].selected, true);
  assert.equal(selected.controls['attendee:演示乙'].selected, true);

  await adapter.click(selected, 'submit');
  assert.equal(await page.locator('#click').textContent(), '提交订单');
});

test('web refuses a previously observed submit action when event or button changes', async t => {
  const { adapter, page } = await fixture(t);
  const view = await adapter.snapshot();
  await page.locator('.title').evaluate(element => { element.textContent = '另一场演出'; });
  await assert.rejects(() => adapter.click(view, 'submit'));
  const changed = await adapter.snapshot();
  await page.getByRole('button', { name: '提交订单' }).evaluate(el => { el.textContent = '确认支付'; });
  await assert.rejects(() => adapter.click(changed, 'submit'));
  assert.equal(await page.locator('#click').textContent(), '');
});

test('web flags challenge and sold-out signals before a previously mapped click', async t => {
  const { adapter, page } = await fixture(t);
  for (const [selector, flag] of [['captcha', 'blocked'], ['sold-out', 'soldOut']]) {
    const beforeSignal = await adapter.snapshot();
    await page.evaluate(name => {
      const message = document.createElement('p');
      message.className = name;
      message.textContent = '请核验页面';
      document.body.append(message);
    }, selector);
    assert.equal((await adapter.snapshot())[flag], true);
    await assert.rejects(() => adapter.click(beforeSignal, 'submit'));
    assert.equal(await page.locator('#click').textContent(), '');
    await page.locator('.' + selector).evaluate(el => el.remove());
  }
});

test('web never acts on ambiguous names or an unrecognized event URL', async t => {
  const { adapter, page } = await fixture(t);
  await page.locator('.person').last().evaluate(el => el.after(el.cloneNode(true)));
  const ambiguous = await adapter.snapshot();
  await assert.rejects(() => adapter.click(ambiguous, 'attendee:演示乙'));
  assert.equal(await page.locator('.person input:checked').count(), 1);
  await page.goto('https://detail.damai.cn/item.htm?id=999');
  const unknown = await adapter.snapshot();
  assert.equal(unknown.stage, 'unknown');
  await assert.rejects(() => adapter.click(unknown, 'enter'));
});

test('web follows a verified checkout popup opened by the selected detail page', async t => {
  const { adapter, page } = await fixture(t, {
    start: detailUrl,
    detailHtml: detail.replace('href="' + checkoutUrl + '"', 'target="_blank" href="' + checkoutUrl + '"'),
  });
  const view = await adapter.snapshot();
  const [popup] = await Promise.all([page.waitForEvent('popup'), adapter.click(view, 'enter')]);
  await popup.waitForLoadState('domcontentloaded');
  const next = await adapter.snapshot();
  assert.equal(next.stage, 'checkout');
  assert.equal(next.fields.event, '演示演出');
});

test('web avoids a button relabeled as payment during the actionability wait', async t => {
  const { adapter, page } = await fixture(t);
  await page.evaluate(() => {
    const cover = document.createElement('div');
    cover.id = 'cover';
    cover.style.cssText = 'position:fixed;inset:0;z-index:99999;background:white';
    document.body.append(cover);
  });
  const view = await adapter.snapshot();
  await page.getByRole('button', { name: '提交订单' }).evaluate(button => {
    setTimeout(() => {
      button.textContent = '确认支付';
      document.querySelector('#cover').remove();
    }, 180);
  });
  await assert.rejects(() => adapter.click(view, 'submit'));
  assert.equal(await page.locator('#click').textContent(), '');
});

test('live runner exercises web options, seat map, selected people and an offline pending order', async t => {
  const { runCheckout } = await import('../src/engine.mjs');
  const origin = 'https://detail.damai.cn';
  const path = '/offline/full-flow';
  const base = { origin, path, login: '.account' };
  const field = key => '.' + key;
  const summary = Object.fromEntries(['event', 'session', 'tier', 'quantity', 'seats', 'attendees'].map(k => [k, field(k)]));
  const choice = key => ({ rows: '.' + key, label: ':scope', control: ':scope', selected: '[aria-pressed=true]' });
  const action = (id, label) => ({ selector: '#' + id, labels: [label] });
  const config = {
    blockers: ['.captcha'], soldOut: ['.soldout'],
    stages: {
      detail: { ...base, ready: '#detail', fields: { event: '.event' }, actions: { enter: action('enter', '不，立即购票') } },
      options: { ...base, ready: '#options', fields: { ...summary, session: '.session[aria-pressed=true]', tier: '.tier[aria-pressed=true]' },
        choices: { session: choice('session'), tier: choice('tier') },
        actions: { next: action('next', '确定'), increase: action('increase', '+') } },
      seats: { ...base, ready: '#seats', fields: { ...summary, seats: '.seat[aria-pressed=true]' },
        choices: { seat: choice('seat') }, actions: { next: action('next', '确认选座') } },
      checkout: { ...base, ready: '#checkout', fields: { ...summary, attendees: '.person[aria-pressed=true]' },
        choices: { attendee: choice('person') }, actions: { submit: action('submit', '提交订单') } },
      order: { ...base, ready: '#order', fields: { ...summary, orderId: '#id', status: '#status' } },
    },
  };
  const intent = {
    event: '示例演出', session: '周六 19:30', tier: '看台 A', quantity: 2, seats: ['A区3排12座', 'A区3排13座'],
    attendees: ['演示甲', '演示乙'], pendingStatus: '待支付',
  };
  // All HTML, network actions, identities and order IDs are generated by this fixture.
  function mount(target) {
    const data = { event: target.event, session: '', tier: '', quantity: 1, seats: [], attendees: [] };
    let stage = 'detail';
    function render() {
      document.body.innerHTML = '<main id="' + stage + '"><p class="account">已登录</p></main>';
      const main = document.querySelector('main');
      const show = (key, value) => {
        const p = document.createElement('p');
        p.className = key;
        p.textContent = String(value);
        main.append(p);
      };
      for (const [key, value] of Object.entries(data)) {
        if (stage === 'options' && ['session', 'tier'].includes(key)) continue;
        if (stage === 'seats' && key === 'seats') continue;
        if (stage === 'checkout' && key === 'attendees') continue;
        for (const item of Array.isArray(value) ? value : [value]) show(key, item);
      }
      function button(key, label, handler, selected) {
        const btn = document.createElement('button');
        if (selected === undefined) btn.id = key;
        else {
          btn.className = key;
          btn.setAttribute('aria-pressed', selected);
        }
        btn.textContent = label;
        btn.onclick = handler;
        main.append(btn);
      }
      const move = (key, label, destination) => button(key, label, () => { stage = destination; render(); });
      if (stage === 'detail') move('enter', '不，立即购票', 'options');
      if (stage === 'options') {
        for (const key of ['session', 'tier']) {
          button(key, target[key], () => { data[key] = target[key]; render(); }, data[key] === target[key]);
        }
        button('increase', '+', () => { data.quantity++; render(); });
        move('next', '确定', 'seats');
      }
      if (stage === 'seats' || stage === 'checkout') {
        const key = stage === 'seats' ? 'seats' : 'attendees';
        for (const item of target[key]) {
          button(stage === 'seats' ? 'seat' : 'person', item, () => {
            data[key].push(item);
            render();
          }, data[key].includes(item));
        }
        if (stage === 'seats') move('next', '确认选座', 'checkout');
        else button('submit', '提交订单', async () => {
          const response = await fetch('/offline/create', { method: 'POST', body: JSON.stringify(data) });
          if (response.ok) { stage = 'order'; render(); }
        });
      }
      if (stage === 'order') main.insertAdjacentHTML('beforeend', '<p id="id">mock-order</p><p id="status">待支付</p>');
    }
    render();
  }
  const context = await browser.newContext({ offline: true, serviceWorkers: 'block' });
  t.after(() => context.close());
  const orders = [];
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url === origin + path) return route.fulfill({ contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><body><script>(' + mount.toString() + ')(' + JSON.stringify(intent) + ')</script>' });
    if (url === origin + '/offline/create' && route.request().method() === 'POST') {
      orders.push(JSON.parse(route.request().postData()));
      return route.fulfill({ status: 201, body: '{}' });
    }
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(origin + path);
  const adapter = attachWebPage(page, config);
  let attempts = 0;
  const result = await runCheckout(adapter, { ...intent, saleAt: new Date().toISOString() }, {
    platform: 'web', mode: 'live', reserve: async () => ++attempts === 1, pollMs: 30, timeoutMs: 7500, confirmMs: 4000,
  });
  assert.equal(result.status, 'pending_payment');
  assert.equal(attempts, 1);
  const { pendingStatus, ...expected } = intent;
  assert.deepEqual(orders, [expected]);
});

test('after an external redirect the runner uses the configured read-only order URL', async t => {
  const { runCheckout } = await import('../src/engine.mjs');
  const origin = 'https://buy.damai.cn';
  const context = await browser.newContext({ offline: true, serviceWorkers: 'block' });
  t.after(() => context.close());
  const intent = {
    event: 'Fixture', session: 'Evening', tier: 'A', quantity: 1, seats: [], attendees: ['Viewer'],
    pendingStatus: '待支付', saleAt: new Date().toISOString(),
  };
  const summary = '<p id="event">Fixture</p><p id="session">Evening</p><p id="tier">A</p>' +
    '<p id="quantity">1</p><p class="viewer">Viewer</p>';
  const fields = { event: '#event', session: '#session', tier: '#tier', quantity: '#quantity', attendees: '.viewer' };
  const login = '<p id="login">Logged in</p>';
  const stage = (path, ready) => ({ origin, path, ready, login: '#login' });
  const config = {
    blockers: ['.challenge'], soldOut: [], orderLookupUrl: origin + '/orders',
    stages: {
      checkout: { ...stage('/checkout', '#submit'), fields,
        actions: { submit: { selector: '#submit', labels: ['提交订单'] } } },
      orders: { ...stage('/orders', '#orders'),
        actions: { openOrder: { selector: 'a', labels: ['订单详情'] } } },
      order: { ...stage('/order/one', '#status'), fields: { ...fields, status: '#status', orderId: '#id',
        createdAt: { selector: 'time', attribute: 'datetime' } } },
    },
  };
  let createdAt;
  let reads = 0;
  await context.route('**/*', async route => {
    const url = route.request().url();
    const html = body => route.fulfill({ contentType: 'text/html; charset=utf-8', body });
    if (url === origin + '/checkout') {
      return html(login + summary + '<button id="submit" onclick="location.href=\'https://pay.test/checkout\'">提交订单</button>');
    }
    if (url === 'https://pay.test/checkout') {
      createdAt = new Date().toISOString();
      return html('<p>Mock payment service</p>');
    }
    if (url === origin + '/orders') {
      reads++;
      return html(login + '<main id="orders"><a href="/order/one">订单详情</a></main>');
    }
    if (url === origin + '/order/one') {
      return html(login + summary + '<p id="status">待支付</p><p id="id">fixture-order</p>' +
        '<time datetime="' + createdAt + '">Fixture time</time>');
    }
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(origin + '/checkout');
  const adapter = attachWebPage(page, config);
  t.after(() => adapter.close());
  const result = await runCheckout(adapter, intent, {
    mode: 'live', platform: 'web', reserve: async () => true, pollMs: 30, confirmMs: 5000,
  });
  assert.equal(result.status, 'pending_payment');
  assert.equal(reads, 1);
});

test('Damai detail strips the reservation badge from seatless tier and session names', async t => {
  const detailHtml = '<main><span class="account">已登录</span><h1 class="title">演示演出</h1>' +
    '<p id="session">2026-12-04 周五 22:00 <span>可预约</span></p>' +
    '<button class="tier chosen">早鸟票88元 <span>可预约</span></button>' +
    '<button class="tier">预售票138元 <span>可预约</span></button>' +
    '<a href="/reserve">预约抢票</a></main>';
  const { page } = await fixture(t, { start: detailUrl, detailHtml });
  const local = structuredClone(profile);
  const stage = local.stages.detail;
  stage.fields.session = '#session';
  stage.fields.tier = '.chosen';
  stage.choices = { tier: { rows: '.tier', label: ':scope', control: ':scope', selected: '.chosen' } };
  const adapter = attachWebPage(page, local);
  t.after(() => adapter.close());
  const view = await adapter.snapshot();
  assert.equal(view.fields.session, '2026-12-04 周五 22:00');
  assert.equal(view.fields.tier, '早鸟票88元');
  assert.equal(view.controls['tier:早鸟票88元'].selected, true);
  assert.equal(view.controls['tier:预售票138元'].selected, false);
  assert.equal(view.controls.enter, undefined);
});

test('web mapping diagnosis reports visible markers even when the stage is ambiguous', async t => {
  const { page } = await fixture(t, { start: detailUrl });
  const local = structuredClone(profile);
  local.stages.options = { ...local.stages.detail, ready: '.sku-panel', login: '.account' };
  const adapter = attachWebPage(page, local);
  t.after(() => adapter.close());
  assert.deepEqual(await adapter.inspectStages(), [
    { stage: 'detail', ready: 1, login: 1 }, { stage: 'options', ready: 0, login: 1 },
  ]);
  await page.locator('main').evaluate(el => el.insertAdjacentHTML('beforeend', '<p class="sku-panel">已打开</p>'));
  assert.equal((await adapter.snapshot()).stage, 'unknown');
  assert.deepEqual(await adapter.inspectStages(), [
    { stage: 'detail', ready: 1, login: 1 }, { stage: 'options', ready: 1, login: 1 },
  ]);
});

test('the shipped Nanjing profile recognizes the presale page and its selected early-bird tier', async t => {
  const { readFile } = await import('node:fs/promises');
  const { runCheckout } = await import('../src/engine.mjs');
  const load = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
  const settings = await load('../profiles/web.json');
  const { intent } = await load('../config.example.json');
  const address = 'https://detail.damai.cn/item.htm?id=1102631725191';
  const document = `<!doctype html>
  <header class="user-header"><a class="J_userinfo_name"><span class="name-user">演示账号</span></a></header>
  <div class="perform"><div class="order">
    <div class="title"><span class="tip">总票代</span><span>${intent.event}</span></div>
    <div class="perform__order__box">
      <div class="perform__order__select__performs">
        <div class="select_right_list_item active"><span>${intent.session} <span>可预约</span></span></div>
      </div>
      <div class="select_right_list_item sku_item active"><div class="skuname">早鸟票88元 <span>可预约</span></div></div>
      <div class="select_right_list_item sku_item"><div class="skuname">预售票138元 <span>可预约</span></div></div>
      <div class="buybtn disabled">预约抢票</div>
    </div>
  </div></div>`;
  const context = await browser.newContext({ offline: true, serviceWorkers: 'block' });
  t.after(() => context.close());
  await context.route('**/*', route => route.request().url() === address
    ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: document }) : route.abort());
  const page = await context.newPage();
  await page.goto(address);
  const adapter = attachWebPage(page, settings);
  t.after(() => adapter.close());
  const view = await adapter.snapshot();
  assert.equal(view.stage, 'detail');
  assert.equal(view.loggedIn, true);
  assert.equal(view.fields.session, intent.session);
  assert.equal(view.fields.tier, intent.tier);
  assert.equal(view.controls['session:' + intent.session].selected, true);
  assert.equal(view.controls['tier:早鸟票88元'].selected, true);
  assert.equal(view.controls['tier:预售票138元'].selected, false);
  assert.equal(view.controls.enter, undefined);
  const existingConfig = { ...intent, event: intent.event.replace('】12', '】 12').replace('｜', ' | ') };
  assert.equal((await runCheckout(adapter, existingConfig)).status, 'observed');

  await page.locator('.buybtn').evaluate(el => { el.textContent = '立即购买'; });
  assert.equal((await adapter.snapshot()).controls.enter, undefined);
  await page.locator('.buybtn').evaluate(el => el.classList.remove('disabled'));
  assert.equal((await adapter.snapshot()).controls.enter.enabled, true);
});

test('checkout probe reports mapped structure while leaving names and other personal text local', async t => {
  const { inspectControls } = await import('../tools/probe-rehearsal.mjs');
  const { page } = await fixture(t, { checkoutHtml: `
    <main class="confirm"><p class="account">已登录</p>
    <h1 class="title">【北京】演练音乐会</h1>
    <p class="session">2026.12.31 20:00</p><p class="sku">¥247.00票档 ×2张</p>
    <div id="dmViewerBlock_DmViewerBlock"><h2>实名观演人</h2>
    <label class="person"><span class="name">演示甲</span><input type="checkbox"></label>
    <label class="person"><span class="name">演示乙</span><input type="checkbox" checked></label>
    <p class="contact">12345678901</p></div><button class="submit">立即提交</button></main>` });
  const result = await page.evaluate(inspectControls, ['演示甲', '演示乙']);
  assert.equal(result.attendeeRows.length, 2);
  assert.equal(result.attendeeRows[1][0][0].classes[0], 'name');
  assert.equal(result.attendeeRows[1][0][1].checks[0].checked, true);
  assert.equal(result.submit[0][0].classes[0], 'submit');
  assert.equal(result.ticketLine[0][0].classes[0], 'sku');
  assert.doesNotMatch(JSON.stringify(result), /演示甲|演示乙|12345678901/u);
});

test('probe can set the rehearsal quantity and follow a QR link without selecting or submitting', async t => {
  const { readFile } = await import('node:fs/promises');
  const { openCheckoutForProbe } = await import('../tools/probe-rehearsal.mjs');
  const profile = JSON.parse(await readFile(new URL('../profiles/web.json', import.meta.url), 'utf8'));
  const item = '1100435904158';
  const address = 'https://detail.damai.cn/item.htm?id=' + item;
  const confirm = 'https://m.damai.cn/app/dmfe/h5-ultron-buy/index.html';
  const context = await browser.newContext({ offline: true, serviceWorkers: 'block' });
  t.after(() => context.close());
  const html = `<header class="user-header"><a class="J_userinfo_name"><span class="name-user">演示账号</span></a></header>
    <div class="perform"><div class="order">
      <div class="title"><span class="tip">总票代</span><span>【北京】演练音乐会</span></div>
      <div class="perform__order__box">
        <div class="perform__order__select__performs">
          <div class="select_right_list_item active"><span>2026-12-31 周四 20:00</span></div>
        </div>
        <div class="select_right_list_item sku_item active"><div class="skuname">247元票档</div></div>
        <div class="perform__order__price"><div class="number">
          <button class="plus" onclick="document.querySelector('.num').textContent='2 张'">+</button>
          <span class="num">1 张</span>
        </div></div>
        <div class="qrcode-wrapper"><a class="buy-link" target="_blank" href="${confirm}?fixture=ok">不，立即购票</a></div>
      </div>
    </div></div>`;
  let slide = 0;
  let submit = 0;
  await context.route('**/*', route => {
    const request = route.request();
    if (request.url() === address) return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    if (request.url().startsWith(confirm + '?')) {
      slide++;
      return route.fulfill({ contentType: 'text/html; charset=utf-8',
        body: '<h1>实名观演人</h1><input type="checkbox"><input type="checkbox">' +
          '<button onclick="fetch(\'/offline-submit\', {method:\'POST\'})">立即提交</button>' });
    }
    if (request.method() === 'POST') submit++;
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(address);
  const reached = await openCheckoutForProbe(page, profile, { attendees: ['演示甲', '演示乙'] }, item);
  await reached.waitForLoadState('domcontentloaded');
  assert.equal(await page.locator('.num').textContent(), '2 张');
  assert.equal(reached.url(), confirm + '?fixture=ok');
  assert.equal(await reached.locator('input:checked').count(), 0);
  assert.equal(slide, 1);
  assert.equal(submit, 0);
});

test('checkout probe identifies the changed custom attendee state without printing names', async t => {
  const { inspectControls, compareAttendeeStates } = await import('../tools/probe-rehearsal.mjs');
  const { page } = await fixture(t, { checkoutHtml: `
    <main class="confirm">
      <h1>【北京】演练音乐会</h1>
      <p>2026.12.31 20:00</p><p>¥247.00票档 ×2张</p>
      <div id="viewer"><h2>实名观演人</h2><section>
        <div><div class="viwer-info-name"><div>演示甲</div></div><div class="indicator" style="background-color: white"></div></div>
        <div><div class="viwer-info-name"><div>演示乙</div></div><div class="indicator" style="background-color: white"></div></div>
      </section></div><button>立即提交</button>
    </main>` });
  const input = { names: ['演示甲', '演示乙'], detailed: true };
  const before = await page.evaluate(inspectControls, input);
  await page.locator('.indicator').first().evaluate(el => { el.style.backgroundColor = 'red'; });
  const after = await page.evaluate(inspectControls, input);
  const result = compareAttendeeStates(before, after);
  assert.equal(result.length, 1);
  assert.equal(result[0].row, 1);
  assert.equal(result[0].changed[0].after.background, 'rgb(255, 0, 0)');
  assert.match(before.attendeeRows[0].name, /^#viewer >/u);
  assert.equal(await page.locator(before.attendeeRows[0].name).count(), 1);
  assert.doesNotMatch(JSON.stringify({ before, result }), /演示甲|演示乙/u);
});
