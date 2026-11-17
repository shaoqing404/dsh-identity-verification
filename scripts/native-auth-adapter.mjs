import { app, BrowserWindow, dialog, ipcMain, powerMonitor, session } from 'electron';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { NativeHostChannel } from './native-auth-channel.mjs';
import { NativeHelperRunner } from './native-helper-runner.mjs';
import { nativeSource } from './native-source-guard.mjs';
import { configureHostLauncher } from './native-host-launch.mjs';

const CALLER_ID = 'dsh-touch-id.self-check';
const POLICIES = new Set(['system-owner', 'biometrics-only']);
const OUTCOMES = new Set(['granted', 'cancelled', 'unavailable', 'timeout', 'error']);

export function installNativeAuthentication(lab, runtimeEvidence) {
  const native = path.join(lab, 'native-rc3');
  const hostEntry = path.join(native, 'shell/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js');
  const preload = path.join(native, 'shell/native-auth-preload.cjs');
  const helperManifest = JSON.parse(fs.readFileSync(path.join(lab, 'm3/helper.json'), 'utf8'));
  if (!fs.realpathSync(helperManifest.path).startsWith(path.join(lab, 'm3/native') + path.sep)) {
    throw new Error('Unexpected native helper location');
  }
  const helper = new NativeHelperRunner(helperManifest);
  const originalSpawn = childProcess.spawn;
  let channel = null;
  let active = null;
  let generation = 0;
  const sources = new Map();

  function invalidate(reason) {
    if (!active || active.controller.signal.aborted) return;
    active.reason = reason;
    active.controller.abort();
    if (active.request && active.phase !== 'finishing') {
      active.cancelPromise ??= channel?.call('cancel', binding(active.request)).catch(() => null);
    }
  }

  configureHostLauncher(function spawnHost(command, args, options) {
    if (command !== process.execPath || !Array.isArray(args) || !args.includes(hostEntry)) {
      return originalSpawn.call(this, command, args, options);
    }
    if (!Array.isArray(options?.stdio) || options.stdio.length !== 4 || options.stdio[3] !== 'ipc') {
      throw new Error('Unexpected Desktop Host IPC layout');
    }
    const child = originalSpawn('/usr/bin/sandbox-exec', [
      '-D', 'LAB=' + lab, '-D', 'TEMP=' + fs.realpathSync(process.env.TMPDIR),
      '-f', path.join(native, 'host.sb'), command, ...args,
    ], {
      ...options,
      env: { ...options.env, DSH_TOUCH_ID_NATIVE_CHANNEL: '1' },
      stdio: [...options.stdio, 'pipe'],
    });
    if (!child.stdio[4]) {
      child.kill();
      throw new Error('Private Host channel unavailable');
    }
    channel?.close();
    const currentChannel = new NativeHostChannel(child.stdio[4], message => {
      if (active?.request?.requestId === message.requestId) invalidate(message.reason);
    });
    channel = currentChannel;
    channel.onClose = () => invalidate('host-disconnected');
    child.once('exit', () => currentChannel.close());
    fs.writeFileSync(path.join(lab, 'm3/host-launch.json'), JSON.stringify({
      pid: child.pid, sandboxed: true, privateChannel: true, originalIpc: true,
    }, null, 2) + '\n', { mode: 0o600 });
    void currentChannel.call('status').then(async () => {
      if (currentChannel !== channel || currentChannel.closed) return;
      const window = BrowserWindow.getAllWindows().find(candidate => sources.has(candidate.webContents.id));
      if (!window) return;
      const value = await capabilities({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
      runtimeEvidence.nativeAuthentication.lastCheck = value?.ok === true ? 'ready' : value?.code || 'unavailable';
      fs.writeFileSync(path.join(lab, 'm3/security-status.json'),
        JSON.stringify(runtimeEvidence.nativeAuthentication, null, 2) + '\n', { mode: 0o600 });
    }).catch(error => {
      fs.writeFileSync(path.join(lab, 'm3/channel-status.json'), JSON.stringify({
        ready: false, code: error.code || 'channel-failed',
      }, null, 2) + '\n', { mode: 0o600 });
    });
    return child;
  });

  function binding(request) {
    return { requestId: request.requestId, callerId: request.callerId, clientId: request.clientId };
  }

  function sourceOf(event, focused = false) {
    return nativeSource(event, sources, {
      windowFor: contents => BrowserWindow.fromWebContents(contents),
      defaultSession: session.defaultSession, noSandbox: app.commandLine.hasSwitch('no-sandbox'), focused,
    });
  }

  async function capabilities(event) {
    if (!sourceOf(event)) return { ok: false, code: 'untrusted-source' };
    if (!channel || channel.closed) return { ok: false, code: 'native-channel-unavailable' };
    const status = await channel.call('status');
    const checked = await helper.run(['--check'], { timeoutMs: 5000 });
    if (checked.exitCode !== 0 || checked.result.schemaVersion !== 1 || checked.result.operation !== 'check') {
      return { ok: false, code: 'invalid-helper-output' };
    }
    runtimeEvidence.nativeAuthentication.channelReady = true;
    runtimeEvidence.nativeAuthentication.helperCheckPassed = true;
    fs.writeFileSync(path.join(lab, 'm3/security-status.json'),
      JSON.stringify(runtimeEvidence.nativeAuthentication, null, 2) + '\n', { mode: 0o600 });
    return { ok: true, callerId: status.callerId, actionId: status.actionId, title: status.title,
      systemOwner: checked.result.systemOwner, biometricsOnly: checked.result.biometricsOnly,
      biometryType: checked.result.biometryType };
  }

  async function verify(event, payload) {
    const source = sourceOf(event, true);
    if (!source) return { ok: false, code: 'untrusted-source' };
    const stillSource = (focused = false) => sourceOf(event, focused)?.clientId === source.clientId;
    if (!payload || Object.keys(payload).length !== 1 || !POLICIES.has(payload.policy)) {
      return { ok: false, code: 'invalid-request' };
    }
    if (!channel || channel.closed) return { ok: false, code: 'native-channel-unavailable' };
    if (active || helper.busy) return { ok: false, code: 'busy' };
    const attempt = { clientId: source.clientId, controller: new AbortController(), request: null, phase: 'creating' };
    active = attempt;
    let timer;
    let finished = false;
    try {
      const request = await channel.call('create', {
        callerId: CALLER_ID, clientId: source.clientId, policy: payload.policy,
      });
      attempt.request = request;
      if (request.ok !== true || request.callerId !== CALLER_ID || request.clientId !== source.clientId
        || request.actionId !== 'demo_verify' || request.policy !== payload.policy || !request.requestId
        || !Number.isFinite(request.deadline) || request.deadline <= Date.now()) {
        throw new Error('invalid-host-request');
      }
      if (attempt.controller.signal.aborted || !stillSource(true)) throw new Error('source-invalidated');
      timer = setTimeout(() => invalidate('timeout'), request.deadline - Date.now());
      attempt.phase = 'confirming';
      const confirmation = await dialog.showMessageBox(source.window, {
        type: 'question', title: 'DSH 身份验证', message: request.title,
        detail: '调用方：DSH 身份验证\n用途：确认本次身份验证自检\n验证结果仅返回给这次调用。\n'
          + (request.policy === 'biometrics-only' ? '方式：仅生物识别' : '方式：macOS 系统验证'),
        buttons: ['取消', '开始验证'], defaultId: 0, cancelId: 0, noLink: true,
        signal: attempt.controller.signal,
      });
      if (confirmation.response !== 1 || attempt.controller.signal.aborted || !stillSource()) {
        if (attempt.reason === 'timeout') return { ok: false, code: 'timeout' };
        const cancelled = await (attempt.cancelPromise ?? channel.call('cancel', binding(request)));
        finished = cancelled?.ok === true && cancelled.requestId === request.requestId;
        return { ok: false, code: finished ? 'cancelled' : 'cancellation-unconfirmed' };
      }
      const claimed = await channel.call('claim', binding(request));
      if (claimed.ok !== true || claimed.state !== 'verifying') throw new Error('request-invalidated');
      if (attempt.controller.signal.aborted || !stillSource()) throw new Error('source-invalidated');
      const remaining = Math.floor(request.deadline - Date.now());
      if (remaining < 5000) throw new Error('timeout');
      attempt.phase = 'authenticating';
      attempt.helperPromise = helper.run([
        '--request-id', request.requestId, '--action-id', request.actionId,
        '--policy', request.policy, '--timeout-ms', String(Math.min(30000, remaining)),
      ], { signal: attempt.controller.signal, timeoutMs: remaining + 1000 });
      const checked = await attempt.helperPromise;
      const value = checked.result;
      if (attempt.controller.signal.aborted || !stillSource()) throw new Error('source-invalidated');
      if (value.schemaVersion !== 1 || value.operation !== 'authenticate' || value.requestId !== request.requestId
        || value.actionId !== request.actionId || value.policy !== request.policy
        || !OUTCOMES.has(value.outcome) || value.method !== 'unknown'
        || (value.outcome === 'granted' ? checked.exitCode !== 0 : checked.exitCode !== 1)) {
        throw new Error('invalid-helper-output');
      }
      attempt.phase = 'finishing';
      const receipt = await channel.call('finish', {
        ...binding(request), outcome: value.outcome,
        reason: value.reason ? value.reason.replaceAll('_', '-') : 'authenticated',
      });
      if (attempt.controller.signal.aborted || !stillSource()) throw new Error('source-invalidated');
      if (receipt.ok !== true || receipt.requestId !== request.requestId
        || receipt.callerId !== request.callerId || receipt.clientId !== request.clientId
        || receipt.actionId !== request.actionId || receipt.policy !== request.policy
        || receipt.outcome !== value.outcome) throw new Error('invalid-host-receipt');
      finished = true;
      const result = { ...receipt, method: value.method, elapsedMs: value.elapsedMs };
      try {
        fs.appendFileSync(path.join(lab, 'm3/authentication-results.jsonl'), JSON.stringify({
          outcome: receipt.outcome, policy: receipt.policy, actionId: receipt.actionId, source: 'native-self-check',
        }) + '\n', { mode: 0o600 });
      } catch { result.evidenceWritten = false; }
      return result;
    } catch {
      if (attempt.phase === 'finishing') return { ok: false, code: 'result-unconfirmed' };
      return { ok: false, code: attempt.reason === 'timeout' ? 'timeout' : 'verification-incomplete' };
    } finally {
      clearTimeout(timer);
      if (!finished && attempt.request) {
        await channel?.call('cancel', binding(attempt.request)).catch(() => {});
      }
      attempt.controller.abort();
      if (active === attempt) active = null;
      if (!attempt.reason && !source.window.isDestroyed() && stillSource()) source.window.focus();
    }
  }

  app.whenReady().then(() => {
    if (typeof session.defaultSession.registerPreloadScript !== 'function') {
      throw new Error('A sandboxed authentication preload is required');
    }
    session.defaultSession.registerPreloadScript({ type: 'frame', filePath: preload });
    ipcMain.handle('dsh-touch-id:capabilities', event => capabilities(event)
      .catch(() => ({ ok: false, code: 'verification-unavailable' })));
    ipcMain.handle('dsh-touch-id:verify', verify);
    ipcMain.handle('dsh-touch-id:cancel', async event => {
      const source = sourceOf(event);
      if (!source || !active || active.clientId !== source.clientId) return { ok: false, code: 'unknown-request' };
      if (active.phase === 'finishing') return { ok: false, code: 'completion-pending' };
      const attempt = active;
      invalidate('cancelled');
      const result = await attempt.cancelPromise;
      if (attempt.helperPromise) await attempt.helperPromise.catch(() => {});
      return !helper.busy && result?.ok === true && result.requestId === attempt.request?.requestId
        ? { ok: true } : { ok: false, code: 'cancellation-unconfirmed' };
    });
    powerMonitor.on('lock-screen', () => invalidate('screen-locked'));
    powerMonitor.on('suspend', () => invalidate('suspended'));
  });

  app.on('browser-window-created', (_event, window) => {
    const contents = window.webContents;
    const registerSource = () => {
      const url = new URL(contents.getURL());
      if (url.protocol !== 'dsh-app:' || url.host !== 'app') return;
      if (sources.get(contents.id)?.frame !== contents.mainFrame) {
        sources.set(contents.id, { frame: contents.mainFrame, clientId: 'window-' + contents.id + '-generation-' + (++generation) });
      }
      const preferences = contents.getLastWebPreferences();
      runtimeEvidence.nativeAuthentication = {
        sourceRegistered: true, channelReady: false, helperCheckPassed: false,
        rendererSandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration, noSandboxFlag: app.commandLine.hasSwitch('no-sandbox'),
        remoteDebugging: app.commandLine.hasSwitch('remote-debugging-port'),
      };
      // Capability checks are noninteractive. They exercise the actual Host
      // channel and helper before any user requests an authentication dialog.
      void capabilities({ sender: contents, senderFrame: contents.mainFrame }).then(value => {
        runtimeEvidence.nativeAuthentication.lastCheck = value?.ok === true ? 'ready' : value?.code || 'unavailable';
        fs.writeFileSync(path.join(lab, 'm3/security-status.json'),
          JSON.stringify(runtimeEvidence.nativeAuthentication, null, 2) + '\n', { mode: 0o600 });
      }).catch(error => {
        runtimeEvidence.nativeAuthentication.helperCheckPassed = false;
        runtimeEvidence.nativeAuthentication.lastCheck = error.code || 'channel-or-helper-failed';
        fs.writeFileSync(path.join(lab, 'm3/security-status.json'),
          JSON.stringify(runtimeEvidence.nativeAuthentication, null, 2) + '\n', { mode: 0o600 });
      });
    };
    contents.on('dom-ready', registerSource);
    contents.on('did-finish-load', registerSource);
    const revoke = () => {
      const source = sources.get(contents.id);
      if (source?.clientId === active?.clientId) invalidate('source-invalidated');
      sources.delete(contents.id);
    };
    contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (!mainFrame) return;
      if (inPlace) {
        if (sources.get(contents.id)?.clientId === active?.clientId) invalidate('source-invalidated');
      } else revoke();
    });
    contents.on('render-process-gone', revoke);
    contents.on('destroyed', revoke);
  });
  app.on('before-quit', () => invalidate('application-exiting'));
}
