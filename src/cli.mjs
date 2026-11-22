import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createBrowser } from './browser.mjs';
import { matchesRoute, startStages, validate } from './config.mjs';
import { reserveSubmission } from './journal.mjs';
import { runCheckout } from './run.mjs';

async function main() {
  const [mode, filename, extra] = process.argv.slice(2);
  if (!['observe', 'live'].includes(mode) || !filename || extra) {
    console.error('Usage: npm start -- <observe|live> <config.local.json>');
    return 2;
  }

  let config;
  try {
    config = validate(JSON.parse(await readFile(filename, 'utf8')));
  } catch {
    console.error('Invalid or unreadable configuration. See config.example.json and README.md.');
    return 2;
  }
  let connection;
  let browser;
  try {
    connection = await chromium.connectOverCDP(config.cdp, { timeout: 5_000 });
    const candidates = connection.contexts().flatMap(context => context.pages()).filter(page =>
      startStages(config).some(name => matchesRoute(page.url(), config.origin, config[name]?.route)));
    if (candidates.length !== 1) {
      console.error('Expected one open tab matching the selected routeMode.');
      return 2;
    }
    browser = createBrowser(candidates[0], config);
    const result = await runCheckout(browser, config, {
      mode,
      reserveSubmission: () => reserveSubmission(resolve('.damai-state'), config.intentKey),
      emit: event => process.stdout.write(JSON.stringify(event) + '\n'),
    });
    return ['observed', 'pending_payment'].includes(result.status) ? 0 : 1;
  } catch {
    console.error('Browser workflow failed. Review the browser and orders manually before another attempt.');
    return 2;
  } finally {
    await browser?.closeLookups();
    await connection?.close().catch(() => {});
  }
}

process.exitCode = await main();
