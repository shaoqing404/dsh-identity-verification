export function nativeSource(event, sources, { windowFor, defaultSession, noSandbox, focused = false }) {
  const contents = event?.sender;
  if (!contents || contents.isDestroyed()) return null;
  const window = windowFor(contents);
  const source = sources.get(contents.id);
  const frame = event.senderFrame;
  if (!window || !source || frame !== contents.mainFrame || source.frame !== frame
    || contents.session !== defaultSession) return null;
  let url;
  try { url = new URL(frame.url); } catch { return null; }
  const preferences = contents.getLastWebPreferences();
  if (url.protocol !== 'dsh-app:' || url.host !== 'app' || url.username || url.password
    || preferences.sandbox !== true || preferences.contextIsolation !== true
    || preferences.nodeIntegration !== false || noSandbox || (focused && !window.isFocused())) return null;
  return { ...source, window };
}
