import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { installNativeAuthentication } from './native-auth-adapter.mjs';

const lab = fs.realpathSync(process.env.DSH_TOUCH_ID_LAB);
const environmentRoot = path.join(lab, 'native-rc3');
if (app.isPackaged || process.env.DSH_DESKTOP_DEV_APP || process.env.ELECTRON_FORCE_IS_PACKAGED) {
  throw new Error('The native lab requires the unpackaged Electron runtime');
}
app.setName('DSH Touch ID Lab');
for (const [name, directory] of Object.entries({
  home: 'state/home',
  appData: 'state/app-data',
  userData: 'state/electron',
  sessionData: 'state/chromium',
  crashDumps: 'state/crash-dumps',
})) {
  const destination = path.join(environmentRoot, directory);
  fs.mkdirSync(destination, { recursive: true });
  app.setPath(name, destination);
}
const temporaryDirectory = fs.realpathSync(process.env.TMPDIR);
if (!temporaryDirectory.startsWith('/private/tmp/dshti.')) throw new Error('Unexpected lab temporary directory');
app.setPath('temp', temporaryDirectory);

// The upstream shell calls this without arguments at module initialization.
// Keep that call inside the lab as well as the initial log path.
const setAppLogsPath = app.setAppLogsPath.bind(app);
app.setAppLogsPath = () => setAppLogsPath(path.join(environmentRoot, 'state/logs'));
app.setAppLogsPath();
const evidence = path.join(environmentRoot, 'runtime.json');
const securityEvidence = {};
installNativeAuthentication(lab, securityEvidence);
const publish = () => {
  fs.writeFileSync(evidence, JSON.stringify({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    pid: process.pid,
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    ...securityEvidence,
    paths: Object.fromEntries(['home', 'appData', 'userData', 'sessionData', 'temp', 'logs', 'crashDumps']
      .map(name => [name, app.getPath(name)])),
    windows: BrowserWindow.getAllWindows().map(window => ({
      id: window.id,
      url: window.webContents.getURL().split('?')[0],
      destroyed: window.isDestroyed(),
    })),
  }, null, 2) + '\n', { mode: 0o600 });
};
app.on('browser-window-created', (_event, window) => {
  const title = 'DSH Touch ID Lab · ' + app.getVersion();
  window.setTitle(title);
  window.on('page-title-updated', event => {
    event.preventDefault();
    window.setTitle(title);
  });
  window.webContents.on('did-finish-load', publish);
  window.webContents.on('render-process-gone', publish);
  publish();
});
await import('./lib/main-lab.js');
