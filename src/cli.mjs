import { loadConfig } from './config.mjs';
import { runCheckout } from './engine.mjs';
import { makeJournal } from './journal.mjs';

async function main() {
  const [mode, filename, ...flags] = process.argv.slice(2);
  const emit = record => process.stdout.write(JSON.stringify(record) + '\n');
  const fail = (status, reason) => {
    emit({ event: 'finished', at: new Date().toISOString(), status, reason });
    return 2;
  };
  if (!['observe', 'rehearse', 'live'].includes(mode) || !filename || flags.length % 2) {
    console.error('Usage: npm start -- <observe|rehearse|live> <config.json> [--platform web|android] [--provider name]');
    return 2;
  }
  const overrides = {};
  for (let i = 0; i < flags.length; i += 2) {
    if (!['--platform', '--provider'].includes(flags[i])) return fail('invalid_config', 'unknown_flag');
    overrides[flags[i].slice(2)] = flags[i + 1];
  }
  let config;
  try { config = await loadConfig(filename, overrides); } catch (error) {
    return fail('invalid_config', /^invalid_[a-z_]+$/u.test(error.message) ? error.message : 'check_json_files');
  }
  const stop = new AbortController();
  const cancel = () => stop.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  let adapter;
  try {
    const { platform, provider, profile, intent, configDir } = config;
    if (mode === 'live' && !intent.saleAt) return fail('invalid_config', 'invalid_sale_time');
    const journal = makeJournal(configDir, intent);
    if (mode === 'live' && await journal.reserved()) return fail('previous_submission_requires_review', 'local_marker');
    adapter = platform === 'web'
      ? await (await import('./damai-h5.mjs')).connectTicketWeb(profile, intent)
      : await (await import('./android.mjs')).connectAndroid(profile);
    emit({ event: 'connected', at: new Date().toISOString(), platform, provider, mode });
    const result = await runCheckout(adapter, intent, { platform, mode, emit, reserve: journal.reserve, signal: stop.signal });
    return ['observed', 'rehearsed', 'pending_payment'].includes(result.status) ? 0 : 1;
  } catch (error) {
    const safe = /^(?:web_|android_|invalid_web_|loopback_cdp_required)[a-z_]*$/u.test(error.message);
    return fail('adapter_error', safe ? error.message : 'connection_or_profile_error');
  } finally {
    await adapter?.close().catch(() => {});
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

process.exitCode = await main();
