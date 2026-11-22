import { matchesRoute, normalize } from './config.mjs';

// A single DOM read captures the button state and all visible evidence together.
async function inspect(page, { selectors = {}, blockers, rows, selection, buttonLabels }) {
  return page.evaluate(({ selectors, blockers, rows, selection, buttonLabels }) => {
    function visible(element) {
      if (!element.getClientRects().length) return false;
      if (element.checkVisibility) return element.checkVisibility({ visibilityProperty: true, opacityProperty: true });
      const style = getComputedStyle(element);
      return style.visibility === 'visible' && style.opacity !== '0';
    }

    function find(root, selector) {
      return [...root.querySelectorAll(selector)].filter(visible);
    }

    function read(element) {
      return /^(INPUT|SELECT|TEXTAREA)$/u.test(element.tagName) ? element.value : element.innerText;
    }

    function snapshot(root, entries) {
      return Object.fromEntries(Object.entries(entries).map(([key, selector]) => {
        let elements = find(root, selector);
        if (key === 'button' && elements.length > 1 && buttonLabels) {
          elements = elements.filter(element => buttonLabels.includes((read(element) ?? '').replace(/\s+/gu, ' ').trim()));
        }
        const element = elements.length === 1 ? elements[0] : null;
        return [key, {
          count: elements.length,
          text: element ? read(element) ?? '' : '',
          enabled: Boolean(element && !element.closest(':disabled,[aria-disabled="true"],[inert]')),
          href: element?.tagName === 'A' ? element.href : null,
        }];
      }));
    }

    const sections = selection ? find(document, selection.section) : [];
    const attendees = sections.length === 1 ? {
      required: snapshot(sections[0], { count: selection.requiredCount }).count.text,
      rows: find(sections[0], selection.rows).map(row => {
        const values = snapshot(row, { name: selection.name, control: selection.control });
        return {
          name: values.name.text,
          actionable: values.control.count === 1 && values.control.enabled,
          checked: row.matches(selection.checked) || row.querySelector(selection.checked) !== null,
        };
      }),
    } : null;
    return {
      attendees,
      url: location.href,
      blocked: blockers.some(selector => find(document, selector).length > 0),
      values: snapshot(document, selectors),
      rows: rows ? find(document, rows.root).map(row => snapshot(row, rows.selectors)) : [],
    };
  }, { selectors, blockers, rows, selection, buttonLabels });
}

function exactText(label) {
  const escaped = label.split(' ')
    .map(token => token.replace(/[-[\]/{}()*+?.\\^$|]/gu, '\\$&'))
    .join('\\s+');
  return new RegExp(`^\\s*${escaped}\\s*$`, 'u');
}

