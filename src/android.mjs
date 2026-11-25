import { XMLParser, XMLValidator } from 'fast-xml-parser';

const elementId = 'element-6066-11e4-a52e-4f735466cecf';
const stages = new Set(['detail', 'options', 'seats', 'checkout', 'orders', 'order']);
const groups = new Set(['event', 'session', 'tier', 'seat', 'attendee']);
const actions = new Set(['enter', 'next', 'increase', 'decrease', 'submit', 'orders', 'openOrder']);
const attributes = {
  id: 'resource-id', text: 'text', desc: 'content-desc', class: 'class',
  checked: 'checked', selected: 'selected', clickable: 'clickable', enabled: 'enabled',
};
const parser = new XMLParser({
  preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '',
  parseAttributeValue: false, ignoreDeclaration: true, processEntities: true,
});
const clean = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
const label = node => clean(node?.attrs.text) || clean(node?.attrs['content-desc']);
const single = list => list.length === 1 ? list[0] : null;

function fail(code) {
  throw new Error(code);
}

function literal(text) {
  if (!text.includes("'")) return "'" + text + "'";
  if (!text.includes('"')) return '"' + text + '"';
  return 'concat(' + text.split("'").map(part => "'" + part + "'").join(', "\'", ') + ')';
}

// Compile each configured selector once for the XML scan and for Appium's live element lookup.
function selector(spec, pkg) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec) || !Object.keys(spec).length) {
    fail('android_selector_invalid');
  }
  const tests = [];
  const terms = ['@package=' + literal(pkg), 'not(@displayed="false")'];
  for (const [key, value] of Object.entries(spec)) {
    if (key === 'within' || key === 'has') {
      const nested = selector(value, pkg);
      terms.push((key === 'within' ? 'ancestor' : 'descendant') + '::*[' + nested.xpath + ']');
      tests.push(node => {
        if (key === 'has') return descendants(node).some(nested.match);
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (nested.match(parent)) return true;
        }
        return false;
      });
      continue;
    }
    if (!Object.hasOwn(attributes, key) || !['string', 'boolean'].includes(typeof value) ||
        String(value).length === 0) fail('android_selector_invalid');
    const attr = attributes[key];
    const expected = key === 'id' && !String(value).includes(':') ? pkg + ':id/' + value : String(value);
    tests.push(node => node.attrs[attr] === expected);
    terms.push('@' + attr + '=' + literal(expected));
  }
  return {
    match: node => node.attrs.package === pkg && tests.every(test => test(node)),
    xpath: terms.join(' and '),
  };
}

function descendants(node) {
  return node.children.flatMap(child => [child, ...descendants(child)]);
}

function nodesFromSource(xml) {
  if (typeof xml !== 'string' || xml.length > 6_000_000 || /<!DOCTYPE|<!ENTITY/iu.test(xml) ||
      XMLValidator.validate(xml) !== true) fail('android_source_invalid');
  const nodes = [];
  function visit(entries, parent) {
    for (const entry of entries) {
      const tag = Object.keys(entry).find(key => ![':@', '#text'].includes(key));
      if (!tag || !Array.isArray(entry[tag])) continue;
      const attrs = entry[':@'] ?? {};
      if (attrs.displayed === 'false' || attrs['visible-to-user'] === 'false') continue;
      const node = { attrs, parent, children: [] };
      nodes.push(node);
      parent?.children.push(node);
      visit(entry[tag], node);
    }
  }
  visit(parser.parse(xml), null);
  return nodes;
}

