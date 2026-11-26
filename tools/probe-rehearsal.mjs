import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { loadConfig } from '../src/config.mjs';
import { attachWebPage } from '../src/web.mjs';
import { rehearsalIntent, rehearsalProfile } from './prepare-rehearsal.mjs';

const checkoutRoutes = new Set([
  'https://m.damai.cn/app/dmfe/h5-ultron-buy/index.html',
  'https://buy.damai.cn/orderConfirm',
]);

// Read only named control structure. Never export DOM text or URL parameters.
export function inspectControls(names) {
  const visible = node => node.getClientRects().length > 0 &&
    node.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  const clean = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
  const valid = token => /^[A-Za-z_][\w-]{0,63}$/u.test(token);
  const shapes = node => {
    const result = { tag: node.tagName.toLowerCase() };
    if (valid(node.id)) result.id = node.id;
    const classes = [...node.classList].filter(valid).slice(0, 6);
    if (classes.length) result.classes = classes;
    for (const key of ['role', 'view-name', 'type']) {
      const value = node.getAttribute(key);
      if (valid(value)) result[key] = value;
    }
    for (const key of ['checked', 'aria-checked', 'aria-selected', 'data-checked']) {
      const value = node.getAttribute(key);
      if (value === 'true' || value === 'false') result[key] = value;
    }
    if (node instanceof HTMLInputElement && node.type === 'checkbox') result.checked = node.checked;
    return result;
  };
  const all = [...document.querySelectorAll('h1,h2,h3,p,button,span,div,label,strong,time')];
  const pick = predicate => all.filter(node => {
    const value = clean(node.innerText);
    return value.length <= 180 && predicate(value) && visible(node) &&
      ![...node.children].some(child => predicate(clean(child.innerText)) && visible(child));
  }).slice(0, 3).map(node => {
    const ancestors = [];
    for (let parent = node; parent && parent !== document.body && ancestors.length < 5; parent = parent.parentElement) {
      const checkboxes = [...parent.querySelectorAll(
        'input[type=checkbox],[role=checkbox],[aria-checked],[view-name*="check" i],[class*="checkbox" i]')]
        .filter(visible).slice(0, 4);
      ancestors.push({ ...shapes(parent), ...(checkboxes.length ? { checks: checkboxes.map(shapes) } : {}) });
    }
    return ancestors;
  });
  return {
    event: pick(value => /^【[^】]+】.*(?:音乐会|演出|巡演|演唱会|跨年)/u.test(value)),
    session: pick(value => /^20\d\d[./-]\d\d[./-]\d\d.*\d\d:\d\d$/u.test(value)),
    ticketLine: pick(value => /票档.*[×xX]\s*\d+\s*张/u.test(value)),
    quantity: pick(value => /^(?:[×xX]\s*)?\d+\s*张$/u.test(value)),
    viewerHeading: pick(value => value === '实名观演人'),
    attendeeRows: names.map(name => pick(value => value === name)),
    submit: pick(value => ['提交订单', '立即提交', '确认下单', '确认提交订单', '同意以上协议并提交订单'].includes(value)),
  };
}

function routeOf(page) {
  const url = new URL(page.url());
  return url.origin + url.pathname;
}

const quantityOf = value => Number(String(value ?? '').match(/^(\d+)\s*张?$/u)?.[1]);

