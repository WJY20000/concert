import { readFile } from 'node:fs/promises';
import { connectWeb } from './web.mjs';
import { eventKey, ticketQuantity } from './engine.mjs';

const cents = value => {
  if (!value) return NaN;
  const [whole, rest = ''] = value.split('.');
  return Number(whole) * 100 + Number(rest.padEnd(2, '0'));
};

export function detailPriceCents(label) {
  const matches = [...label.matchAll(/(?:[¥￥]\s*(\d+(?:\.\d{1,2})?))|(?<![.\d])(\d+(?:\.\d{1,2})?)\s*元/gu)];
  const prices = new Set(matches.map(match => cents(match[1] ?? match[2])));
  return prices.size === 1 ? [...prices][0] : NaN;
}

export function timeKey(value) {
  const match = value?.match(/^(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})\s*(?:(?:周|星期)[一二三四五六日天]\s*)?(\d{2}:\d{2})$/u);
  if (!match) return null;
  return [match[1], match[2].padStart(2, '0'), match[3].padStart(2, '0'), match[4]].join('/');
}

export function guardDamaiH5(adapter, intent, itemId, rule) {
  const rawViews = new WeakMap();
  const expectedTime = timeKey(intent.session);
  let detailVerified = false;
  let checkoutRef;
  const tierControl = 'tier:' + intent.tier;

  function verifiesDetail(view) {
    const { fields, controls } = view;
    const samePrice = Object.entries(controls).filter(([key, control]) => key.startsWith('tier:') &&
      detailPriceCents(control.label) === rule.amountCents);
    return view.stage === 'detail' && fields.session === intent.session && fields.tier === rule.tier &&
      eventKey(fields.event) === eventKey(intent.event) && ticketQuantity(fields.quantity) === intent.quantity &&
      controls[tierControl]?.selected === true && samePrice.length === 1 && samePrice[0][0] === tierControl;
  }

  function verifiesCheckout(view) {
    const ref = view.checkoutRef?.match(/^(\d+)_(\d+)_(\d+)$/u);
    const { fields } = view;
    const summary = fields.tier?.match(/^[¥￥]\s*(\d+(?:\.\d{1,2})?)\s*票档\s*[×xX]\s*(\d+)\s*张$/u);
    return detailVerified && ref && ref[1] === itemId && Number(ref[2]) === intent.quantity &&
      (!checkoutRef || checkoutRef === view.checkoutRef) &&
      eventKey(fields.event) === eventKey(intent.event) &&
      expectedTime && timeKey(fields.session) === expectedTime &&
      ticketQuantity(fields.quantity) === intent.quantity && summary &&
      cents(summary[1]) === rule.amountCents && Number(summary[2]) === intent.quantity;
  }

  return {
    ...adapter,
    async snapshot() {
      const raw = await adapter.snapshot();
      if (raw.blocked || raw.soldOut) return raw;
      // The sale button and the quantity controls can render at different times.
      if (raw.stage === 'detail' && raw.fields.quantity === undefined && raw.controls.enter?.enabled) {
        const waiting = { ...raw, controls: { ...raw.controls, enter: { ...raw.controls.enter, enabled: false } } };
        rawViews.set(waiting, raw);
        return waiting;
      }
      if (raw.layout !== 'damai_h5') return raw;
      // An incomplete checkout can still be rendering. Let the runner wait for the required fields.
      if (!['event', 'session', 'tier', 'quantity'].every(key => raw.fields[key])) return raw;
      if (!verifiesCheckout(raw)) return { ...raw, controls: {}, checkoutMismatch: true };
      checkoutRef ??= raw.checkoutRef;
      const normalized = { ...raw, fields: { ...raw.fields, session: intent.session, tier: intent.tier } };
      rawViews.set(normalized, raw);
      return normalized;
    },
    async click(view, key) {
      const raw = rawViews.get(view) ?? view;
      if (raw.layout === 'damai_h5' && (!rawViews.has(view) || !verifiesCheckout(raw))) return false;
      if (key === 'enter' || key === 'next') {
        detailVerified = false;
        checkoutRef = undefined;
      }
      const eligible = key === 'enter' && verifiesDetail(raw);
      const clicked = await adapter.click(raw, key);
      if (eligible && clicked) detailVerified = true;
      return clicked;
    },
  };
}

export async function connectTicketWeb(profile, intent) {
  const rule = profile.damaiH5;
  if (!rule || rule.tier !== intent.tier || intent.seats.length) return connectWeb(profile);
  const itemId = profile.stages?.detail?.query?.id;
  if (!/^\d{6,20}$/u.test(itemId ?? '') ||
      profile.stages.detail.origin !== 'https://detail.damai.cn' || profile.stages.detail.path !== '/item.htm' ||
      !Number.isSafeInteger(rule.amountCents) || rule.amountCents <= 0) throw new Error('invalid_web_h5_profile');
  const file = new URL('../profiles/damai-h5-checkout.json', import.meta.url);
  const h5Checkout = JSON.parse(await readFile(file, 'utf8'));
  const adapter = await connectWeb({ ...profile, stages: { ...profile.stages, h5Checkout } });
  return guardDamaiH5(adapter, intent, itemId, rule);
}
