'use strict';
// Checks GitHub Releases for a newer version and installs it when the user says yes.
// Releases are built and published by .github/workflows/release.yml on every push.
const { app } = require('electron');
const { EventEmitter } = require('node:events');
const U = require('./util');

const events = new EventEmitter();
const state = {
  status: 'idle', // idle | dev | checking | none | available | downloading | ready | error
  version: null,
  notes: [],
  progress: 0,
  error: null,
  dismissed: false,
};

let autoUpdater = null;

function set(patch) {
  Object.assign(state, patch);
  events.emit('change');
}

/** Release notes arrive as HTML (or a list of versions); turn them into plain lines. */
function notesToLines(notes) {
  const html = Array.isArray(notes) ? notes.map((n) => n.note || '').join('\n') : String(notes || '');
  return html
    .replace(/<\/(p|li|h\d)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split('\n')
    .map((line) => line.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 12);
}

function friendlyError(err) {
  const message = String(err?.message || err);
  if (/404|Cannot find latest|No published versions/i.test(message)) return 'No published version was found on GitHub yet.';
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|net::/i.test(message)) return 'Could not reach GitHub. Check your internet connection.';
  return message.split('\n')[0].slice(0, 200);
}

function init() {
  if (!app.isPackaged) return set({ status: 'dev' });

  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = {
    info: (m) => U.log('[updater]', m),
    warn: (m) => U.log('[updater]', m),
    error: (m) => U.log('[updater]', m),
    debug: () => {},
  };

  autoUpdater.on('checking-for-update', () => set({ status: 'checking', error: null }));
  autoUpdater.on('update-not-available', () => set({ status: 'none' }));
  autoUpdater.on('update-available', (info) => {
    const isNew = info.version !== state.version;
    set({ status: 'available', version: info.version, notes: notesToLines(info.releaseNotes), dismissed: isNew ? false : state.dismissed });
  });
  autoUpdater.on('download-progress', (p) => set({ status: 'downloading', progress: (p.percent || 0) / 100 }));
  autoUpdater.on('update-downloaded', () => set({ status: 'ready', progress: 1 }));
  autoUpdater.on('error', (err) => {
    U.log('Update error:', err);
    set({ status: ['downloading', 'ready'].includes(state.status) ? 'available' : 'error', error: friendlyError(err) });
  });
}

function check() {
  if (!autoUpdater || ['checking', 'downloading', 'ready'].includes(state.status)) return;
  autoUpdater.checkForUpdates().catch(() => {}); // reported through the 'error' event
}

/** Downloads the update, then restarts the app into the new version. */
async function install() {
  if (!autoUpdater || state.status !== 'available') throw new Error('No update is available right now.');
  set({ status: 'downloading', progress: 0, error: null });
  await autoUpdater.downloadUpdate();
  set({ status: 'ready', progress: 1 });
  setTimeout(() => autoUpdater.quitAndInstall(true, true), 1200);
}

module.exports = {
  events,
  getState: () => state,
  init,
  check,
  install,
  dismiss: () => set({ dismissed: true }),
  isInstalling: () => state.status === 'ready',
};
