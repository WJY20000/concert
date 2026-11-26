import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { loadConfig } from '../src/config.mjs';

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

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { intent, profile } = await loadConfig(process.argv[2] ?? 'config.local.json', { platform: 'web' });
    const endpoint = new URL(profile.cdp);
    if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
        !endpoint.port || endpoint.pathname !== '/' || endpoint.username || endpoint.password ||
        endpoint.search || endpoint.hash) throw new Error();
    const browser = await chromium.connectOverCDP(endpoint.href, { timeout: 5000 });
    try {
      const pages = browser.contexts().flatMap(context => context.pages()).filter(page => {
        const url = new URL(page.url());
        return checkoutRoutes.has(url.origin + url.pathname);
      });
      if (pages.length !== 1) throw new Error();
      const url = new URL(pages[0].url());
      const route = url.origin + url.pathname;
      const structure = await pages[0].evaluate(inspectControls, intent.attendees);
      if (new URL(pages[0].url()).origin + new URL(pages[0].url()).pathname !== route) throw new Error();
      console.log(JSON.stringify({ route, ...structure }));
    } finally {
      await browser.close();
    }
  } catch {
    console.error(JSON.stringify({ status: 'open_one_damai_checkout_in_debug_chrome' }));
    process.exitCode = 1;
  }
}
