import { setTimeout as delay } from 'node:timers/promises';

const purchaseStages = new Set(['detail', 'options', 'seats', 'checkout']);
const submitLabels = new Set(['提交订单', '立即提交', '确认下单', '确认提交订单', '同意以上协议并提交订单', 'Create order']);
const clean = value => typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ') : '';
export const eventKey = value => clean(value).replace(/】 +/gu, '】').replace(/ *[|｜] */gu, '|');
export const ticketQuantity = value => {
  const digits = String(value ?? '').trim().match(/^(?:[×xX]\s*)?(\d+)\s*张?$/u);
  return digits ? Number(digits[1]) : NaN;
};

function sameList(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const normalized = new Set(actual.map(clean));
  return normalized.size === expected.length && expected.every(item => normalized.has(item));
}

function matchesIntent(fields, intent) {
  return eventKey(fields.event) === eventKey(intent.event) &&
    ['session', 'tier'].every(key => clean(fields[key]) === intent[key]) &&
    ticketQuantity(fields.quantity) === intent.quantity && sameList(fields.attendees, intent.attendees) &&
    (!intent.seats.length || sameList(fields.seats, intent.seats));
}

function chooseMany(view, group, field, targets) {
  const selected = view.fields[field];
  if (!Array.isArray(selected)) return { error: 'selection_unavailable' };
  const existing = selected.map(clean);
  if (new Set(existing).size !== existing.length || existing.some(value => !targets.includes(value))) {
    return { error: 'selection_mismatch' };
  }
  for (const [key, control] of Object.entries(view.controls)) {
    if (key.startsWith(group + ':') && control.selected === true &&
        !existing.includes(clean(control.label))) return { error: 'selection_mismatch' };
  }
  let next;
  for (const value of targets) {
    const key = group + ':' + value;
    const control = view.controls[key];
    if (existing.includes(value)) {
      if (control && control.selected !== true) return { error: 'selection_mismatch' };
    } else {
      if (!control || control.selected !== false || clean(control.label) !== value || !control.enabled) {
        return { error: 'selection_unavailable' };
      }
      next ??= { key };
    }
  }
  return next;
}

function nextStep(view, intent) {
  const { stage, fields, controls } = view;
  if (view.blocked) return { error: 'challenge' };
  if (view.soldOut) return { error: 'sold_out' };
  if (view.checkoutMismatch) return { error: 'selection_mismatch' };
  if (!purchaseStages.has(stage)) return { error: 'page_unrecognized' };
  if (!view.loggedIn) return { error: 'login_unverified' };
  if (!clean(fields.event)) return { error: 'selection_unavailable' };
  if (eventKey(fields.event) !== eventKey(intent.event)) return { error: 'wrong_event' };

  if (stage === 'checkout') {
    if (!clean(fields.session) || !clean(fields.tier) || !Number.isSafeInteger(ticketQuantity(fields.quantity)) ||
        (intent.seats.length && !Array.isArray(fields.seats))) return { error: 'selection_unavailable' };
    if (['session', 'tier'].some(key => clean(fields[key]) !== intent[key]) ||
        ticketQuantity(fields.quantity) !== intent.quantity ||
        (intent.seats.length && !sameList(fields.seats, intent.seats))) return { error: 'selection_mismatch' };
    const choose = chooseMany(view, 'attendee', 'attendees', intent.attendees);
    if (choose) return choose;
    if (!matchesIntent(fields, intent)) return { error: 'selection_mismatch' };
    const submit = controls.submit;
    if (submit && !submitLabels.has(clean(submit.label))) return { error: 'unexpected_submit_label' };
    return { key: 'submit' };
  }

  for (const name of ['session', 'tier']) {
    const key = name + ':' + intent[name];
    const target = controls[key];
    if (target && target.selected !== true) {
      if (clean(fields[name]) === intent[name] || target.selected !== false || clean(target.label) !== intent[name]) return { error: 'selection_unavailable' };
      return { key };
    }
    if ((fields[name] && clean(fields[name]) !== intent[name]) ||
        (!target && Object.keys(controls).some(id => id.startsWith(name + ':')))) {
      return { error: 'selection_mismatch' };
    }
  }
  // Some pages reveal quantity only after the ticket tier or seats have been chosen.
  if (stage !== 'seats' && fields.quantity !== undefined) {
    const current = ticketQuantity(fields.quantity);
    if (!Number.isSafeInteger(current)) return { error: 'selection_unavailable' };
    if (current !== intent.quantity) {
      const key = current < intent.quantity ? 'increase' : 'decrease';
      if (!controls[key]) return { error: 'selection_mismatch' };
      return { key, revision: String(current) };
    }
  }
  if (stage === 'seats' || Object.keys(controls).some(key => key.startsWith('seat:'))) {
    if (!intent.seats.length) return { error: 'selection_unavailable' };
    const choice = chooseMany(view, 'seat', 'seats', intent.seats);
    if (choice) return choice;
  }
  return { key: stage === 'detail' ? 'enter' : 'next' };
}

