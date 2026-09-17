'use strict';
// Download queue. For each download it runs
//   npx --yes twitch-dlp@latest <VOD link> -f <quality> --download-sections "*<start>-<end>" -o "<file>"
// in cmd.exe (one at a time) and turns the command's output into progress for the UI.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const U = require('./util');
const tools = require('./tools');

const MAX_LOG_LINES = 500;
const ACTIVE = new Set(['queued', 'preparing', 'downloading', 'merging']);
const PROGRESS_REGEX = /\[download\]\s+([\d.,]+)%\s+of\s+~\s*(\S+)\s+at\s+(\S+)\s+ETA\s+(\S+)\s+\(frag\s+(\d+)\/(\d+)\)/;
const FFMPEG_TIME_REGEX = /\btime=(\d+):(\d+):(\d+(?:\.\d+)?)/;

const events = new EventEmitter();
const jobs = [];
const internals = new Map(); // job id -> { log, child, cancelRequested }
let running = false;
let nextId = 1;

const emit = () => events.emit('change');
const find = (id) => jobs.find((j) => j.id === id);
const isActive = (job) => ACTIVE.has(job.status);

function addLog(job, line) {
  const { log } = internals.get(job.id);
  log.push(line);
  if (log.length > MAX_LOG_LINES) log.splice(0, log.length - MAX_LOG_LINES);
  events.emit('log', job.id, line);
}

// ---------------------------------------------------------------- naming & command

const isWholeVod = (o) => o.start <= 0 && (o.end == null || o.end >= o.duration);
const clipLength = (job) => Math.max(1, (job.end == null ? job.duration : job.end) - job.start);

function baseName(o) {
  const title = o.title.length > 90 ? `${o.title.slice(0, 90).trim()}…` : o.title;
  let name = `${o.channel} - ${title} [v${o.vodId}]`;
  if (!isWholeVod(o)) name += ` (${U.formatStamp(o.start)}-${o.end == null ? 'end' : U.formatStamp(o.end)})`;
  if (!o.isBest) name += ` [${o.formatLabel}]`;
  return U.sanitizeFileName(name);
}

// twitch-dlp keeps "<file>-log.tsv" next to the output until a download fully finishes.
const isUnfinished = (dir, fileName) => fs.existsSync(path.join(dir, `${fileName}-log.tsv`));

/** Picks a file name that doesn't overwrite a finished file, but resumes an unfinished one. */
function chooseFileName(dir, base) {
  for (let i = 1; ; i++) {
    const name = i === 1 ? `${base}.mp4` : `${base} (${i}).mp4`;
    if (!fs.existsSync(path.join(dir, name)) || isUnfinished(dir, name)) return name;
  }
}

function sectionArg(o) {
  if (isWholeVod(o)) return null;
  const end = o.end == null || o.end >= o.duration ? 'inf' : U.formatClock(o.end);
  return `*${U.formatClock(o.start)}-${end}`;
}

function buildCommand(o, outputPath) {
  const args = [o.url, '-f', o.format];
  const section = sectionArg(o);
  if (section) args.push('--download-sections', section);
  args.push('-o', outputPath);
  return tools.twitchDlpCommand(args);
}

/** The command a download would run, for showing in the UI before starting. */
function previewCommand(o) {
  return buildCommand(o, path.join(o.dir, chooseFileName(o.dir, baseName(o))));
}

// ---------------------------------------------------------------- running

async function partFiles(job) {
  if (!job.fileName) return [];
  const entries = await fsp.readdir(job.dir).catch(() => []);
  return entries.filter((e) => e.startsWith(`${job.fileName}.part-`) || e.startsWith(`${job.fileName}-`));
}

