import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const required = (condition, name) => {
  if (!condition) throw new Error('invalid_' + name);
};

function label(value, name) {
  required(typeof value === 'string' && value.trim() && value.length <= 500, name);
  return value.trim().replace(/\s+/gu, ' ');
}

function names(list, name) {
  required(Array.isArray(list), name);
  const items = list.map(item => label(item, name));
  required(new Set(items).size === items.length, name);
  return items;
}

export async function loadConfig(filename, overrides = {}) {
  const configDir = dirname(resolve(filename));
  const config = JSON.parse(await readFile(filename, 'utf8'));
  const platform = overrides.platform ?? config.platform;
  const provider = overrides.provider ?? config.provider;
  required(['web', 'android'].includes(platform), 'platform');
  required(typeof provider === 'string' && /^[a-z][a-z0-9_-]{0,63}$/u.test(provider) &&
    config.providers && Object.hasOwn(config.providers, provider), 'provider');
  const file = config.providers[provider]?.[platform];
  required(typeof file === 'string' && file.trim(), 'profile');
  const profile = JSON.parse(await readFile(resolve(configDir, file), 'utf8'));
  const input = config.intent;
  required(input && typeof input === 'object', 'intent');
  const intent = {};
  for (const key of ['event', 'session', 'tier', 'pendingStatus']) intent[key] = label(input[key], key);
  required(Number.isSafeInteger(input.quantity) && input.quantity > 0, 'quantity');
  intent.quantity = input.quantity;
  intent.attendees = names(input.attendees, 'attendees');
  intent.seats = names(input.seats, 'seats');
  required(intent.attendees.length === intent.quantity, 'attendee_count');
  required(!intent.seats.length || intent.seats.length === intent.quantity, 'seat_count');
  if (input.saleAt != null) {
    required(typeof input.saleAt === 'string' &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?\+08:00$/u.test(input.saleAt), 'sale_time');
    const sale = Date.parse(input.saleAt);
    required(Number.isFinite(sale) &&
      new Date(sale + 8 * 3600_000).toISOString().slice(0, 19) === input.saleAt.slice(0, 19), 'sale_time');
  }
  intent.saleAt = input.saleAt ?? null;
  return { configDir, platform, provider, profile, intent };
}
