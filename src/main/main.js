'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow, Notification, clipboard, dialog, ipcMain, nativeTheme, shell } = require('electron');
const P = require('./paths');

const APP_ID = 'com.esmount.voddownloader';
// An end time this close to a live broadcast's edge counts as "as far as it goes".
const LIVE_EDGE_MARGIN = 60;
app.setPath('userData', P.DATA);
app.setAppUserModelId(APP_ID);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start() {
  const U = require('./util');
  const settings = require('./settings');
  const tools = require('./tools');
  const twitch = require('./twitch');
  const downloads = require('./downloads');
  const updater = require('./updater');

  let win = null;
  let quitting = false;

  process.on('uncaughtException', (err) => U.log('Unexpected error:', err));
  process.on('unhandledRejection', (err) => U.log('Unhandled promise rejection:', err));

  // ---------------------------------------------------------------- window

  function createWindow() {
    win = new BrowserWindow({
      width: 1200,
      height: 920,
      minWidth: 780,
      minHeight: 600,
      title: 'Esmount VOD Downloader',
      icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e0e11' : '#f4f3f7',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    win.removeMenu();
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    win.once('ready-to-show', () => win.show());
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.on('focus', () => win.flashFrame(false));
    win.on('close', onClose);
    win.on('closed', () => (win = null));
  }

  async function onClose(event) {
    if (quitting || updater.isInstalling() || !downloads.hasActive()) return;
    event.preventDefault();
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: 'Downloads in progress',
      message: 'A download is still running.',
      detail: 'If you quit now it will stop. You can start the same download again later to continue where it left off.',
      buttons: ['Keep downloading', 'Stop and quit'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response === 1) {
      quitting = true;
      await downloads.cancelAll();
      app.quit();
    }
  }

  // ---------------------------------------------------------------- state → window

  const snapshot = () => ({
    version: app.getVersion(),
    tools: tools.getState(),
    update: updater.getState(),
    jobs: downloads.list(),
    settings: settings.get(),
  });

  let pushTimer = null;
  function pushState() {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      if (!win) return;
      win.webContents.send('state', snapshot());
      updateTaskbar();
    }, 150);
  }

  function updateTaskbar() {
    const job = downloads.list().find((j) => ['preparing', 'downloading', 'merging'].includes(j.status));
    if (!job) return win.setProgressBar(-1);
    if (job.status === 'preparing' || (job.status === 'merging' && !job.progress)) return win.setProgressBar(2, { mode: 'indeterminate' });
    win.setProgressBar(job.progress, { mode: 'normal' });
  }

  tools.events.on('change', pushState);
  updater.events.on('change', pushState);
  downloads.events.on('change', pushState);
  downloads.events.on('log', (jobId, line) => win?.webContents.send('log', { jobId, line }));

  downloads.events.on('finished', (job) => {
    if (!win || win.isFocused() || !['done', 'error'].includes(job.status)) return;
    win.flashFrame(true);
    if (!Notification.isSupported()) return;
    const notification = new Notification(
      job.status === 'done'
        ? { title: 'Download finished', body: job.fileName }
        : { title: 'Download failed', body: `${job.title}\n${job.error}` },
    );
    notification.on('click', () => {
      if (job.outputPath) shell.showItemInFolder(job.outputPath);
      win?.show();
    });
    notification.show();
  });

  // ---------------------------------------------------------------- IPC

  /** Validates what the window sent and fills in the VOD details. */
  async function resolveDownload(options, { forPreview = false } = {}) {
    const video = await twitch.getVideo(options.url);
    const formats = await twitch.getFormats(options.url);
    const format = formats.find((f) => f.id === options.format);
    if (!format) throw new Error('Please choose a quality.');

    const start = Math.floor(Number(options.start) || 0);
    let end = options.end === null || options.end === undefined || options.end === '' ? null : Math.floor(Number(options.end));
    if (!Number.isFinite(start) || start < 0) throw new Error('The start time is not valid.');
    if (end !== null && (!Number.isFinite(end) || end <= start)) throw new Error('The end time must be after the start time.');
    if (video.duration && start >= video.duration) throw new Error('The start time is after the end of the VOD.');
    if (video.duration && end !== null && end >= video.duration) end = null; // null = "to the end"

    // twitch-dlp cannot cut exactly at the live edge (the stream hasn't reached that
    // timestamp yet, so it would select nothing). Downloads that end there run without an
    // end time; the app either follows the broadcast or stops once it has caught up.
    const atLiveEdge = Boolean(video.isLive) && (end === null || end >= video.duration - LIVE_EDGE_MARGIN);
    if (atLiveEdge) end = null;
    const followLive = atLiveEdge && Boolean(options.followLive);

    const dir = String(options.dir || '').trim();
    if (!dir || !path.isAbsolute(dir)) throw new Error('Please choose a download folder.');
    if (!forPreview) {
      try {
        await fsp.mkdir(dir, { recursive: true });
      } catch {
        throw new Error('That folder could not be created. Please choose another one.');
      }
    }

    return {
      vodId: video.id,
      url: video.url,
      title: video.title,
      channel: video.channel,
      thumbnail: video.thumbnail,
      duration: video.duration,
      start,
      end,
      format: format.id,
      formatLabel: format.label,
      isBest: format === formats[0],
      dir,
      isLive: video.isLive,
      followLive,
      stopAtLiveEdge: atLiveEdge && !followLive,
    };
  }

  const handlers = {
    'state:get': () => snapshot(),
    'tools:retry': () => tools.start(),
    'video:get': (url) => twitch.getVideo(url),
    'video:formats': (url) => twitch.getFormats(url),

    'download:preview': async (options) => downloads.previewCommand(await resolveDownload(options, { forPreview: true })),
    'download:start': async (options) => {
      const download = await resolveDownload(options);
      await settings.update({ downloadDir: download.dir, quality: download.format });
      return downloads.create(download);
    },
    'download:cancel': (id) => downloads.cancel(id),
    'download:stop-and-save': (id) => downloads.cancel(id, { save: true }),
    'download:save-parts': (id) => downloads.saveParts(id),
    'download:retry': (id) => downloads.retry(id),
    'download:remove': (id) => downloads.remove(id),
    'download:clear-finished': () => downloads.clearFinished(),
    'download:delete-parts': (id) => downloads.deleteParts(id),
    'download:log': (id) => downloads.log(id),
    'download:reveal': async (id) => {
      const job = downloads.get(id);
      if (job?.outputPath && fs.existsSync(job.outputPath)) return shell.showItemInFolder(job.outputPath);
      if (job && fs.existsSync(job.dir)) return void (await shell.openPath(job.dir));
      throw new Error('The file or folder no longer exists.');
    },

    'folder:pick': async (initial) => {
      const result = await dialog.showOpenDialog(win, {
        title: 'Choose where to save downloads',
        defaultPath: initial && fs.existsSync(initial) ? initial : settings.get().downloadDir,
        properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
      });
      return result.canceled ? null : result.filePaths[0];
    },
    'folder:open': async (dir) => {
      if (!dir || !path.isAbsolute(dir) || !fs.existsSync(dir)) throw new Error('That folder does not exist yet.');
      const error = await shell.openPath(dir);
      if (error) throw new Error(error);
    },
    'settings:save': (patch) => settings.update(patch || {}),
    'clipboard:write': (text) => clipboard.writeText(String(text)),

    'update:check': () => updater.check(),
    'update:install': async () => {
      if (downloads.hasActive()) throw new Error('Please wait for your downloads to finish (or stop them) before updating.');
      quitting = true;
      try {
        await updater.install();
      } catch (err) {
        quitting = false;
        throw err;
      }
    },
    'update:dismiss': () => updater.dismiss(),
  };

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return { ok: true, value: await handler(...args) };
      } catch (err) {
        if (!/^(Please|The |That )/.test(err.message)) U.log(`${channel} failed:`, err);
        return { ok: false, error: err.message };
      }
    });
  }

  // ---------------------------------------------------------------- lifecycle

  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(async () => {
    U.log(`Esmount VOD Downloader v${app.getVersion()} starting`);
    await settings.init();
    createWindow();
    tools.start();
    updater.init();
    setTimeout(() => updater.check(), 3000);
    setInterval(() => updater.check(), 4 * 60 * 60 * 1000);
  });
}
