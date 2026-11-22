import { setTimeout as sleep } from 'node:timers/promises';
import { buttonLabels, normalize, startStages } from './config.mjs';

function shown(view, key) {
  return view.values[key]?.count === 1;
}

function text(view, key) {
  return shown(view, key) ? normalize(view.values[key].text) : '';
}

function compare(view, fields, skipAttendees = false) {
  for (const [key, field] of Object.entries(fields)) {
    if (skipAttendees && key === 'attendees') continue;
    const selector = field[view.name];
    if (!selector) continue;
    let expected = field.expected;
    if (view.name === 'detail') expected = field.detailExpected ?? expected;
    if (view.name === 'order') expected = field.orderExpected ?? expected;
    const actual = text(view, `field_${key}`);
    if (!actual) return { status: 'prefill_missing', field: key };
    if (actual !== normalize(expected)) {
      return { status: 'prefill_mismatch', field: key };
    }
  }
}

function isSoldOut(view, config) {
  return view?.values.soldOut?.count > 0 ||
    config[view?.name]?.soldOutButtonTexts?.some(label => normalize(label) === text(view, 'button'));
}

function canClick(view, config) {
  return view.values.button?.enabled &&
    buttonLabels(config, view.name).includes(text(view, 'button'));
}

function attendeePlan(view, config) {
  const selection = config.checkout.attendeeSelection;
  if (view.name !== 'checkout' || !selection) return { missing: [] };
  const names = selection.names.map(normalize);
  const required = normalize(view.attendees?.required ?? '').match(/^(?:仅需选择\s*)?(\d+)(?:\s*位)?$/u);
  const quantity = text(view, 'field_quantity').match(/^(\d+)(?:\s*张)?$/u);
  if (!required || !quantity || Number(required[1]) !== names.length || Number(quantity[1]) !== names.length) {
    return { status: 'attendee_count_mismatch' };
  }
  const rows = view.attendees.rows.map(row => ({ ...row, name: normalize(row.name) }));
  if (rows.some(row => row.checked && !names.includes(row.name))) {
    return { status: 'unexpected_attendee_selected' };
  }
  const missing = [];
  for (const name of names) {
    const matches = rows.filter(row => row.name === name);
    if (matches.length !== 1) return { status: 'attendee_unidentified' };
    if (!matches[0].checked) {
      if (!matches[0].actionable) return { status: 'attendee_control_unavailable' };
      missing.push(name);
    }
  }
  return { missing };
}

function preflight(view, config) {
  if (view?.blocked) return { status: 'challenge_or_login' };
  if (isSoldOut(view, config)) return { status: 'sold_out' };
  if (!view || !['detail', 'checkout'].includes(view.name) || !shown(view, 'ready')) {
    return { status: 'page_unrecognized' };
  }
  if (!shown(view, 'login')) return { status: 'login_unverified' };
  const autoSelect = view.name === 'checkout' && Boolean(config.checkout.attendeeSelection);
  const mismatch = compare(view, config.fields, autoSelect);
  if (mismatch || !autoSelect) return mismatch;
  const plan = attendeePlan(view, config);
  if (plan.status) return plan;
}

function verifiedOrder(view, config, baseline) {
  if (!view || view.name !== 'order' || view.blocked || !shown(view, 'ready') ||
      !shown(view, 'pending') || compare(view, config.fields)) return '';
  const id = text(view, 'id');
  return id && !baseline.has(id) ? id : '';
}

