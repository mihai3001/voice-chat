// Minimal process shim for browser
export const process = {
  env: { NODE_ENV: 'production' },
  nextTick: (fn, ...args) => Promise.resolve().then(() => fn(...args)),
  browser: true,
  version: '',
  versions: {},
  platform: 'browser'
};
