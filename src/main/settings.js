'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const P = require('./paths');
const U = require('./util');

const DOWNLOADS_FOLDER_ID = '{374DE290-123F-4565-9164-39C4925E467B}';

let settings = { downloadDir: '', quality: 'best', ...U.readJson(P.SETTINGS_FILE, {}) };

async function findDownloadsFolder() {
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders';
    const { stdout } = await U.run('reg.exe', ['query', key, '/v', DOWNLOADS_FOLDER_ID], { timeout: 5000 });
    const dir = stdout.match(/REG_SZ\s+(.+)/)?.[1].trim();
    if (dir && fs.existsSync(dir)) return dir;
  } catch {}
  const fallback = path.join(os.homedir(), 'Downloads');
  return fs.existsSync(fallback) ? fallback : os.homedir();
}

async function init() {
  if (!settings.downloadDir || !fs.existsSync(settings.downloadDir)) {
    settings.downloadDir = await findDownloadsFolder();
  }
}

const get = () => ({ ...settings });

async function update(patch) {
  const allowed = {};
  if (typeof patch.downloadDir === 'string' && patch.downloadDir.trim()) allowed.downloadDir = patch.downloadDir.trim();
  if (typeof patch.quality === 'string' && patch.quality.trim()) allowed.quality = patch.quality.trim();
  settings = { ...settings, ...allowed };
  await U.writeJson(P.SETTINGS_FILE, settings);
  return get();
}

module.exports = { init, get, update };