function freshOrder(view, intent, attemptAt, now, viaList, receipt) {
  if (view.stage !== 'order' || !view.loggedIn || !matchesIntent(view.fields, intent)) return false;
  const { orderId, status, createdAt } = view.fields;
  if (!clean(orderId) || clean(status) !== intent.pendingStatus) return false;
  if (receipt) return clean(orderId) === receipt;
  if (!viaList && !createdAt) return true;
  if (!/(Z|[+-]\d{2}:\d{2})$/u.test(createdAt ?? '')) return false;
  const time = Date.parse(createdAt);
  return Number.isFinite(time) && time >= attemptAt && time <= now;
}

export async function runCheckout(adapter, intent, {
  mode = 'observe', platform, emit = () => {}, reserve,
  now = Date.now, sleep = delay, pollMs = 90, timeoutMs = 35_000, confirmMs = 15_000, signal,
} = {}) {
  const sale = Date.parse(intent.saleAt);
  const stamps = Number.isFinite(sale) ? { saleAt: new Date(sale).toISOString() } : {};
  const log = (event, data = {}) => {
    const at = new Date(now()).toISOString();
    emit({ event, at, platform, mode, ...data });
    return at;
  };
  const finish = status => {
    const result = { status, ...stamps };
    log('finished', result);
    return result;
  };
  const firstAction = () => { stamps.firstActionAt ??= log('first_action'); };
  const wait = async ms => {
    if (signal?.aborted) throw new Error('cancelled');
    await sleep(ms, undefined, { signal });
  };

  let submitted = false;
  try {
    if ((mode === 'live' && !Number.isFinite(sale)) || !['observe', 'rehearse', 'live'].includes(mode)) return finish('invalid_config');
    let view = await adapter.snapshot();
    const initial = nextStep(view, intent);
    if (initial.error) return finish(initial.error);
    log('preflight', { stage: view.stage });
    if (mode === 'observe') return finish('observed');
    if (mode === 'live' && now() < sale) {
      log('waiting', { saleAt: stamps.saleAt });
      while (now() < sale) {
        await wait(Math.min(1000, sale - now()));
        if (sale - now() > 1_500) {
          view = await adapter.snapshot();
          const issue = nextStep(view, intent).error;
          if (issue) return finish(issue);
        }
      }
    }

    const deadline = (mode === 'live' ? sale : now()) + timeoutMs;
    const actions = new Set();
    let lastChange = -Infinity;
    while (now() <= deadline) {
      if (signal?.aborted) return finish('cancelled');
      view = await adapter.snapshot();
      if (view.stage === 'unknown' && !view.blocked && actions.size) {
        await wait(pollMs);
        continue;
      }
      const step = nextStep(view, intent);
      if (step.error) {
        const loading = ['selection_unavailable', 'page_unrecognized', 'login_unverified'].includes(step.error);
        if (loading && now() - lastChange < 2000) {
          await wait(pollMs);
          continue;
        }
        return finish(step.error);
      }
      const { key } = step;
      const unique = JSON.stringify([view.stage, key, step.revision]);
      if (['enter', 'next'].includes(key) && /提交|下单|支付|付款|收银|\bpay(?:ment)?\b|place order/iu.test(view.controls[key]?.label ?? '')) {
        return finish('selection_mismatch');
      }
      if (mode === 'rehearse' && key === 'submit' && view.controls.submit?.enabled) return finish('rehearsed');
      if (!view.controls[key]?.enabled || actions.has(unique)) {
        await wait(pollMs);
        continue;
      }
      if (now() > deadline || (mode === 'live' && now() < sale)) return finish('timeout');
      if (key === 'submit') {
        if (!await reserve()) return finish('previous_submission_requires_review');
        view = await adapter.snapshot();
        const final = nextStep(view, intent);
        if (final.key !== 'submit' || !view.controls.submit?.enabled) return finish(final.error ?? 'selection_mismatch');
        if (signal?.aborted) return finish('cancelled');
        if (now() < sale || now() > deadline) return finish('timeout');
        firstAction();
        stamps.submitAttemptAt = log('submit_attempt');
        submitted = true;
        break;
      }
      firstAction();
      actions.add(unique);
      if (!await adapter.click(view, key)) return finish('adapter_error');
      lastChange = now();
      log(['enter', 'next'].includes(key) ? 'navigated' : 'selected', { stage: view.stage });
    }
    if (!submitted) return finish('timeout');

    // A transport failure can occur after the site accepted the click. Never send it twice.
    const previousReceipt = clean(view.fields.submittedOrderId);
    let uncertain = false;
    try { uncertain = !await adapter.click(view, 'submit'); } catch { uncertain = true; }
    const attempt = Date.parse(stamps.submitAttemptAt);
    const confirmStart = now();
    const readActions = new Set();
    let receipt = '';
    let viaList = uncertain;
    while (now() < confirmStart + confirmMs) {
      if (signal?.aborted) return finish('order_status_unknown');
      view = await adapter.snapshot();
      if (view.blocked) return finish('challenge');
      if (view.stage === 'orders') viaList = true;
      const candidate = clean(view.fields.submittedOrderId);
      if (view.stage === 'checkout' && candidate !== previousReceipt) receipt ||= candidate;
      if (freshOrder(view, intent, attempt, now(), viaList, receipt)) {
        stamps.confirmedAt = log('confirmed');
        stamps.saleToPendingMs = Date.parse(stamps.confirmedAt) - sale;
        return finish('pending_payment');
      }
      if (uncertain || now() - confirmStart >= 1200 || view.stage === 'orders') {
        const key = view.stage === 'orders' ? 'openOrder' : 'orders';
        if (view.loggedIn && view.controls[key]?.enabled && !readActions.has(key)) {
          if (/提交|下单|支付|付款|收银|\bpay(?:ment)?\b|place order/iu.test(view.controls[key].label)) {
            return finish('order_status_unknown');
          }
          readActions.add(key);
          viaList = true;
          log('reconciling', { stage: view.stage });
          await adapter.click(view, key);
          continue;
        }
        if (view.stage !== 'orders' && view.stage !== 'order' && adapter.openOrders && !readActions.has('lookup')) {
          readActions.add('lookup');
          if (await adapter.openOrders()) {
            viaList = true;
            log('reconciling', { stage: view.stage });
            continue;
          }
        }
      }
      await wait(pollMs);
    }
    return finish('order_status_unknown');
  } catch {
    if (submitted) return finish('order_status_unknown');
    return finish(signal?.aborted ? 'cancelled' : 'adapter_error');
  }
}
