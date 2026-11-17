let delegate;

export function configureHostLauncher(launcher) {
  if (delegate || typeof launcher !== 'function') throw new Error('Host launcher already configured');
  delegate = launcher;
}

export function spawn(...args) {
  if (!delegate) throw new Error('A sandboxed Host launcher is required');
  return delegate(...args);
}
