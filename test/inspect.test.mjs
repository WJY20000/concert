import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectLines } from '../src/inspect.mjs';

test('inspector reports only counts and configured field presence', async () => {
  const output = [];
  let inspected;
  const adapter = {
    async inspectLocator(selector) {
      inspected = selector;
      return { matches: 1, visible: 1, enabled: 0, selected: 1, text: 'private-rendered-text' };
    },
    async snapshot() {
      return { stage: 'checkout', loggedIn: true, fields: { attendees: ['private-name'], session: '' },
        controls: { 'attendee:private-name': { selected: true } } };
    },
    async click() { assert.fail('inspection must be read-only'); },
  };
  assert.equal(await inspectLines(adapter, 'android',
    [':status', '{"id":"target"}', ':quit', '{"id":"unexpected"}'], row => output.push(row)), true);
  assert.deepEqual(inspected, { id: 'target' });
  assert.deepEqual(output, [
    { stage: 'checkout', loggedIn: true, blocked: false, soldOut: false, fieldsPresent: ['attendees'],
      mappedControls: 1, selectedControls: 1 },
    { matches: 1, visible: 1, enabled: 0, selected: 1 },
  ]);
});

test('inspector does not echo raw queries, view text or adapter errors', async () => {
  const output = [];
  const adapter = { inspectLocator: async () => { throw Error('private query from Appium'); } };
  assert.equal(await inspectLines(adapter, 'android', ['private-name', '"private"', '{"text":"private-name"}'],
    row => output.push(row)), false);
  assert.deepEqual(output, Array(3).fill({ error: 'check_locator_and_active_page' }));
});

test('web inspector passes CSS to the adapter and preserves zero or multiple matches', async () => {
  const output = [];
  const adapter = { inspectLocator: async css => {
    assert.equal(css, 'input:checked');
    return { matches: 2, visible: 1, enabled: 1, selected: 0 };
  } };
  assert.equal(await inspectLines(adapter, 'web', ['input:checked'], row => output.push(row)), true);
  assert.deepEqual(output, [{ matches: 2, visible: 1, enabled: 1, selected: 0 }]);
});