export async function openCheckoutForProbe(page, profile, intent, itemId) {
  const mobile = rehearsalProfile(profile, itemId, 'h5');
  const desktop = rehearsalProfile(profile, itemId, 'desktop');
  // The adapter may navigate to either approved origin. Only detail controls are actionable here.
  const routeStage = ({ origin, path }) => ({ origin, path, ready: 'body', login: 'body' });
  const adapter = attachWebPage(page, { ...mobile, stages: {
    detail: mobile.stages.detail,
    checkout: routeStage(mobile.stages.checkout),
    orders: routeStage(desktop.stages.checkout),
  } });
  let active = page;
  const follow = popup => { active = popup; };
  page.on('popup', follow);
  try {
    let view = await adapter.snapshot();
    const target = rehearsalIntent(intent, view);
    const sameSelection = now => now.stage === 'detail' && now.loggedIn && !now.blocked && !now.soldOut &&
      ['event', 'session', 'tier'].every(key => now.fields[key] === target[key]);
    let current = quantityOf(view.fields.quantity);
    if (!Number.isSafeInteger(current) || current < 1) {
      throw new Error('practice_quantity_unverified');
    }
    const adjustmentEndsAt = Date.now() + 15_000;
    while (current !== target.quantity) {
      if (Date.now() >= adjustmentEndsAt) throw new Error('practice_quantity_unverified');
      const change = current < target.quantity ? 'increase' : 'decrease';
      const expected = current + (change === 'increase' ? 1 : -1);
      if (!sameSelection(view) || !view.controls[change]?.enabled || !await adapter.click(view, change)) {
        throw new Error('practice_quantity_unverified');
      }
      const deadline = Date.now() + 2500;
      do {
        view = await adapter.snapshot();
        if (!sameSelection(view)) throw new Error('practice_detail_changed');
        if (quantityOf(view.fields.quantity) === expected) break;
        await sleep(80);
      } while (Date.now() < deadline);
      current = quantityOf(view.fields.quantity);
      if (current !== expected) throw new Error('practice_quantity_unverified');
    }
    if (!sameSelection(view) || !view.controls.enter?.enabled || !await adapter.click(view, 'enter')) {
      throw new Error('practice_detail_changed');
    }
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (checkoutRoutes.has(routeOf(active))) return active;
      await sleep(100);
    }
    throw new Error('practice_checkout_not_reached');
  } finally {
    page.off('popup', follow);
    await adapter.close();
  }
}

async function probePage(page, names) {
  const route = routeOf(page);
  if (!checkoutRoutes.has(route)) throw new Error('practice_checkout_not_reached');
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
  let structure;
  const deadline = Date.now() + 5000;
  do {
    structure = await page.evaluate(inspectControls, names);
    if (routeOf(page) !== route) throw new Error('practice_checkout_not_reached');
    if (structure.viewerHeading.length || structure.submit.length) break;
    await sleep(150);
  } while (Date.now() < deadline);
  return { route, ...structure };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const safe = new Set([
    'open_one_damai_checkout_in_debug_chrome', 'open_one_selected_detail_in_debug_chrome',
    'web_cdp_connect_failed', 'loopback_cdp_required', 'invalid_rehearsal_arguments', 'web_stale_view', 'web_click_unconfirmed',
    'practice_detail_not_ready', 'practice_quantity_unverified', 'practice_detail_changed', 'practice_checkout_not_reached',
  ]);
  try {
    const [first, itemId, openConfig, extra] = process.argv.slice(2);
    const open = first === '--open';
    if ((open && (!/^\d{6,20}$/u.test(itemId ?? '') || extra)) || (!open && itemId)) {
      throw new Error('invalid_rehearsal_arguments');
    }
    const { intent, profile } = await loadConfig((open ? openConfig : first) ?? 'config.local.json', { platform: 'web' });
    const endpoint = new URL(profile.cdp);
    if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
        !endpoint.port || endpoint.pathname !== '/' || endpoint.username || endpoint.password ||
        endpoint.search || endpoint.hash) throw new Error('loopback_cdp_required');
    const browser = await chromium.connectOverCDP(endpoint.href, { timeout: 5000 })
      .catch(() => { throw new Error('web_cdp_connect_failed'); });
    try {
      const pages = browser.contexts().flatMap(context => context.pages()).filter(page => {
        const url = new URL(page.url());
        if (!open) return checkoutRoutes.has(routeOf(page));
        const ids = url.searchParams.getAll('id');
        return routeOf(page) === 'https://detail.damai.cn/item.htm' && ids.length === 1 && ids[0] === itemId;
      });
      if (pages.length !== 1) throw new Error(open
        ? 'open_one_selected_detail_in_debug_chrome' : 'open_one_damai_checkout_in_debug_chrome');
      const target = open ? await openCheckoutForProbe(pages[0], profile, intent, itemId) : pages[0];
      console.log(JSON.stringify(await probePage(target, intent.attendees)));
    } finally {
      await browser.close();
    }
  } catch (error) {
    console.error(JSON.stringify({ status: safe.has(error.message) ? error.message : 'rehearsal_probe_failed' }));
    process.exitCode = 1;
  }
}
