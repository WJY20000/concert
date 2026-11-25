import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const stages = ['detail', 'options', 'seats', 'checkout', 'orders', 'order'];
const fieldNames = ['event', 'session', 'tier', 'quantity', 'seats', 'attendees', 'orderId', 'status', 'createdAt', 'submittedOrderId'];
const countNames = ['matches', 'visible', 'enabled', 'selected'];

function summary(view) {
  // Choice keys can embed attendee names or seat labels. Never print keys or values from the adapter.
  const checked = Object.values(view.controls).filter(control => control.selected === true).length;
  const fields = fieldNames.filter(key => {
    const value = view.fields[key];
    return Array.isArray(value) ? value.length > 0 : typeof value === 'string' && value.trim() !== '';
  });
  return {
    stage: stages.includes(view.stage) ? view.stage : 'unknown',
    blocked: view.blocked === true, soldOut: view.soldOut === true, loggedIn: view.loggedIn === true,
    fieldsPresent: fields, mappedControls: Object.keys(view.controls).length, selectedControls: checked,
  };
}

// Accept CSS or JSON constraints through stdin, independently of shell escaping on the host OS.
export async function inspectLines(adapter, platform, lines, write) {
  let success = true;
  for await (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === ':quit') break;
    if (line === ':status') {
      try {
        write(summary(await adapter.snapshot()));
      } catch {
        write({ error: 'snapshot_unavailable' });
        success = false;
      }
      continue;
    }
    try {
      if (line.length > 4096) throw new Error('invalid_query');
      const query = platform === 'android' ? JSON.parse(line) : line;
      if (platform === 'android' && (!query || typeof query !== 'object' || Array.isArray(query))) {
        throw new Error('invalid_query');
      }
      const result = await adapter.inspectLocator(query);
      const counts = {};
      for (const name of countNames) {
        if (!Number.isSafeInteger(result[name]) || result[name] < 0) throw new Error('invalid_count');
        counts[name] = result[name];
      }
      write(counts);
    } catch {
      // Browser and Appium errors may include the locator, current URL and rendered text.
      write({ error: 'check_locator_and_active_page' });
      success = false;
    }
  }
  return success;
}

const usage = 'node src/inspect.mjs [config.local.json] [--platform web|android] [--provider damai]';

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: { platform: { type: 'string' }, provider: { type: 'string' }, help: { type: 'boolean' } },
    });
    if (parsed.positionals.length > 1) throw new Error();
    if (parsed.values.help) {
      console.log(usage);
      return 0;
    }
  } catch {
    console.error(usage);
    return 2;
  }
  const filename = parsed.positionals[0] ?? 'config.local.json';
  const { provider, platform } = parsed.values;
  let adapter;
  let reader;
  try {
    const { loadConfig } = await import('./config.mjs');
    const config = await loadConfig(filename, { provider, platform });
    if (config.platform === 'web') {
      const { connectWeb } = await import('./web.mjs');
      adapter = await connectWeb(config.profile, { inspection: true });
    } else if (config.platform === 'android') {
      const { connectAndroid } = await import('./android.mjs');
      adapter = await connectAndroid(config.profile);
    } else {
      throw new Error('unsupported_platform');
    }
    if (process.stdin.isTTY) {
      const syntax = config.platform === 'web' ? 'CSS 选择器' : '单行 JSON 控件选择条件';
      console.error('输入' + syntax + '并按回车。:status 查看当前配置的识别结果，:quit 结束。');
    }
    // Disable readline history so a name or subtree selector isn't retained as an input history entry.
    reader = createInterface({ input: process.stdin, terminal: false, crlfDelay: Infinity, historySize: 0 });
    const ok = await inspectLines(adapter, config.platform, reader, result => console.log(JSON.stringify(result)));
    return ok ? 0 : 1;
  } catch {
    console.error('无法连接所选平台。请检查本机配置、连接地址、目标页面或设备包名。');
    return 2;
  } finally {
    reader?.close();
    await adapter?.close().catch(() => {});
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main();
}
