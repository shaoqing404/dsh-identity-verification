import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeSource } from '../../scripts/native-source-guard.mjs';

function fixture() {
  const frame = { url: 'dsh-app://app/' };
  const preferences = { sandbox: true, contextIsolation: true, nodeIntegration: false };
  const session = {};
  const window = { isFocused: () => true };
  const contents = { id: 1, mainFrame: frame, session, isDestroyed: () => false,
    getLastWebPreferences: () => preferences };
  return { event: { sender: contents, senderFrame: frame }, preferences,
    sources: new Map([[1, { frame, clientId: 'window-1-generation-1' }]]),
    options: { windowFor: () => window, defaultSession: session, noSandbox: false, focused: true } };
}

test('native source binds the actual window, frame, isolated session and document generation', () => {
  const f = fixture();
  assert.equal(nativeSource(f.event, f.sources, f.options).clientId, 'window-1-generation-1');
  f.event.senderFrame = { url: 'dsh-app://app/' };
  assert.equal(nativeSource(f.event, f.sources, f.options), null);
  f.event.senderFrame = f.event.sender.mainFrame;
  f.sources.get(1).frame = { url: 'dsh-app://app/' };
  assert.equal(nativeSource(f.event, f.sources, f.options), null);
  f.sources.clear();
  assert.equal(nativeSource(f.event, f.sources, f.options), null);
});

test('web origins, missing focus and weakened renderer preferences cannot authenticate', () => {
  for (const mutate of [
    f => { f.event.senderFrame.url = 'http://127.0.0.1:38485/'; },
    f => { f.event.senderFrame.url = 'dsh-app://shell/'; },
    f => { f.event.senderFrame.url = 'dsh-app://user@app/'; },
    f => { f.options.noSandbox = true; },
    f => { f.preferences.sandbox = false; },
    f => { f.preferences.contextIsolation = false; },
    f => { f.preferences.nodeIntegration = true; },
    f => { f.event.sender.session = {}; },
    f => { f.options.windowFor = () => ({ isFocused: () => false }); },
    f => { f.event.sender.isDestroyed = () => true; },
  ]) {
    const f = fixture();
    mutate(f);
    assert.equal(nativeSource(f.event, f.sources, f.options), null);
  }
});