function compileStages(profile, pkg) {
  const rule = spec => selector(spec, pkg);
  return Object.entries(profile.stages ?? {}).map(([name, stage]) => {
    if (!stages.has(name)) fail('android_unknown_stage');
    const fields = Object.entries(stage.fields ?? {}).map(([key, spec]) => [key, rule(spec)]);
    const mappedActions = Object.entries(stage.actions ?? {}).map(([key, spec]) => {
      if (!actions.has(key) || !Array.isArray(spec.labels) || !spec.labels.length ||
          !spec.labels.every(item => typeof item === 'string' && clean(item)) ||
          spec.labels.some(item => /支付|付款|收银|\bpay(?:ment)?\b/iu.test(item)) ||
          (key === 'submit' && name !== 'checkout')) fail('android_action_invalid');
      return { key, target: rule(spec.target), name: spec.name && rule(spec.name), labels: new Set(spec.labels.map(clean)) };
    });
    const choices = Object.entries(stage.choices ?? {}).map(([key, spec]) => {
      if (!groups.has(key) || !['selected', 'checked'].includes(spec.stateAttribute)) {
        fail('android_choice_invalid');
      }
      return {
        key, row: rule(spec.row), name: spec.name && rule(spec.name),
        state: spec.state && rule(spec.state), target: spec.target && rule(spec.target),
        attr: spec.stateAttribute,
      };
    });
    return { name, marker: rule(stage.marker), login: rule(stage.login), fields, mappedActions, choices };
  });
}

function inside(row, condition) {
  return condition ? single(descendants(row).filter(condition.match)) : row;
}

function labelPredicate(node) {
  const attr = clean(node.attrs.text) ? 'text' : 'content-desc';
  return '@' + attr + '=' + literal(node.attrs[attr] ?? '');
}

function childTerm(condition, predicate) {
  return condition ? 'descendant::*[' + condition.xpath + ' and ' + predicate + ']' : predicate;
}

function parseView(nodes, mappings, blockers, shortages) {
  const view = {
    stage: 'unknown', fields: {}, controls: {}, blocked: blockers.some(rule => nodes.some(rule.match)),
    soldOut: shortages.some(rule => nodes.some(rule.match)), loggedIn: false,
  };
  const paths = new Map();
  const stage = single(mappings.filter(mapping => nodes.filter(mapping.marker.match).length === 1));
  if (!stage) return { view, paths };
  view.stage = stage.name;
  view.loggedIn = nodes.filter(stage.login.match).length === 1;
  for (const [key, rule] of stage.fields) {
    const matches = nodes.filter(rule.match);
    if (key === 'seats' || key === 'attendees') view.fields[key] = matches.map(label);
    else if (single(matches)) view.fields[key] = label(matches[0]);
  }

  function put(key, target, selected, actionLabel, path) {
    if (Object.hasOwn(view.controls, key)) {
      view.controls[key] = { enabled: false, selected: null, label: actionLabel };
      paths.delete(key);
      return;
    }
    let enabled = Boolean(target && target.attrs.enabled === 'true' && target.attrs.clickable === 'true');
    for (let parent = target?.parent; parent; parent = parent.parent) {
      if (parent.attrs.enabled === 'false') enabled = false;
    }
    view.controls[key] = { enabled, selected, label: actionLabel };
    if (enabled) paths.set(key, path);
  }

  for (const action of stage.mappedActions) {
    for (const target of nodes.filter(action.target.match)) {
      const name = inside(target, action.name);
      const text = label(name);
      if (!action.labels.has(text)) continue;
      const term = childTerm(action.name, labelPredicate(name));
      put(action.key, target, null, text, '//*[' + action.target.xpath + ' and ' + term + ']');
    }
  }
  for (const choice of stage.choices) {
    for (const row of nodes.filter(choice.row.match)) {
      const nameNode = inside(row, choice.name);
      const name = label(nameNode);
      if (!name) continue;
      const state = inside(row, choice.state)?.attrs[choice.attr];
      const selected = state === 'true' ? true : state === 'false' ? false : null;
      const target = inside(row, choice.target);
      const nameTerm = childTerm(choice.name, labelPredicate(nameNode));
      const stateTerm = childTerm(choice.state, '@' + choice.attr + '=' + literal(state ?? ''));
      let path = '//*[' + choice.row.xpath + ' and ' + nameTerm + ' and ' + stateTerm + ']';
      if (choice.target) path += '/descendant::*[' + choice.target.xpath + ']';
      put(choice.key + ':' + name, selected === null ? null : target, selected, name, path);
    }
  }
  return { view, paths };
}