export async function runCheckout(browser, config, {
  mode = 'live',
  reserveSubmission,
  emit = () => {},
  now = Date.now,
  entryWindow = 30_000,
  transitionTimeout = 8_000,
  clickTimeout = 1_500,
  lookupTimeout = 3_000,
  reconcileWindow = 12_000,
  pollMs = 150,
} = {}) {
  const sale = Date.parse(config.saleAt);
  const fastPollMs = Math.min(pollMs, 50);
  const timestamps = { saleAt: new Date(sale).toISOString() };
  function record(event, data = {}) {
    const at = new Date(now()).toISOString();
    emit({ event, at, ...data });
    return at;
  }
  function finish(status, field) {
    const result = { status, ...timestamps };
    if (field) result.field = field;
    if (timestamps.confirmedAt) {
      result.saleToPendingMs = Date.parse(timestamps.confirmedAt) - sale;
    }
    record('finished', result);
    return result;
  }
  function confirmed(source) {
    timestamps.confirmedAt = record('order_confirmed', { source });
    return finish('pending_payment');
  }
  function firstAction() {
    timestamps.firstActionAt ??= record('first_action');
  }
  async function readCurrent() {
    // Navigation can invalidate an in-flight DOM read. A missing view cannot authorize a click.
    try {
      return await browser.current();
    } catch {
      return null;
    }
  }

  const startingStages = startStages(config);
  record('scheduled', { saleAt: timestamps.saleAt, mode, routeMode: config.routeMode ?? 0 });
  const initial = await readCurrent();
  const problem = preflight(initial, config);
  if (problem) return finish(problem.status, problem.field);
  if (!startingStages.includes(initial.name)) return finish('wrong_start_stage');
  const verifiedFields = Object.entries(config.fields).filter(([key, field]) =>
    field[initial.name] && !(key === 'attendees' && initial.name === 'checkout' && config.checkout.attendeeSelection)).length;
  const buttonCount = initial.values.button?.count ?? 0;
  let actionState = 'waiting';
  if (buttonCount === 0) actionState = 'missing';
  if (buttonCount > 1) actionState = 'ambiguous';
  if (canClick(initial, config)) actionState = 'ready';
  record('preflight_checked', {
    page: initial.name, verifiedFields, actionState,
    ...(initial.name === 'checkout' && config.checkout.attendeeSelection
      ? { attendeesToSelect: attendeePlan(initial, config).missing.length } : {}),
  });
  if (mode === 'observe') return finish('observed');
  if (now() >= sale + entryWindow) return finish('sale_window_elapsed');

  const existing = await browser.listOrders(lookupTimeout).catch(() => null);
  if (!existing) return finish('orders_baseline_unavailable');
  if (existing.blocked) return finish('challenge_or_login');
  const baseline = new Set(existing.orders.map(order => order.id));
  record('orders_baseline_loaded');

  const attemptedAttendees = new Set();
  let entered = false;
  let entryDeadline = sale + entryWindow;
  while (now() < entryDeadline) {
    const readStartedAt = now();
    const view = await readCurrent();
    if (view?.blocked) return finish('challenge_or_login');
    if (entered && view?.name !== 'checkout') {
      await sleep(fastPollMs);
      continue;
    }

    const currentProblem = preflight(view, config);
    if (currentProblem) {
      if (entered && currentProblem.status === 'page_unrecognized') {
        await sleep(pollMs);
        continue;
      }
      return finish(currentProblem.status, currentProblem.field);
    }

    if (!entered && !startingStages.includes(view.name)) return finish('wrong_start_stage');

    const untilSale = sale - now();
    if (untilSale > 0) {
      const interval = untilSale > 5_000 ? 1_000 : untilSale > 500 ? pollMs : fastPollMs;
      await sleep(Math.min(untilSale, interval));
      continue;
    }
    if (readStartedAt < sale) continue;
    if (now() >= entryDeadline) break;
    const [nextAttendee] = attendeePlan(view, config).missing;
    if (nextAttendee) {
      if (attemptedAttendees.has(nextAttendee)) {
        await sleep(fastPollMs);
        continue;
      }
      firstAction();
      attemptedAttendees.add(nextAttendee);
      try {
        if (!await browser.selectAttendee(view, nextAttendee, clickTimeout)) {
          return finish('attendee_selection_unconfirmed');
        }
      } catch {
        return finish('attendee_selection_unconfirmed');
      }
      record('attendee_selection_attempted');
      continue;
    }
    if (!canClick(view, config)) {
      await sleep(entered || untilSale > -1_000 ? fastPollMs : pollMs);
      continue;
    }

    if (view.name === 'detail') {
      firstAction();
      try {
        if (!await browser.click(view, clickTimeout)) return finish('page_changed_before_entry');
      } catch {
        // An entry click can have navigated even if Playwright timed out.
        record('entry_click_uncertain');
      }
      entered = true;
      entryDeadline = now() + transitionTimeout;
      record('checkout_entry_attempted');
      continue;
    }

    let reserved;
    try {
      reserved = await reserveSubmission();
    } catch {
      return finish('submission_guard_unavailable');
    }
    if (!reserved) return finish('previous_submission_requires_review');

    const latest = await readCurrent();
    const latestProblem = preflight(latest, config);
    if (latestProblem) return finish(latestProblem.status, latestProblem.field);
    if (latest.name !== 'checkout' || attendeePlan(latest, config).missing.length || !canClick(latest, config) ||
        now() < sale || now() >= entryDeadline) return finish('page_changed_before_submit');

    firstAction();
    timestamps.submitAttemptAt = record('submit_attempt');
    try {
      if (!await browser.click(latest, clickTimeout)) return finish('page_changed_before_submit');
      record('submit_click_returned');
    } catch {
      record('submit_click_uncertain');
    }

    // From this point forward every action is read-only, including after a timeout.
    const directStartedAt = now();
    const directDeadline = directStartedAt + transitionTimeout;
    let reconcileReason = 'confirmation_timeout';
    while (now() < directDeadline) {
      const current = await readCurrent();
      if (current?.blocked) return finish('challenge_or_login');
      if (verifiedOrder(current, config, baseline)) return confirmed('checkout');
      if (current?.name === 'external') {
        reconcileReason = 'left_checkout_origin';
        break;
      }
      if (current?.name === 'checkout' && isSoldOut(current, config)) {
        reconcileReason = 'sold_out_after_submit';
        record('sold_out_after_submit');
        break;
      }
      await sleep(now() - directStartedAt < 1_000 ? fastPollMs : pollMs);
    }

    record('reconciliation_started', { reason: reconcileReason });
    const deadline = now() + reconcileWindow;
    while (now() < deadline) {
      const current = await readCurrent();
      if (current?.blocked) return finish('challenge_or_login');
      if (verifiedOrder(current, config, baseline)) return confirmed('checkout');
      const listed = await browser.listOrders(lookupTimeout).catch(() => null);
      if (listed?.blocked) return finish('challenge_or_login');
      const recent = listed?.orders.filter(order => !baseline.has(order.id)) ?? [];
      // Multiple new IDs cannot unambiguously establish which order came from this attempt.
      if (recent.length > 1) return finish('order_status_unknown');
      if (recent.length === 1) {
        const [order] = recent;
        const readback = await browser.readOrder(order.link, lookupTimeout).catch(() => null);
        if (readback?.blocked) return finish('challenge_or_login');
        if (verifiedOrder(readback, config, baseline) === order.id) {
          browser.keepVerifiedOrder(readback);
          return confirmed('order_list');
        }
      }
      await sleep(Math.max(pollMs, 500));
    }
    return finish('order_status_unknown');
  }
  if (attemptedAttendees.size) return finish('attendee_selection_or_submit_not_ready');
  return finish(entered ? 'checkout_transition_timeout' : 'sale_window_elapsed');
}
