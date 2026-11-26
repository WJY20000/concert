import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { loadConfig } from '../src/config.mjs';
import { runCheckout } from '../src/engine.mjs';
import { attachWebPage } from '../src/web.mjs';
import { rehearsalIntent, rehearsalProfile } from './prepare-rehearsal.mjs';

const checkoutRoutes = new Set([
  'https://m.damai.cn/app/dmfe/h5-ultron-buy/index.html',
  'https://buy.damai.cn/orderConfirm',
]);

// Read only named control structure. Never export DOM text or URL parameters.
export function inspectControls(input) {
  const names = Array.isArray(input) ? input : input.names;
  const detailed = !Array.isArray(input) && input.detailed;
  const visible = node => node.getClientRects().length > 0 &&
    node.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  const clean = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
  const valid = token => typeof token === 'string' && /^[A-Za-z_][\w-]{0,63}$/u.test(token);
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
  const pickNodes = predicate => all.filter(node => {
    const value = clean(node.innerText);
    return value.length <= 180 && predicate(value) && visible(node) &&
      ![...node.children].some(child => predicate(clean(child.innerText)) && visible(child));
  }).slice(0, 3);
  const pick = predicate => pickNodes(predicate).map(node => {
    const ancestors = [];
    for (let parent = node; parent && parent !== document.body && ancestors.length < 5; parent = parent.parentElement) {
      const checkboxes = [...parent.querySelectorAll(
        'input[type=checkbox],[role=checkbox],[aria-checked],[view-name*="check" i],[class*="checkbox" i]')]
        .filter(visible).slice(0, 4);
      ancestors.push({ ...shapes(parent), ...(checkboxes.length ? { checks: checkboxes.map(shapes) } : {}) });
    }
    return ancestors;
  });
  const rules = {
    event: value => /^【[^】]+】.*(?:音乐会|演出|巡演|演唱会|跨年)/u.test(value),
    session: value => /^20\d\d[./-]\d\d[./-]\d\d.*\d\d:\d\d$/u.test(value),
    ticketLine: value => /票档.*[×xX]\s*\d+\s*张/u.test(value),
    quantity: value => /^(?:[×xX]\s*)?\d+\s*张$/u.test(value),
    viewerHeading: value => value === '实名观演人',
    submit: value => ['提交订单', '立即提交', '确认下单', '确认提交订单', '同意以上协议并提交订单'].includes(value),
  };
  if (!detailed) {
    return {
      ...Object.fromEntries(Object.entries(rules).map(([key, rule]) => [key, pick(rule)])),
      attendeeRows: names.map(name => pick(value => value === name)),
    };
  }

  function selector(node) {
    const parts = [];
    for (let item = node; item && item !== document.body; item = item.parentElement) {
      if (valid(item.id) && document.querySelectorAll('#' + CSS.escape(item.id)).length === 1) {
        return ['#' + CSS.escape(item.id), ...parts].join(' > ');
      }
      const peers = [...(item.parentElement?.children ?? [])].filter(peer => peer.tagName === item.tagName);
      const tag = CSS.escape(item.tagName.toLowerCase());
      parts.unshift(peers.length > 1 ? tag + ':nth-of-type(' + (peers.indexOf(item) + 1) + ')' : tag);
    }
    return ['body', ...parts].join(' > ');
  }

  function state(node) {
    const computed = getComputedStyle(node);
    const output = { ...shapes(node), visible: visible(node) };
    if (node.hasAttribute('style') || ['img', 'svg', 'path'].includes(output.tag)) {
      output.color = computed.color;
      output.background = computed.backgroundColor;
      output.opacity = computed.opacity;
      if (/^#[0-9a-f]{3,8}$/iu.test(node.getAttribute('fill') ?? '')) output.fill = node.getAttribute('fill');
      // Distinguish swapped assets without emitting data URLs or request parameters.
      const asset = node.getAttribute('src') ?? node.getAttribute('d') ?? computed.backgroundImage;
      if (asset && asset !== 'none') {
        let hash = 2166136261;
        for (const char of asset.slice(0, 16_384)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
        output.asset = (hash >>> 0).toString(16);
      }
    }
    return output;
  }

  const nameNodes = names.map(name => pickNodes(value => value === name));
  const result = {
    selectors: Object.fromEntries(Object.entries(rules).map(([key, rule]) => [key, pickNodes(rule).map(selector)])),
    attendeeRows: nameNodes.map(matches => {
      if (matches.length !== 1) return null;
      const name = matches[0];
      let row = name;
      for (let depth = 0; depth < 5 && row.parentElement !== document.body; depth++) {
        const parent = row.parentElement;
        if (nameNodes.flat().some(other => other !== name && parent.contains(other))) break;
        row = parent;
      }
      return {
        name: selector(name), row: selector(row),
        nodes: [row, ...row.querySelectorAll('*')].slice(0, 75).map(node => ({ selector: selector(node), ...state(node) })),
      };
    }),
  };
  return result;
}

function routeOf(page) {
  const url = new URL(page.url());
  return url.origin + url.pathname;
}

function matchingDetails(tabs, itemId) {
  return tabs.filter(page => {
    const url = new URL(page.url());
    const ids = url.searchParams.getAll('id');
    return routeOf(page) === 'https://detail.damai.cn/item.htm' && ids.length === 1 && ids[0] === itemId;
  });
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

export function compareAttendeeStates(before, after) {
  const differences = [];
  for (const [index, row] of before.attendeeRows.entries()) {
    const latest = after.attendeeRows[index];
    if (!row || !latest) continue;
    const previous = new Map(row.nodes.map(node => [node.selector, node]));
    const changed = latest.nodes.flatMap(node => {
      const old = previous.get(node.selector);
      return JSON.stringify(old) === JSON.stringify(node) ? [] : [{ before: old ?? null, after: node }];
    });
    const seen = new Set(latest.nodes.map(node => node.selector));
    for (const node of row.nodes) if (!seen.has(node.selector)) changed.push({ before: node, after: null });
    if (changed.length) differences.push({ row: index + 1, changed: changed.slice(0, 12) });
  }
  return differences;
}

async function watchCheckbox(page, names) {
  const route = routeOf(page);
  const capture = () => page.evaluate(inspectControls, { names, detailed: true });
  const before = await capture();
  const attendees = before.attendeeRows.map(row => row && ({ name: row.name, row: row.row }));
  if (!attendees.some(Boolean)) return { route, selectors: before.selectors, attendees, changed: [] };
  console.error('现在请手动勾选一位观演人，保持在确认页。脚本只读取变化。');
  const deadline = Date.now() + 45_000;
  let changed = [];
  while (Date.now() < deadline) {
    if (routeOf(page) !== route) throw new Error('practice_checkout_not_reached');
    changed = compareAttendeeStates(before, await capture());
    if (changed.length) break;
    await sleep(250);
  }
  return { route, selectors: before.selectors, attendees, changed };
}

function h5Ticket(page, itemId) {
  const url = new URL(page.url());
  if (url.origin + url.pathname !== 'https://m.damai.cn/app/dmfe/h5-ultron-buy/index.html') return null;
  const values = url.searchParams.getAll('buyParam');
  const parts = values.length === 1 && values[0].match(/^(\d+)_(\d+)_(\d+)$/u);
  if (!parts || parts[1] !== itemId || !Number.isSafeInteger(Number(parts[2]))) return null;
  return { buyParam: values[0], quantity: Number(parts[2]) };
}

export async function rehearseH5(page, profile, intent, itemId, emit) {
  const ticket = h5Ticket(page, itemId);
  if (!ticket) throw new Error('practice_checkout_item_unverified');
  if (ticket.quantity !== intent.attendees.length) throw new Error('practice_quantity_unverified');
  const file = new URL('../profiles/damai-h5-checkout.json', import.meta.url);
  const checkout = JSON.parse(await readFile(file, 'utf8'));
  checkout.query = { buyParam: ticket.buyParam };
  const adapter = attachWebPage(page, {
    blockers: profile.blockers, soldOut: profile.soldOut, stages: { checkout },
  });
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 });
    const deadline = Date.now() + 5000;
    let fields;
    do {
      const view = await adapter.snapshot();
      if (view.blocked || view.soldOut) throw new Error('practice_checkout_fields_unverified');
      if (view.stage === 'checkout' && ['event', 'session', 'tier', 'quantity'].every(key => view.fields[key])) {
        fields = view.fields;
        break;
      }
      await sleep(100);
    } while (Date.now() < deadline);
    if (!fields) throw new Error('practice_checkout_fields_unverified');
    // Use the displayed details of this verified rehearsal page. Live intent has its own configuration.
    const { event, session, tier } = fields;
    // This entry point cannot invoke submit, including if the shared runner changes later.
    const guarded = {
      snapshot: adapter.snapshot,
      click(view, key) {
        if (view.stage !== 'checkout' || !key.startsWith('attendee:')) throw new Error('practice_checkout_action_denied');
        return adapter.click(view, key);
      },
    };
    return await runCheckout(guarded, {
      ...intent, event, session, tier, quantity: ticket.quantity, saleAt: null, seats: [],
    }, { platform: 'web', mode: 'rehearse', emit });
  } finally {
    await adapter.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const safe = new Set([
    'open_one_damai_checkout_in_debug_chrome', 'open_one_selected_detail_in_debug_chrome',
    'web_cdp_connect_failed', 'loopback_cdp_required', 'invalid_rehearsal_arguments', 'web_stale_view', 'web_click_unconfirmed',
    'practice_detail_not_ready', 'practice_quantity_unverified', 'practice_detail_changed', 'practice_checkout_not_reached',
    'practice_checkout_item_unverified', 'practice_checkout_fields_unverified',
  ]);
  try {
    const [first, itemId, openConfig, extra] = process.argv.slice(2);
    const open = first === '--open';
    const rehearse = first === '--rehearse';
    const watch = first === '--watch-check';
    if (((open || rehearse) && (!/^\d{6,20}$/u.test(itemId ?? '') || extra)) ||
        (watch && openConfig) || (!open && !rehearse && !watch && itemId)) {
      throw new Error('invalid_rehearsal_arguments');
    }
    const filename = (open || rehearse ? openConfig : watch ? itemId : first) ?? 'config.local.json';
    const { intent, profile } = await loadConfig(filename, { platform: 'web' });
    const endpoint = new URL(profile.cdp);
    if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
        !endpoint.port || endpoint.pathname !== '/' || endpoint.username || endpoint.password ||
        endpoint.search || endpoint.hash) throw new Error('loopback_cdp_required');
    const browser = await chromium.connectOverCDP(endpoint.href, { timeout: 5000 })
      .catch(() => { throw new Error('web_cdp_connect_failed'); });
    try {
      const tabs = browser.contexts().flatMap(context => context.pages());
      if (rehearse) {
        const pages = tabs.filter(page => h5Ticket(page, itemId));
        if (pages.length > 1) throw new Error('practice_checkout_item_unverified');
        let target = pages[0];
        if (!target) {
          const details = matchingDetails(tabs, itemId);
          if (details.length !== 1) throw new Error('practice_checkout_item_unverified');
          target = await openCheckoutForProbe(details[0], profile, intent, itemId);
        }
        const result = await rehearseH5(target, profile, intent, itemId, event => console.log(JSON.stringify(event)));
        if (result.status !== 'rehearsed') process.exitCode = 1;
      } else {
        const pages = open ? matchingDetails(tabs, itemId) : tabs.filter(page => checkoutRoutes.has(routeOf(page)));
        if (pages.length !== 1) throw new Error(open
          ? 'open_one_selected_detail_in_debug_chrome' : 'open_one_damai_checkout_in_debug_chrome');
        const target = open ? await openCheckoutForProbe(pages[0], profile, intent, itemId) : pages[0];
        const result = watch ? await watchCheckbox(target, intent.attendees) : await probePage(target, intent.attendees);
        console.log(JSON.stringify(result));
      }
    } finally {
      await browser.close();
    }
  } catch (error) {
    console.error(JSON.stringify({ status: safe.has(error.message) ? error.message : 'rehearsal_probe_failed' }));
    process.exitCode = 1;
  }
}