export async function connectAndroid(profile) {
  const endpoint = new URL(profile.endpoint ?? 'http://127.0.0.1:4723');
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(endpoint.hostname) ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !['', '/', '/wd/hub', '/wd/hub/'].includes(endpoint.pathname)) fail('android_endpoint_invalid');
  const udid = process.env.ANDROID_SERIAL || profile.udid;
  if (typeof udid !== 'string' || !udid.trim()) fail('android_device_required');
  const pkg = profile.appPackage ?? 'cn.damai';
  if (typeof pkg !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u.test(pkg)) {
    fail('android_package_invalid');
  }
  const mappings = compileStages(profile, pkg);
  if (!mappings.length || !profile.blockers?.length) fail('android_profile_incomplete');
  const blockers = profile.blockers.map(spec => selector(spec, pkg));
  const shortages = (profile.soldOut ?? []).map(spec => selector(spec, pkg));
  const base = endpoint.href.replace(/\/$/u, '');

  async function request(method, path, body, timeout = 10000) {
    let response;
    let data;
    try {
      response = await fetch(base + path, {
        method, headers: body && { 'Content-Type': 'application/json' },
        body: body && JSON.stringify(body), signal: AbortSignal.timeout(timeout), redirect: 'error',
      });
      data = await response.json();
    } catch {
      fail('android_appium_unavailable');
    }
    if (!response.ok || !Object.hasOwn(data ?? {}, 'value') || data.value?.error) fail('android_appium_error');
    return data.value;
  }
  const session = await request('POST', '/session', { capabilities: { alwaysMatch: {
    platformName: 'Android', 'appium:automationName': 'UiAutomator2', 'appium:udid': udid,
    'appium:appPackage': pkg, 'appium:autoLaunch': false, 'appium:noReset': true,
    'appium:shouldTerminateApp': false, 'appium:dontStopAppOnReset': true,
    'appium:newCommandTimeout': 300,
  }, firstMatch: [{}] } }, 90000);
  if (typeof session?.sessionId !== 'string' || !session.sessionId) fail('android_session_invalid');
  const path = '/session/' + encodeURIComponent(session.sessionId);
  let closed = false;

  async function readNodes() {
    if (closed) fail('android_session_closed');
    const [xml, currentPackage] = await Promise.all([
      request('GET', path + '/source'),
      request('POST', path + '/execute/sync', { script: 'mobile: getCurrentPackage', args: [] }),
    ]);
    if (currentPackage !== pkg) fail('android_wrong_package');
    return nodesFromSource(xml);
  }

  async function read() {
    return parseView(await readNodes(), mappings, blockers, shortages);
  }

  return {
    async inspectLocator(spec) {
      const rule = selector(spec, pkg);
      const matches = (await readNodes()).filter(rule.match);
      return {
        matches: matches.length, visible: matches.length,
        enabled: matches.filter(node => node.attrs.enabled === 'true').length,
        selected: matches.filter(node => node.attrs.checked === 'true' || node.attrs.selected === 'true').length,
      };
    },
    async snapshot() {
      return (await read()).view;
    },
    async click(previous, key) {
      const { view, paths } = await read();
      if (view.stage !== previous.stage || view.blocked || !view.loggedIn ||
          (view.soldOut && !['orders', 'openOrder'].includes(key)) ||
          JSON.stringify(view.fields) !== JSON.stringify(previous.fields) ||
          JSON.stringify(view.controls) !== JSON.stringify(previous.controls) || !paths.has(key) ||
          view.controls[key].selected === true) fail('android_page_changed');
      const elements = await request('POST', path + '/elements', { using: 'xpath', value: paths.get(key) });
      const id = Array.isArray(elements) && single(elements)?.[elementId];
      if (typeof id !== 'string' || !id) fail('android_element_changed');
      await request('POST', path + '/element/' + encodeURIComponent(id) + '/click', {});
      return true;
    },
    async close() {
      if (!closed) {
        closed = true;
        await request('DELETE', path);
      }
    },
  };
}
