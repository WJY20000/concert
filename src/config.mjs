export const requiredFields = ['event', 'session', 'ticket', 'quantity', 'attendees'];

export function normalize(value) {
  return value.replace(/\s+/gu, ' ').trim();
}

function check(condition, field) {
  if (!condition) throw new Error(`Invalid configuration: ${field}`);
}

function nonempty(value) {
  return typeof value === 'string' && normalize(value).length > 0;
}

function isDamaiOrigin(value) {
  const url = new URL(value);
  return url.origin === value && url.protocol === 'https:' && !url.port &&
    (url.hostname === 'damai.cn' || url.hostname.endsWith('.damai.cn'));
}

function checkRoute(route, name, origin) {
  check(route && typeof route.path === 'string' && route.path.startsWith('/') &&
    !route.path.startsWith('//') && !/[?#\\]/u.test(route.path), name);
  check(Object.values(route.query ?? {}).every(nonempty), `${name}.query`);
  check(!route.origin || isDamaiOrigin(route.origin), `${name}.origin`);
  check(new URL(route.path, origin).origin === origin, name);
}

export function matchesRoute(value, origin, route) {
  if (!route) return false;
  const url = new URL(value);
  const expectedParts = route.path.split('/');
  const actualParts = url.pathname.split('/');
  return url.origin === (route.origin ?? origin) && actualParts.length === expectedParts.length &&
    expectedParts.every((part, index) => part === ':id'
      ? /^[A-Za-z0-9_-]+$/u.test(actualParts[index])
      : actualParts[index] === part) &&
    Object.entries(route.query ?? {}).every(([key, expected]) =>
      url.searchParams.getAll(key).length === 1 && url.searchParams.get(key) === expected);
}

export function validate(config) {
  check(isDamaiOrigin(config.origin), 'origin');
  const cdp = new URL(config.cdp);
  check(cdp.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(cdp.hostname) &&
    cdp.port && cdp.pathname === '/' && !cdp.username && !cdp.password &&
    !cdp.search && !cdp.hash, 'cdp');
  check(/^[\w-]{1,100}$/u.test(config.intentKey ?? ''), 'intentKey');
  check(typeof config.saleAt === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?\+08:00$/u.test(config.saleAt) &&
    Number.isFinite(Date.parse(config.saleAt)), 'saleAt (+08:00 required)');
  const localDate = new Date(Date.parse(config.saleAt) + 8 * 60 * 60 * 1_000);
  check(localDate.toISOString().slice(0, 19) === config.saleAt.slice(0, 19), 'saleAt calendar date');
  check(config.blockers?.length > 0 && config.blockers.every(nonempty), 'blockers');
  for (const name of ['detail', 'checkout', 'order', 'orders']) {
    const stage = config[name];
    if (name === 'detail' && !stage) continue;
    checkRoute(stage?.route, `${name}.route`, config.origin);
    check(nonempty(stage.ready), `${name}.ready`);
    if (name === 'detail' || name === 'checkout') {
      check(nonempty(stage.login) && nonempty(stage.button) && nonempty(stage.soldOut), name);
    }
  }
  check(nonempty(config.order.id) && nonempty(config.order.pending), 'order');
  check(nonempty(config.orders.rows) && nonempty(config.orders.id) && nonempty(config.orders.empty), 'orders');
  check(config.orders.link === undefined || nonempty(config.orders.link), 'orders.link');
  check(matchesRoute(config.orders.url, config.origin, config.orders.route), 'orders.url');
  check(requiredFields.every(key => Object.hasOwn(config.fields ?? {}, key)), 'fields');
  for (const [key, field] of Object.entries(config.fields)) {
    check(/^[a-z][a-z0-9_]*$/u.test(key) && nonempty(field.expected) &&
      nonempty(field.checkout) && nonempty(field.order), `fields.${key}`);
    for (const optional of ['detail', 'detailExpected', 'orderExpected']) {
      check(field[optional] === undefined || nonempty(field[optional]), `fields.${key}.${optional}`);
    }
  }
  check(!config.detail || nonempty(config.fields.event.detail), 'fields.event.detail');
  return config;
}
