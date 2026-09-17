'use strict';
// Makes sure everything `npx twitch-dlp` needs is available:
//   * Node.js 22+ with npx  (a private copy is downloaded if the PC doesn't have one)
//   * ffmpeg                (downloaded if it is not installed)
//   * twitch-dlp            (fetched once by npx so the first download starts fast)
// Downloaded tools go to %LOCALAPPDATA%\Esmount VOD Downloader\tools - nothing is installed system-wide.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { EventEmitter } = require('node:events');
const P = require('./paths');
const U = require('./util');

const MIN_NODE_MAJOR = 22;
const TWITCH_DLP_PACKAGE = 'twitch-dlp@latest';

const FFMPEG_SOURCES = [
  {
    name: 'gyan.dev',
    url: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    checksumUrl: 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256',
  },
  {
    name: 'GitHub',
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
    checksumUrl: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/checksums.sha256',
    checksumName: 'ffmpeg-master-latest-win64-gpl.zip',
  },
];

const events = new EventEmitter();
const state = {
  status: 'idle', // idle | working | ready | error
  error: null,
  steps: {
    node: { label: 'Node.js + npx', status: 'pending', detail: 'Waiting…', progress: null },
    ffmpeg: { label: 'ffmpeg', status: 'pending', detail: 'Waiting…', progress: null },
    twitchDlp: { label: 'twitch-dlp', status: 'pending', detail: 'Waiting…', progress: null },
  },
};

let nodeDir = null; // added to PATH when we use our private Node.js copy
let ffmpegDir = null; // added to PATH when we use our private ffmpeg copy
let nodePromise = null;
let twitchDlpPromise = null;
let allPromise = null;

const emit = () => events.emit('change');
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

function setStep(key, patch) {
  Object.assign(state.steps[key], patch);
  emit();
}

/** Environment for commands: plain output, plus our private tools on PATH. */
function commandEnv() {
  const env = { ...process.env, NO_COLOR: '1', NODE_NO_WARNINGS: '1', npm_config_update_notifier: 'false', npm_config_fund: 'false' };
  delete env.FORCE_COLOR;
  delete env.ELECTRON_RUN_AS_NODE;
  const extra = [nodeDir, ffmpegDir].filter(Boolean);
  if (extra.length) {
    const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'Path';
    env[key] = [...extra, env[key] || ''].join(path.delimiter);
  }
  return env;
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

// ---------------------------------------------------------------- Node.js + npx

async function nodeMajor(nodeExe) {
  try {
    const { code, stdout } = await U.run(nodeExe, ['--version'], { timeout: 15000 });
    return code === 0 ? Number(stdout.trim().match(/^v(\d+)\./)?.[1]) || 0 : 0;
  } catch {
    return 0;
  }
}

async function npxWorks(env) {
  try {
    const { code } = await U.runCommand('npx --version', { env, timeout: 60000 });
    return code === 0;
  } catch {
    return false;
  }
}

async function downloadNode() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  setStep('node', { detail: 'Finding the latest version…', progress: null });
  const releases = await U.fetchJson('https://nodejs.org/dist/index.json', { timeout: 30000 });
  const release = releases.find(
    (r) => r.lts && Number(r.version.slice(1).split('.')[0]) >= MIN_NODE_MAJOR && r.files.includes(`win-${arch}-zip`),
  );
  if (!release) throw new Error('no suitable Node.js release was found');

  const name = `node-${release.version}-win-${arch}`;
  const zip = path.join(P.TMP, `${name}.zip`);
  const extractDir = path.join(P.TMP, 'node-extract');
  await fsp.rm(extractDir, { recursive: true, force: true });

  await U.downloadFile(`https://nodejs.org/dist/${release.version}/${name}.zip`, zip, (done, total) =>
    setStep('node', { progress: total ? done / total : null, detail: `Downloading ${release.version}… ${mb(done)}${total ? ` of ${mb(total)}` : ''}` }),
  );

  setStep('node', { detail: 'Verifying…', progress: null });
  const sums = await U.fetchText(`https://nodejs.org/dist/${release.version}/SHASUMS256.txt`);
  const expected = sums.split('\n').find((l) => l.trim().endsWith(`  ${name}.zip`))?.split(/\s+/)[0];
  if (!expected || (await sha256(zip)) !== expected.toLowerCase()) {
    await fsp.rm(zip, { force: true });
    throw new Error('the Node.js download was corrupted');
  }

  setStep('node', { detail: 'Unpacking…' });
  await U.extractZip(zip, extractDir);
  await fsp.rm(P.NODE_DIR, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(P.NODE_DIR), { recursive: true });
  await fsp.rename(path.join(extractDir, name), P.NODE_DIR);
  await fsp.rm(extractDir, { recursive: true, force: true });
  await fsp.rm(zip, { force: true });
}