async function runJob(job) {
  const internal = internals.get(job.id);
  job.status = 'preparing';
  job.message = tools.getState().status === 'ready' ? 'Starting…' : 'Waiting for setup to finish…';
  emit();
  await tools.whenReady();
  if (internal.cancelRequested) return finishCancelled(job);

  await fsp.mkdir(job.dir, { recursive: true });
  job.fileName = chooseFileName(job.dir, baseName(job));
  const outputPath = path.join(job.dir, job.fileName);
  if (isUnfinished(job.dir, job.fileName)) {
    // Resuming: remove a half-joined file from last time (ffmpeg won't overwrite it). Parts are kept.
    await fsp.rm(outputPath, { force: true });
  }

  job.command = buildCommand(job, outputPath);
  job.message = 'Contacting Twitch…';
  emit();
  addLog(job, `${job.dir}> ${job.command}`);

  let errorMessage = null;
  const child = U.spawnCommand(job.command, { cwd: job.dir, env: tools.commandEnv() });
  internal.child = child;

  const onLine = (line) => {
    const progress = line.match(PROGRESS_REGEX);
    if (progress) {
      const [, , size, speed, eta, done, total] = progress;
      job.status = 'downloading';
      job.progress = Number(total) ? Number(done) / Number(total) : 0;
      job.stats = { size, speed, eta, parts: `${done}/${total}` };
      job.message = '';
      if (Number(total) && done === total) {
        job.status = 'merging';
        job.progress = 0;
        job.message = 'Joining the parts into one video…';
      }
      return emit();
    }
    const time = line.match(FFMPEG_TIME_REGEX);
    if (time && job.status === 'merging') {
      const seconds = Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]);
      job.progress = Math.min(1, seconds / clipLength(job));
      return emit();
    }

    addLog(job, line);
    if (/^ERROR:/i.test(line)) errorMessage = line.replace(/^ERROR:\s*/i, '');
    else if (/might be private/i.test(line)) errorMessage = 'This VOD seems to be private, deleted, or sub-only.';
    else if (/merging failed/i.test(line)) errorMessage = 'Joining the video parts failed. See the output for details.';
    else if (/^npm (error|ERR!)/i.test(line) && !errorMessage) errorMessage = 'npx could not run twitch-dlp. See the output for details.';
    else if (/^(Input #0|ffmpeg version)/.test(line) && job.status !== 'merging') {
      Object.assign(job, { status: 'merging', progress: 0, message: 'Joining the parts into one video…' });
      emit();
    }
  };
  U.onLines(child.stdout, onLine);
  U.onLines(child.stderr, onLine);

  const exitCode = await new Promise((resolve) => {
    child.on('error', (err) => {
      errorMessage ??= err.message;
      resolve(-1);
    });
    child.on('close', (code) => resolve(code ?? -1));
  });
  internal.child = null;
  addLog(job, `Command finished with exit code ${exitCode}`);
  if (internal.cancelRequested) return finishCancelled(job);

  const output = await fsp.stat(outputPath).catch(() => null);
  if (errorMessage || !output?.size || isUnfinished(job.dir, job.fileName)) {
    Object.assign(job, {
      status: 'error',
      message: '',
      error: errorMessage || (exitCode ? `The command stopped with exit code ${exitCode}.` : 'The download did not finish. See the output for details.'),
      hasParts: (await partFiles(job)).length > 0,
    });
    return;
  }
  Object.assign(job, { status: 'done', progress: 1, message: '', outputPath, size: output.size, hasParts: false });
}

async function finishCancelled(job) {
  job.status = 'cancelled';
  job.hasParts = (await partFiles(job)).length > 0;
  job.message = job.hasParts ? 'Stopped. Start the same download again to continue where it left off.' : 'Stopped.';
}

async function pump() {
  if (running) return;
  const job = jobs.find((j) => j.status === 'queued');
  if (!job) return;
  running = true;
  try {
    await runJob(job);
  } catch (err) {
    U.log(`Download ${job.id} failed:`, err);
    Object.assign(job, { status: 'error', error: err.message, message: '' });
  } finally {
    running = false;
    job.finishedAt = Date.now();
    emit();
    events.emit('finished', job);
    setImmediate(pump);
  }
}

// ---------------------------------------------------------------- public API

function create(o) {
  const job = {
    id: String(nextId++),
    vodId: o.vodId,
    url: o.url,
    title: o.title,
    channel: o.channel,
    thumbnail: o.thumbnail,
    duration: o.duration,
    start: o.start,
    end: o.end,
    format: o.format,
    formatLabel: o.formatLabel,
    isBest: o.isBest,
    dir: o.dir,
    command: null,
    fileName: null,
    outputPath: null,
    size: null,
    status: 'queued',
    progress: 0,
    stats: null,
    message: '',
    error: null,
    hasParts: false,
    createdAt: Date.now(),
    finishedAt: null,
  };
  internals.set(job.id, { log: [], child: null, cancelRequested: false });
  jobs.push(job);
  emit();
  pump();
  return job;
}

async function cancel(id) {
  const job = find(id);
  if (!job || !isActive(job)) return;
  const internal = internals.get(id);
  if (job.status === 'queued') {
    Object.assign(job, { status: 'cancelled', message: 'Removed from the queue.' });
    return emit();
  }
  internal.cancelRequested = true;
  job.message = 'Stopping…';
  emit();
  if (internal.child) await U.killTree(internal.child.pid);
}

async function cancelAll() {
  await Promise.all(jobs.filter(isActive).map((j) => cancel(j.id)));
}

function retry(id) {
  const job = find(id);
  if (!job || isActive(job)) return;
  Object.assign(job, { status: 'queued', progress: 0, stats: null, message: '', error: null, hasParts: false, finishedAt: null });
  internals.get(id).cancelRequested = false;
  emit();
  pump();
}

function remove(id) {
  const index = jobs.findIndex((j) => j.id === id);
  if (index === -1 || isActive(jobs[index])) return;
  jobs.splice(index, 1);
  internals.delete(id);
  emit();
}

function clearFinished() {
  for (const job of [...jobs]) if (!isActive(job)) remove(job.id);
}

async function deleteParts(id) {
  const job = find(id);
  if (!job || isActive(job)) return;
  const unfinished = isUnfinished(job.dir, job.fileName);
  for (const file of await partFiles(job)) await fsp.rm(path.join(job.dir, file), { force: true }).catch(() => {});
  if (unfinished) await fsp.rm(path.join(job.dir, job.fileName), { force: true }).catch(() => {});
  job.hasParts = false;
  if (job.status === 'cancelled') job.message = 'Stopped. Partial files were deleted.';
  emit();
}

module.exports = {
  events,
  create,
  cancel,
  cancelAll,
  retry,
  remove,
  clearFinished,
  deleteParts,
  previewCommand,
  get: find,
  list: () => jobs,
  log: (id) => internals.get(id)?.log || [],
  hasActive: () => jobs.some(isActive),
};
