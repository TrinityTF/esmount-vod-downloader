'use strict';
// The only bridge between the window and the main process.
const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function subscribe(channel, callback) {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

contextBridge.exposeInMainWorld('esmount', {
  getState: () => call('state:get'),
  onState: (callback) => subscribe('state', callback),
  onLog: (callback) => subscribe('log', callback),

  retrySetup: () => call('tools:retry'),
  getVideo: (url) => call('video:get', url),
  getFormats: (url) => call('video:formats', url),

  previewCommand: (options) => call('download:preview', options),
  startDownload: (options) => call('download:start', options),
  cancelDownload: (id) => call('download:cancel', id),
  stopAndSaveDownload: (id) => call('download:stop-and-save', id),
  saveDownloadedParts: (id) => call('download:save-parts', id),
  retryDownload: (id) => call('download:retry', id),
  removeDownload: (id) => call('download:remove', id),
  clearFinished: () => call('download:clear-finished'),
  deleteParts: (id) => call('download:delete-parts', id),
  showDownload: (id) => call('download:reveal', id),
  getDownloadLog: (id) => call('download:log', id),

  pickFolder: (initial) => call('folder:pick', initial),
  openFolder: (dir) => call('folder:open', dir),
  saveSettings: (patch) => call('settings:save', patch),
  copyText: (text) => call('clipboard:write', text),

  checkForUpdates: () => call('update:check'),
  installUpdate: () => call('update:install'),
  dismissUpdate: () => call('update:dismiss'),
});
