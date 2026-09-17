'use strict';
const path = require('node:path');

// Everything the app downloads or saves lives in %LOCALAPPDATA%\Esmount VOD Downloader.
const DATA = path.join(process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local'), 'Esmount VOD Downloader');

module.exports = {
  DATA,
  NODE_DIR: path.join(DATA, 'tools', 'node'),
  FFMPEG_DIR: path.join(DATA, 'tools', 'ffmpeg'),
  TMP: path.join(DATA, 'tmp'),
  LOGS: path.join(DATA, 'logs'),
  SETTINGS_FILE: path.join(DATA, 'settings.json'),
};
