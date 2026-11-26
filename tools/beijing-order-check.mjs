import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { detailPriceCents, guardDamaiH5, timeKey } from '../src/damai-h5.mjs';
import { runCheckout } from '../src/engine.mjs';
import { makeJournal } from '../src/journal.mjs';
import { connectWeb } from '../src/web.mjs';
import { rehearsalIntent, rehearsalProfile } from './prepare-rehearsal.mjs';

export const beijingItemId = '1100435904158';
const targetAmount = 24700;
const targetSession = '2026/12/31/20:00';

export function beijingIntent(intent, view, now = Date.now()) {
  const details = rehearsalIntent(intent, view);
  if (!details.event.startsWith('【北京】') || !details.event.includes('陈鸿宇') ||
      timeKey(details.session) !== targetSession || details.quantity !== 2 ||
      detailPriceCents(details.tier) !== targetAmount ||
      view.controls['tier:' + details.tier]?.selected !== true) {
    throw new Error('beijing_target_mismatch');
  }
  return { ...details, saleAt: new Date(now).toISOString() };
}

export async function runBeijingCheck(adapter, intent, {
  reserve, emit = () => {}, signal, now = Date.now, confirmMs = 15_000,
} = {}) {
  const guarded = guardDamaiH5(adapter, intent, beijingItemId, { tier: intent.tier, amountCents: targetAmount });
  return runCheckout({
    ...guarded,
    async click(view, key) {
      const acknowledged = await guarded.click(view, key);
      if (acknowledged && key === 'submit') emit({
        event: 'submit_click_returned', mode: 'live', platform: 'web',
        at: new Date(now()).toISOString(),
      });
      return acknowledged;
    },
  }, intent, { reserve, emit, signal, now, confirmMs, mode: 'live', platform: 'web' });
}

async function main() {
  const [flag, filename = 'config.local.json', extra] = process.argv.slice(2);
  if (flag !== '--submit-once' || extra) {
    console.error('Usage: node tools/beijing-order-check.mjs --submit-once [config.local.json]');
    return 2;
  }
  const emit = event => console.log(JSON.stringify(event));
  const error = reason => {
    emit({ event: 'finished', platform: 'web', mode: 'live', status: reason, at: new Date().toISOString() });
    return 2;
  };
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let adapter;
  try {
    const { intent, profile, configDir } = await loadConfig(filename, { platform: 'web' });
    const scoped = rehearsalProfile(profile, beijingItemId, 'h5');
    const h5Checkout = JSON.parse(await readFile(new URL('../profiles/damai-h5-checkout.json', import.meta.url), 'utf8'));
    adapter = await connectWeb({ ...scoped, stages: { detail: scoped.stages.detail, h5Checkout } });
    const view = await adapter.snapshot();
    if (view.blocked) return error('challenge');
    if (view.soldOut) return error('sold_out');
    const target = beijingIntent(intent, view);
    const journal = makeJournal(configDir, target);
    if (await journal.reserved()) return error('previous_submission_requires_review');
    const result = await runBeijingCheck(adapter, target, {
      emit, reserve: journal.reserve, signal: cancellation.signal,
    });
    return result.status === 'pending_payment' ? 0 : 1;
  } catch (failure) {
    const known = ['beijing_target_mismatch', 'practice_detail_not_ready', 'web_cdp_connect_failed',
      'web_expected_one_purchase_tab', 'loopback_cdp_required'];
    return error(known.includes(failure.message) ? failure.message : 'adapter_error');
  } finally {
    await adapter?.close().catch(() => {});
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main();
}
