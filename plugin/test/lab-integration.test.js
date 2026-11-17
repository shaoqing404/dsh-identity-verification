import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as plugin from '../lib/index.js';

// Optional, in-process checks of already prepared isolated runtime files.
// No listener, profile, credentials, or DSH process is opened by this test.
for (const [version, base] of [
  ['0.2.2-rc.1', '../../.lab/runtime/node_modules/@deepseek-ai/'],
  ['0.2.2-rc.3', '../../.lab/native-rc3/shell/dsh/node_modules/@deepseek-ai/']
]) {
  const cordisUrl = new URL(base + 'cordis/lib/index.js', import.meta.url);
  const connectionUrl = new URL(base + 'dsh-client-connection/lib/index.js', import.meta.url);
  const manifestUrl = new URL(base + 'dsh-client-connection/package.json', import.meta.url);
  test(`isolated ${version} Connection composes the owner routes alongside its existing interceptor`,
  { skip: !existsSync(cordisUrl) || !existsSync(connectionUrl) }, async () => {
    assert.equal(JSON.parse(readFileSync(manifestUrl, 'utf8')).version, version);
    const { Context } = await import(cordisUrl);
    const { HostConnectionService } = await import(connectionUrl);
    const root = new Context();
    let connection;
    const connectionFiber = await root.plugin((ctx) => { connection = new HostConnectionService(ctx, [], {}); });
    const gatewayFiber = await root.plugin({ inject: ['connection'], apply(ctx) {
      ctx.connection.rpc.intercept('/api', (endpoint) => endpoint === 'ordinary/list',
        async () => ({ ok: true, value: 'existing interceptor' }));
    } });
    const pluginFiber = await root.plugin(plugin);
    const shared = connection.createSharedFetchHandler('/api');
    assert.equal(shared.requestBodyMode({ method: 'POST', url: new URL('http://localhost/api/touch-id-simulation/begin') }), 'streaming');
    const request = (method, payload) => new Request('http://localhost/api/touch-id-simulation/' + method, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
    });
    const call = async (method, payload, peer = connection.browserPeer) => {
      const response = await shared.fetch(request(method, payload), peer);
      return { status: response.status, value: response.ok ? await response.json() : null };
    };
    try {
      assert.equal((await call('begin', { operation: 'demo.consume' }, { principal: { kind: 'guest' } })).status, 403);
      const started = await call('begin', { operation: 'demo.consume' });
      assert.equal(started.status, 200);
      const payload = { id: started.value.id, operation: 'demo.consume' };
      assert.equal((await call('wait', payload)).value.state, 'ready');
      assert.equal((await call('consume', payload)).value.state, 'consumed');
      assert.equal((await call('consume', payload)).value.code, 'unknown-request');
      const ordinary = await shared.fetch(new Request('http://localhost/api/ordinary/list', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'fixture', method: 'ordinary/list', payload: {} })
      }), connection.browserPeer);
      assert.equal((await ordinary.json()).result.value, 'existing interceptor');
    } finally {
      await pluginFiber.dispose();
    }
    assert.equal((await call('begin', { operation: 'demo.consume' })).status, 404);
    await gatewayFiber.dispose();
    await connectionFiber.dispose();
  });
}

const rc3Base = '../../.lab/native-rc3/shell/dsh/node_modules/@deepseek-ai/';
const rc3Cordis = new URL(rc3Base + 'cordis/lib/index.js', import.meta.url);
const rc3Connection = new URL(rc3Base + 'dsh-client-connection/lib/index.js', import.meta.url);
test('rc.3 owner without interactions can start; caller disposal does not revoke the simulation',
  { skip: !existsSync(rc3Cordis) || !existsSync(rc3Connection) }, async () => {
    const { Context } = await import(rc3Cordis);
    const { HostConnectionService } = await import(rc3Connection);
    const root = new Context();
    let connection;
    const connectionFiber = await root.plugin((ctx) => { connection = new HostConnectionService(ctx, [], {}); });
    const pluginFiber = await root.plugin(plugin);
    const caller = connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' });
    const shared = connection.createSharedFetchHandler('/api');
    const call = async (method, payload, peer) => {
      const request = new Request('http://localhost/api/touch-id-simulation/' + method, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
      });
      const response = await shared.fetch(request, peer);
      return { status: response.status, value: response.ok ? await response.json() : null };
    };
    try {
      assert.equal(caller.interactions, 'none');
      const started = await call('begin', { operation: 'demo.consume' }, caller);
      assert.equal(started.status, 200);
      assert.equal(started.value.ok, true);
      await caller.dispose();
      assert.equal(caller.signal.aborted, true);
      assert.equal(connection.browserPeer.signal.aborted, false);
      const payload = { id: started.value.id, operation: 'demo.consume' };
      assert.equal((await call('wait', payload, connection.browserPeer)).value.state, 'ready');
      assert.equal((await call('consume', payload, connection.browserPeer)).value.state, 'consumed');
    } finally {
      await caller.dispose();
      await pluginFiber.dispose();
      await connectionFiber.dispose();
    }
  });