export function createBrowser(page, config) {
  const context = page.context();
  const trustedOrigins = new Set(['order', 'checkout', 'detail', 'orders'].map(name =>
    config[name]?.route.origin ?? config.origin));
  let active = page;
  let lookup;
  let detailLookup;
  let verifiedOrderTab;
  const watched = [page];
  function usePopup(popup) {
    active = popup;
    watched.push(popup);
    popup.on('popup', usePopup);
  }
  // Only follow descendants of the selected checkout tab.
  page.on('popup', usePopup);

  async function waitForPage(target, ready, timeout) {
    const signals = [ready, ...config.blockers].map(selector =>
      target.locator(`css=${selector}`).filter({ visible: true }));
    await signals.reduce((combined, locator) => combined.or(locator)).first()
      .waitFor({ state: 'visible', timeout });
  }

  async function snapshot(name, target = active) {
    const stage = config[name];
    if (!matchesRoute(target.url(), config.origin, stage?.route)) return null;
    const selectors = { ready: stage.ready };
    for (const key of ['button', 'login', 'soldOut', 'pending', 'id', 'empty']) {
      if (stage[key] && !(name === 'orders' && key === 'id')) selectors[key] = stage[key];
    }
    for (const [key, field] of Object.entries(config.fields)) {
      if (field[name]) selectors[`field_${key}`] = field[name];
    }
    const result = await inspect(target, {
      selectors,
      blockers: config.blockers,
      selection: name === 'checkout' ? stage.attendeeSelection : undefined,
      buttonLabels: stage.buttonTexts && [...stage.buttonTexts, ...(stage.soldOutButtonTexts ?? [])].map(normalize),
      rows: name === 'orders' ? {
        root: stage.rows,
        selectors: { id: stage.id, ...(stage.link ? { link: stage.link } : {}) },
      } : undefined,
    });
    if (!matchesRoute(result.url, config.origin, stage.route)) return null;
    return { ...result, target };
  }

  return {
    async current() {
      for (const name of ['order', 'checkout', 'detail']) {
        if (matchesRoute(active.url(), config.origin, config[name]?.route)) {
          const view = await snapshot(name);
          if (view && (view.blocked || view.values.ready.count > 0 || view.values.soldOut?.count > 0)) {
            return { ...view, name };
          }
        }
      }
      const url = new URL(active.url());
      if (trustedOrigins.has(url.origin)) {
        return { ...(await inspect(active, { blockers: config.blockers })), name: null };
      }
      return url.protocol === 'https:' ? { name: 'external', values: {} } : null;
    },

    async click(view, timeout) {
      if (view.target !== active || active.url() !== view.url) return false;
      // Retain the observed label in the locator while Playwright waits for actionability.
      await view.target.locator(`css=${config[view.name].button}`)
        .filter({ visible: true, hasText: exactText(normalize(view.values.button.text)) })
        .click({ timeout, noWaitAfter: true });
      return true;
    },

    async selectAttendee(view, name, timeout) {
      if (view.target !== active || active.url() !== view.url) return false;
      const selection = config.checkout.attendeeSelection;
      const named = active.locator(`css=${selection.name}`).filter({ visible: true, hasText: exactText(name) });
      const row = active.locator(`css=${selection.section}`).filter({ visible: true })
        .locator(`css=${selection.rows}`).filter({ visible: true, has: named });
      const checked = active.locator(`css=${selection.checked}`);
      const uncheckedRow = row.and(active.locator(`css=:not(:is(${selection.checked}))`))
        .filter({ hasNot: checked });
      await uncheckedRow.locator(`css=${selection.control}`).filter({ visible: true })
        .click({ timeout, noWaitAfter: true });
      return true;
    },

    async listOrders(timeout) {
      if (!lookup) {
        lookup = await context.newPage();
        // Keep the waiting tab foreground so Chromium doesn't throttle its countdown timers.
        await active.bringToFront();
      }
      await lookup.goto(config.orders.url, { waitUntil: 'domcontentloaded', timeout });
      await waitForPage(lookup, config.orders.ready, timeout);
      const view = await snapshot('orders', lookup);
      if (view?.blocked) return { blocked: true };
      if (!view || view.values.ready.count !== 1) return null;
      if (view.rows.length === 0 && view.values.empty.count !== 1) return null;
      const orders = view.rows.map(row => ({
        id: row.id.count === 1 ? normalize(row.id.text) : '',
        link: row.link?.count === 1 ? row.link.href : null,
      }));
      if (orders.some(order => !order.id) || new Set(orders.map(order => order.id)).size !== orders.length) return null;
      return { orders };
    },

    async readOrder(link, timeout) {
      if (!link || !matchesRoute(link, config.origin, config.order.route)) return null;
      detailLookup ??= await context.newPage();
      await detailLookup.goto(link, { waitUntil: 'domcontentloaded', timeout });
      await waitForPage(detailLookup, config.order.ready, timeout);
      const view = await snapshot('order', detailLookup);
      return view ? { ...view, name: 'order' } : null;
    },

    keepVerifiedOrder(view) {
      verifiedOrderTab = view.target;
    },

    async closeLookups() {
      for (const target of watched) target.off('popup', usePopup);
      await Promise.allSettled([
        lookup?.close(),
        verifiedOrderTab ? verifiedOrderTab.bringToFront() : detailLookup?.close(),
      ]);
    },
  };
}
