import { unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { connectWeb } from '../src/web.mjs';

const checkoutRoutes = {
  desktop: { origin: 'https://buy.damai.cn', path: '/orderConfirm' },
  h5: { origin: 'https://m.damai.cn', path: '/app/dmfe/h5-ultron-buy/index.html' },
};

export function rehearsalProfile(profile, itemId, checkout) {
  if (!/^\d{6,20}$/u.test(itemId ?? '') || !Object.hasOwn(checkoutRoutes, checkout)) {
    throw new Error('invalid_rehearsal_arguments');
  }
  const baseline = profile.stages?.detail;
  if (baseline?.origin !== 'https://detail.damai.cn' || baseline.path !== '/item.htm' ||
      !profile.stages?.checkout) throw new Error('missing_web_stages');
  const detail = { ...structuredClone(baseline), query: { ...baseline.query, id: itemId } };
  const order = { ...structuredClone(profile.stages.checkout), ...checkoutRoutes[checkout] };
  delete order.query;
  return { cdp: profile.cdp, blockers: profile.blockers, soldOut: profile.soldOut,
    stages: { detail, checkout: order } };
}

export function rehearsalIntent(intent, view) {
  const { stage, fields, controls, loggedIn, blocked, soldOut } = view;
  if (stage !== 'detail' || !loggedIn || blocked || soldOut ||
      ![fields.event, fields.session, fields.tier].every(value => typeof value === 'string' && value.trim()) ||
      !controls.enter?.enabled || !intent.attendees.length) throw new Error('practice_detail_not_ready');
  return {
    ...intent, event: fields.event, session: fields.session, tier: fields.tier,
    quantity: intent.attendees.length, seats: [], saleAt: null,
  };
}

async function main() {
  const [itemId, checkout, filename = 'config.local.json', extra] = process.argv.slice(2);
  if (extra) throw new Error('invalid_rehearsal_arguments');
  const { intent, profile } = await loadConfig(filename, { platform: 'web' });
  const prepared = rehearsalProfile(profile, itemId, checkout);
  // Select the real public detail tab without looking at checkout parameters.
  const adapter = await connectWeb({ ...prepared, stages: { detail: prepared.stages.detail } });
  let trial;
  try {
    trial = rehearsalIntent(intent, await adapter.snapshot());
  } finally {
    await adapter.close();
  }
  const directory = dirname(resolve(filename));
  const profileName = 'web.rehearsal-' + itemId + '.local.json';
  const configName = 'config.rehearsal-' + itemId + '.local.json';
  const write = (name, value) => writeFile(resolve(directory, name), JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx', mode: 0o600,
  });
  await write(profileName, prepared);
  try {
    await write(configName, { provider: 'rehearsal', platform: 'web',
      providers: { rehearsal: { web: profileName } }, intent: trial });
  } catch (error) {
    await unlink(resolve(directory, profileName));
    throw error;
  }
  console.log(JSON.stringify({
    status: 'rehearsal_config_created', config: configName, profile: profileName,
    quantity: trial.quantity, event: trial.event, session: trial.session, tier: trial.tier,
  }));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await main();
  } catch (error) {
    const safe = ['invalid_rehearsal_arguments', 'practice_detail_not_ready', 'missing_web_stages',
      'web_expected_one_purchase_tab', 'web_cdp_connect_failed'].includes(error.message);
    console.error(JSON.stringify({ status: safe ? error.message : error.code === 'EEXIST'
      ? 'rehearsal_file_already_exists' : 'rehearsal_prepare_failed' }));
    process.exitCode = 1;
  }
}
