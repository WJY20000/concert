import { chromium } from 'playwright';

const allowedStages = new Set(['detail', 'options', 'seats', 'checkout', 'order', 'orders']);
const allowedActions = new Set(['enter', 'next', 'submit', 'increase', 'decrease', 'orders', 'openOrder']);
const choiceTypes = new Set(['event', 'session', 'tier', 'seat', 'attendee']);
const strings = values => Array.isArray(values) && values.every(value => typeof value === 'string' && value.trim());
const selector = value => typeof value === 'string' && Boolean(value.trim());
const readableAttribute = value => typeof value === 'string' && /^(datetime|value|aria-label|title|data-[a-z0-9-]+)$/u.test(value);


function validateProfile(profile) {
  if (!profile?.stages || !Object.keys(profile.stages).length ||
      !strings(profile.blockers) || !profile.blockers.length || !strings(profile.soldOut)) {
    throw new Error('invalid_web_profile');
  }
  const additionalOrigins = profile.additionalOrigins ?? [];
  if (!strings(additionalOrigins) || additionalOrigins.some(value => {
    const url = new URL(value);
    return url.origin !== value || url.protocol !== 'https:' || value.includes('*');
  })) throw new Error('invalid_web_origins');
  for (const [name, stage] of Object.entries(profile.stages)) {
    const origin = new URL(stage.origin);
    if (!allowedStages.has(name) || origin.origin !== stage.origin || origin.protocol !== 'https:' ||
        (!additionalOrigins.includes(stage.origin) && (origin.port || !/(^|\.)damai\.cn$/u.test(origin.hostname))) ||
        !/^\/(?!\/)[^?#\\]*$/u.test(stage.path) ||
        !Object.values(stage.query ?? {}).every(selector) || !selector(stage.ready) || !selector(stage.login)) {
      throw new Error('invalid_web_stage');
    }
    for (const field of Object.values(stage.fields ?? {})) {
      if (selector(field)) continue;
      if (!selector(field?.selector) || !readableAttribute(field.attribute)) {
        throw new Error('invalid_web_field');
      }
    }
    for (const [key, action] of Object.entries(stage.actions ?? {})) {
      if (!allowedActions.has(key) || !selector(action.selector) || !strings(action.labels) ||
          (!readableAttribute(action.labelAttribute) && action.labelAttribute !== undefined) ||
          !action.labels.length || action.labels.some(label => /支付|付款|收银|\bpay(?:ment)?\b/iu.test(label)) ||
          (key === 'submit' && name !== 'checkout')) throw new Error('invalid_web_action');
    }
    for (const [type, choice] of Object.entries(stage.choices ?? {})) {
      if (!choiceTypes.has(type) || (choice.labelAttribute !== undefined && !readableAttribute(choice.labelAttribute)) ||
          ![choice.rows, choice.label, choice.control, choice.selected].every(selector)) {
        throw new Error('invalid_web_choice');
      }
    }
  }
  if (profile.orderLookupUrl !== undefined) {
    const orders = profile.stages.orders;
    const url = new URL(profile.orderLookupUrl);
    if (!orders || url.username || url.password || url.hash || !routeMatches(url, orders)) {
      throw new Error('invalid_web_order_lookup');
    }
  }
}

function routeMatches(url, stage) {
  const parts = url.pathname.split('/');
  const expected = stage.path.split('/');
  return url.origin === stage.origin && expected.length === parts.length &&
    expected.every((part, i) => part === ':id' ? /^[a-zA-Z0-9_-]+$/u.test(parts[i]) : part === parts[i]) &&
    Object.entries(stage.query ?? {}).every(([key, value]) =>
      url.searchParams.getAll(key).length === 1 && url.searchParams.get(key) === value);
}

function unknown() {
  return { stage: 'unknown', fields: {}, controls: {}, blocked: false, soldOut: false, loggedIn: false };
}

// Runs entirely within the page. Each poll requires one browser round trip.
function inspectDocument({ profile, candidates, url, prior, key, arm }) {
  const view = { stage: 'unknown', fields: {}, controls: {}, blocked: false, soldOut: false, loggedIn: false };
  if (location.href !== url) return prior ? null : view;
  const normalize = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
  const visible = element => element.getClientRects().length > 0 &&
    (typeof element.checkVisibility === 'function'
      ? element.checkVisibility({ visibilityProperty: true, opacityProperty: true })
      : getComputedStyle(element).visibility === 'visible');
  const find = (root, css) => (css === ':scope' ? [root] : [...root.querySelectorAll(css)]).filter(visible);
  const text = element => normalize(/^(INPUT|TEXTAREA|SELECT)$/u.test(element.tagName)
    ? element.value : (element.innerText ?? element.textContent));
  view.blocked = profile.blockers.some(css => find(document, css).length > 0);
  view.soldOut = profile.soldOut.some(css => find(document, css).length > 0);
  const ready = candidates.filter(name => find(document, profile.stages[name].ready).length === 1);
  if (ready.length !== 1) return prior ? null : view;
  view.stage = ready[0];
  const stage = profile.stages[view.stage];
  view.loggedIn = find(document, stage.login).length === 1;
  const damaiOptions = /(^|\.)damai\.cn$/u.test(location.hostname) &&
    ['detail', 'options'].includes(view.stage);
  const optionText = (name, value) => damaiOptions && ['session', 'tier'].includes(name)
    ? value.replace(/\s*可预约$/u, '') : value;
  for (const [name, field] of Object.entries(stage.fields ?? {})) {
    const css = typeof field === 'string' ? field : field.selector;
    const nodes = find(document, css);
    const read = typeof field === 'string' ? text : node => normalize(node.getAttribute(field.attribute));
    if (name === 'seats' || name === 'attendees') view.fields[name] = nodes.map(read);
    else if (nodes.length === 1) view.fields[name] = optionText(name, read(nodes[0]));
  }

  const targets = new Map();
  function register(id, element, label, selected) {
    const duplicate = Object.hasOwn(view.controls, id);
    const enabled = !duplicate && Boolean(element) &&
      !element.closest(':disabled,[aria-disabled=true],[inert]');
    view.controls[id] = { enabled, selected, label };
    targets.set(id, enabled ? element : null);
  }
  for (const [id, action] of Object.entries(stage.actions ?? {})) {
    const labels = action.labels.map(normalize);
    for (const node of find(document, action.selector)) {
      const label = action.labelAttribute ? normalize(node.getAttribute(action.labelAttribute)) : text(node);
      if (labels.includes(label)) register(id, node, label, null);
    }
  }
  for (const [type, choice] of Object.entries(stage.choices ?? {})) {
    for (const row of find(document, choice.rows)) {
      const names = find(row, choice.label);
      if (names.length !== 1) continue;
      const raw = choice.labelAttribute ? normalize(names[0].getAttribute(choice.labelAttribute)) : text(names[0]);
      const label = optionText(type, raw);
      if (!label) continue;
      const selected = row.matches(choice.selected) || Boolean(row.querySelector(choice.selected));
      const controls = find(row, choice.control);
      register(type + ':' + label, controls.length === 1 ? controls[0] : null, label, selected);
    }
  }

  if (!prior) return view;
  if (view.blocked || (view.soldOut && !['orders', 'openOrder'].includes(key)) ||
      !view.loggedIn || view.stage !== prior.stage ||
      !view.controls[key]?.enabled || view.controls[key].selected === true ||
      JSON.stringify(view.fields) !== JSON.stringify(prior.fields) ||
      JSON.stringify(view.controls[key]) !== JSON.stringify(prior.controls[key])) return null;
  // Other choices can change in the same row group while a button retains its text.
  const selectedKeys = controls => Object.keys(controls).filter(id => controls[id].selected === true).sort();
  if (JSON.stringify(selectedKeys(prior.controls)) !== JSON.stringify(selectedKeys(view.controls))) return null;
  const target = targets.get(key);
  if (!target) return null;
  const link = target.closest('a[href]');
  if (link) {
    const destination = new URL(link.href, location.href);
    if (['http:', 'https:'].includes(destination.protocol) &&
        !Object.values(profile.stages).some(stage => stage.origin === destination.origin)) return null;
  }
  if (!arm) return target;

  // A SPA may reuse a button node (e.g. changing its label from submit to pay)
  // during the actionability wait. Check again before dispatch reaches the page.
  let rejected = false;
  const events = ['pointerdown', 'mousedown', 'click'];
  const guard = event => {
    if (!event.isTrusted || !event.composedPath().includes(target)) return;
    // Native checkbox/radio pre-activation briefly changes checked before click listeners run.
    const nativeToggle = key.includes(':') && event.type === 'click' &&
      event.target.matches?.('input[type=checkbox], input[type=radio]');
    if (!rejected && !nativeToggle) {
      try {
        rejected = inspectDocument({ profile, candidates, url, prior, key }) !== target;
      } catch {
        rejected = true;
      }
    }
    if (rejected) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  for (const type of events) window.addEventListener(type, guard, true);
  return {
    target,
    disarm() {
      for (const type of events) window.removeEventListener(type, guard, true);
      return rejected;
    },
  };
}

export function attachWebPage(page, profile, disconnect) {
  validateProfile(profile);
  let active = page;
  const watched = new Set([page]);
  const captures = new WeakMap();
  function followPopup(popup) {
    active = popup;
    watched.add(popup);
    popup.on('popup', followPopup);
  }
  page.on('popup', followPopup);

  function options(target) {
    const url = new URL(target.url());
    if (!Object.values(profile.stages).some(stage => stage.origin === url.origin)) return null;
    return {
      url: url.href, profile,
      candidates: Object.keys(profile.stages).filter(name => routeMatches(url, profile.stages[name])),
    };
  }

  return {
    async snapshot() {
      const target = active;
      if (target.isClosed()) return unknown();
      const input = options(target);
      if (!input) return unknown();
      const view = await target.evaluate(inspectDocument, input).catch(error => {
        if (/execution context was destroyed|cannot find context|frame was detached/iu.test(error.message)) return unknown();
        throw new Error('web_snapshot_failed_check_selectors');
      });
      if (target !== active) return unknown();
      if (view.stage !== 'unknown') captures.set(view, { target, url: input.url, prior: structuredClone(view) });
      return view;
    },

    async inspectLocator(css) {
      const input = options(active);
      if (!input?.candidates.length || !selector(css)) throw new Error('web_inspect_unmapped_route');
      return active.evaluate(({ url, css }) => {
        if (location.href !== url) throw new Error('page_changed');
        const nodes = [...document.querySelectorAll(css)];
        const visible = nodes.filter(node => node.getClientRects().length && node.checkVisibility({
          visibilityProperty: true, opacityProperty: true,
        }));
        return {
          matches: nodes.length,
          visible: visible.length,
          enabled: visible.filter(node => !node.closest(':disabled,[aria-disabled=true],[inert]')).length,
          selected: visible.filter(node => node.matches(':checked,[aria-checked=true],[aria-selected=true]')).length,
        };
      }, { url: input.url, css }).catch(() => { throw new Error('web_invalid_or_stale_locator'); });
    },

    async openOrders() {
      if (!profile.orderLookupUrl) return false;
      const target = await page.context().newPage();
      watched.add(target);
      active = target;
      await target.goto(profile.orderLookupUrl, { waitUntil: 'domcontentloaded', timeout: 4000 });
      return true;
    },

    async click(view, key) {
      const capture = captures.get(view);
      captures.delete(view);
      if (!capture || capture.target !== active || capture.target.isClosed() || active.url() !== capture.url) {
        throw new Error('web_stale_view');
      }
      const input = options(capture.target);
      if (!input || !Object.hasOwn(capture.prior.controls, key)) throw new Error('web_control_unavailable');
      const guard = await capture.target.evaluateHandle(inspectDocument, { ...input, prior: capture.prior, key, arm: true })
        .catch(() => { throw new Error('web_stale_view'); });
      let element;
      let rejected = false;
      try {
        const targetHandle = await guard.getProperty('target').catch(() => null);
        element = targetHandle?.asElement();
        if (!element || active !== capture.target || capture.target.url() !== capture.url) throw new Error('web_stale_view');
        await element.click({ timeout: 900, noWaitAfter: true })
          .catch(() => { throw new Error('web_click_unconfirmed'); });
      } finally {
        // Successful navigation may already have discarded the old document.
        rejected = await guard.evaluate(value => value?.disarm()).catch(() => false);
        await Promise.allSettled([element?.dispose(), guard.dispose()]);
      }
      if (rejected) throw new Error('web_stale_view');
      return true;
    },

    async close() {
      for (const target of watched) target.off('popup', followPopup);
      if (disconnect) await disconnect();
    },
  };
}

export async function connectWeb(profile, { inspection = false } = {}) {
  validateProfile(profile);
  const endpoint = new URL(profile.cdp);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
      !endpoint.port || endpoint.pathname !== '/' || endpoint.search || endpoint.hash ||
      endpoint.username || endpoint.password) throw new Error('loopback_cdp_required');
  const browser = await chromium.connectOverCDP(endpoint.href, { timeout: 5000 })
    .catch(() => { throw new Error('web_cdp_connect_failed'); });
  try {
    const candidates = browser.contexts().flatMap(context => context.pages()).filter(page => {
      const url = new URL(page.url());
      return Object.entries(profile.stages).some(([name, stage]) =>
        (inspection || !['order', 'orders'].includes(name)) && routeMatches(url, stage));
    });
    if (candidates.length !== 1) throw new Error('web_expected_one_purchase_tab');
    return attachWebPage(candidates[0], profile, () => browser.close());
  } catch (error) {
    await browser.close();
    throw error;
  }
}
