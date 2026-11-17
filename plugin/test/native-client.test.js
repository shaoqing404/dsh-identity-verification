import test from 'node:test';
import assert from 'node:assert/strict';

async function pageFixture(bridge, suffix) {
  const statuses = [];
  let cleanup;
  let registration;
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: value => [value, update => { statuses.push(update); }],
    useRef: value => ({ current: value }),
    useEffect: effect => { cleanup = effect(); },
  };
  globalThis.window = { __ModuleLoader__: { load: value => { registration = value; } } };
  globalThis.dshTouchId = bridge;
  let page;
  try {
    await import('../lib/client.js?' + suffix);
    registration.factory(() => React).apply({ slots: {
      inject: (_name, apply) => apply(),
      register: (_options, component) => { page = component; },
    } });
  } finally {
    delete globalThis.window;
    delete globalThis.dshTouchId;
  }
  const view = page({ bridge });
  return { statuses, cleanup, button: view.children.find(value => value?.type === 'button' && value.children[0] === '验证身份') };
}

test('native verification coalesces repeated clicks and preserves an unconfirmed receipt', async () => {
  let finish;
  let calls = 0;
  const response = new Promise(resolve => { finish = resolve; });
  const fixture = await pageFixture({
    capabilities: async () => ({ ok: true, systemOwner: { available: true } }),
    verify: () => { calls++; return response; },
    cancel: async () => ({ ok: true }),
  }, 'native-unconfirmed');
  const first = fixture.button.props.onClick();
  await fixture.button.props.onClick();
  assert.equal(calls, 1);
  finish({ ok: false, code: 'result-unconfirmed' });
  await first;
  assert.ok(fixture.statuses.some(value => String(value).includes('结果未确认')));
  assert.ok(!fixture.statuses.some(value => String(value).includes('系统验证通过')));
  fixture.cleanup();
});

test('unmounted native page cancels and ignores a late success receipt', async () => {
  let finish;
  let cancelled = 0;
  const response = new Promise(resolve => { finish = resolve; });
  const fixture = await pageFixture({
    capabilities: async () => ({ ok: true, systemOwner: { available: true } }),
    verify: () => response,
    cancel: async () => { cancelled++; return { ok: true }; },
  }, 'native-unmounted');
  const first = fixture.button.props.onClick();
  fixture.cleanup();
  finish({ ok: true, outcome: 'granted' });
  await first;
  assert.equal(cancelled, 1);
  assert.ok(!fixture.statuses.some(value => String(value).includes('系统验证通过')));
});