async function ensureNode() {
  setStep('node', { status: 'working', detail: 'Checking…', progress: null });

  // 1. Our private copy from an earlier run.
  if ((await nodeMajor(path.join(P.NODE_DIR, 'node.exe'))) >= MIN_NODE_MAJOR && fs.existsSync(path.join(P.NODE_DIR, 'npx.cmd'))) {
    nodeDir = P.NODE_DIR;
    return setStep('node', { status: 'done', detail: 'Ready' });
  }

  // 2. Node.js installed on this PC.
  const systemMajor = await nodeMajor('node');
  if (systemMajor >= MIN_NODE_MAJOR && (await npxWorks(commandEnv()))) {
    nodeDir = null;
    return setStep('node', { status: 'done', detail: 'Found on this PC' });
  }

  // 3. Download a private copy.
  U.log(systemMajor ? `Node.js v${systemMajor} is too old, downloading a private copy` : 'Node.js not found, downloading a private copy');
  await downloadNode();
  nodeDir = P.NODE_DIR;
  if (!(await npxWorks(commandEnv()))) throw new Error('npx does not run');
  setStep('node', { status: 'done', detail: 'Ready', progress: null });
}

// ---------------------------------------------------------------- ffmpeg

async function ffmpegRuns(exe) {
  try {
    const { code } = await U.run(exe, ['-version'], { timeout: 20000 });
    return code === 0;
  } catch {
    return false;
  }
}

async function expectedChecksum(source) {
  try {
    const lines = (await U.fetchText(source.checksumUrl)).split(/\r?\n/);
    const line = source.checksumName ? lines.find((l) => l.includes(source.checksumName)) : lines[0];
    return line?.match(/\b[a-f0-9]{64}\b/i)?.[0].toLowerCase() || null;
  } catch {
    return null;
  }
}

async function downloadFfmpeg(source) {
  const zip = path.join(P.TMP, 'ffmpeg.zip');
  const extractDir = path.join(P.TMP, 'ffmpeg-extract');
  await fsp.rm(extractDir, { recursive: true, force: true });

  await U.downloadFile(source.url, zip, (done, total) =>
    setStep('ffmpeg', { progress: total ? done / total : null, detail: `Downloading… ${mb(done)}${total ? ` of ${mb(total)}` : ''}` }),
  );

  setStep('ffmpeg', { detail: 'Verifying…', progress: null });
  const expected = await expectedChecksum(source);
  if (expected && (await sha256(zip)) !== expected) {
    await fsp.rm(zip, { force: true });
    throw new Error('the download was corrupted');
  }

  setStep('ffmpeg', { detail: 'Unpacking…' });
  await U.extractZip(zip, extractDir);
  const entries = await fsp.readdir(extractDir, { recursive: true });
  const exe = entries.find((f) => path.basename(f).toLowerCase() === 'ffmpeg.exe');
  if (!exe) throw new Error('ffmpeg.exe was not found in the download');
  const binDir = path.dirname(path.join(extractDir, exe));

  await fsp.rm(P.FFMPEG_DIR, { recursive: true, force: true });
  await fsp.mkdir(P.FFMPEG_DIR, { recursive: true });
  for (const file of ['ffmpeg.exe', 'ffprobe.exe']) {
    if (fs.existsSync(path.join(binDir, file))) await fsp.copyFile(path.join(binDir, file), path.join(P.FFMPEG_DIR, file));
  }
  await fsp.rm(extractDir, { recursive: true, force: true });
  await fsp.rm(zip, { force: true });
  if (!(await ffmpegRuns(path.join(P.FFMPEG_DIR, 'ffmpeg.exe')))) throw new Error('the downloaded ffmpeg does not run');
}

async function ensureFfmpeg() {
  setStep('ffmpeg', { status: 'working', detail: 'Checking…', progress: null });

  if (await ffmpegRuns(path.join(P.FFMPEG_DIR, 'ffmpeg.exe'))) {
    ffmpegDir = P.FFMPEG_DIR;
    return setStep('ffmpeg', { status: 'done', detail: 'Ready' });
  }
  if (await ffmpegRuns('ffmpeg')) {
    ffmpegDir = null;
    return setStep('ffmpeg', { status: 'done', detail: 'Found on this PC' });
  }

  let lastError = null;
  for (const source of FFMPEG_SOURCES) {
    try {
      await downloadFfmpeg(source);
      ffmpegDir = P.FFMPEG_DIR;
      return setStep('ffmpeg', { status: 'done', detail: 'Ready', progress: null });
    } catch (err) {
      lastError = err;
      U.log(`ffmpeg download from ${source.name} failed:`, err);
    }
  }
  throw new Error(`could not download ffmpeg (${lastError?.message})`);
}

// ---------------------------------------------------------------- twitch-dlp

/** `npx twitch-dlp …` as it will be run (and shown to the user). */
const twitchDlpCommand = (args) => ['npx', '--yes', TWITCH_DLP_PACKAGE, ...args].map(U.quoteArg).join(' ');

async function ensureTwitchDlp() {
  await nodePromise;
  setStep('twitchDlp', { status: 'working', detail: 'Getting the latest version…', progress: null });
  const { code, stdout, stderr } = await U.runCommand(twitchDlpCommand(['--version']), { env: commandEnv(), timeout: 5 * 60 * 1000 });
  const version = stdout.match(/\b\d+\.\d+\.\d+\b/)?.[0];
  if (code !== 0 || !version) {
    U.log('twitch-dlp check failed:', stdout, stderr);
    throw new Error('could not get twitch-dlp from npm');
  }
  setStep('twitchDlp', { status: 'done', detail: `v${version}` });
}

// ---------------------------------------------------------------- public API

function failStep(key) {
  return (err) => {
    U.log(`Setting up ${key} failed:`, err);
    const message = `${err.message.charAt(0).toUpperCase()}${err.message.slice(1)}`;
    setStep(key, { status: 'error', detail: message, progress: null });
    state.status = 'error';
    state.error = `${state.steps[key].label}: ${message}. Check your internet connection and try again.`;
    emit();
    throw err;
  };
}

/** Starts setup, or retries it after an error. */
function start() {
  if (state.status === 'working' || state.status === 'ready') return;
  if (Object.values(state.steps).some((step) => step.status === 'working')) return;
  state.status = 'working';
  state.error = null;
  emit();
  nodePromise = ensureNode().catch(failStep('node'));
  const ffmpegPromise = ensureFfmpeg().catch(failStep('ffmpeg'));
  twitchDlpPromise = ensureTwitchDlp().catch((err) => {
    if (state.steps.node.status === 'error') {
      setStep('twitchDlp', { status: 'pending', detail: 'Needs Node.js', progress: null });
      throw err;
    }
    return failStep('twitchDlp')(err);
  });
  allPromise = Promise.all([nodePromise, ffmpegPromise, twitchDlpPromise]).then(() => {
    state.status = 'ready';
    emit();
  });
  allPromise.catch(() => {});
}

module.exports = {
  events,
  getState: () => state,
  start,
  /** Resolves when `npx twitch-dlp` can run (enough for listing qualities). */
  whenTwitchDlpReady: () => twitchDlpPromise,
  /** Resolves when everything needed for downloading is ready. */
  whenReady: () => allPromise,
  commandEnv,
  twitchDlpCommand,
};
