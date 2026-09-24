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
// Anything smaller than this holds no video, however short the clip is.
const MIN_VIDEO_BYTES = 16 * 1024;
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

// end === null means "no end": the rest of the VOD, and for a live one everything it keeps recording.
const isWholeVod = (o) => o.start <= 0 && o.end == null;
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
  return `*${U.formatClock(o.start)}-${o.end == null ? 'inf' : U.formatClock(o.end)}`;
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

/** The leftovers twitch-dlp keeps next to the output: parts, playlist, log, ffconcat list. */
async function partFiles(job) {
  if (!job.fileName) return [];
  const entries = await fsp.readdir(job.dir).catch(() => []);
  return entries.filter((e) => e.startsWith(`${job.fileName}.part-`) || e.startsWith(`${job.fileName}-`));
}

async function removePartFiles(job) {
  for (const file of await partFiles(job)) await fsp.rm(path.join(job.dir, file), { force: true }).catch(() => {});
}

/** Runs a twitch-dlp command line, feeding its output to the UI. Returns the exit code. */
async function runCommand(job, command, onLine) {
  const internal = internals.get(job.id);
  job.command = command;
  emit();
  addLog(job, `${job.dir}> ${command}`);
  const child = U.spawnCommand(command, { cwd: job.dir, env: tools.commandEnv() });
  internal.child = child;
  U.onLines(child.stdout, onLine);
  U.onLines(child.stderr, onLine);
  const exitCode = await new Promise((resolve) => {
    child.on('error', (err) => {
      onLine(`ERROR: ${err.message}`);
      resolve(-1);
    });
    child.on('close', (code) => resolve(code ?? -1));
  });
  internal.child = null;
  addLog(job, `Command finished with exit code ${exitCode}`);
  return exitCode;
}

/** Recognises the problems twitch-dlp and npx report, so the user gets a plain message. */
function readErrorLine(line) {
  if (/^ERROR:/i.test(line)) return line.replace(/^ERROR:\s*/i, '');
  if (/might be private/i.test(line)) return 'This VOD seems to be private, deleted, or sub-only.';
  if (/merging failed/i.test(line)) return 'Joining the video parts failed. See the output for details.';
  if (/^npm (error|ERR!)/i.test(line)) return 'npx could not run twitch-dlp. See the output for details.';
  return null;
}

async function runJob(job) {
  const internal = internals.get(job.id);
  job.status = 'preparing';
  job.message = tools.getState().status === 'ready' ? 'Starting…' : 'Waiting for setup to finish…';
  emit();
  await tools.whenReady();
  if (internal.cancelRequested) return finishCancelled(job);

  await fsp.mkdir(job.dir, { recursive: true });
  job.fileName ||= chooseFileName(job.dir, baseName(job));
  const outputPath = path.join(job.dir, job.fileName);
  if (isUnfinished(job.dir, job.fileName)) {
    // Resuming: remove a half-joined file from last time (ffmpeg won't overwrite it). Parts are kept.
    await fsp.rm(outputPath, { force: true });
  }
  if (internal.saveOnly) return saveDownloadedParts(job, outputPath);

  job.message = 'Contacting Twitch…';
  let errorMessage = null;

  const onLine = (line) => {
    const progress = line.match(PROGRESS_REGEX);
    if (progress) {
      const [, , size, speed, eta, done, total] = progress;
      job.status = 'downloading';
      job.progress = Number(total) ? Number(done) / Number(total) : 0;
      job.stats = { size, speed, eta, parts: `${done}/${total}` };
      job.message = '';
      if (Number(total) && done === total && !job.followLive) {
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
    errorMessage = readErrorLine(line) || errorMessage;
    if (/VOD ONLINE|waiting for new fragments/i.test(line)) {
      // Everything streamed so far has been downloaded.
      if (job.stopAtLiveEdge && !internal.saveRequested) {
        addLog(job, 'Caught up with the live broadcast - saving the video.');
        cancel(job.id, { save: true });
      } else {
        job.message = 'Waiting for the stream to go on…';
      }
      emit();
    } else if (/^(Input #0|ffmpeg version)/.test(line) && job.status !== 'merging') {
      Object.assign(job, { status: 'merging', progress: 0, message: 'Joining the parts into one video…' });
      emit();
    }
  };

  const exitCode = await runCommand(job, buildCommand(job, outputPath), onLine);

  if (internal.saveRequested) return saveDownloadedParts(job, outputPath);
  if (internal.cancelRequested) return finishCancelled(job);

  const output = await fsp.stat(outputPath).catch(() => null);
  const empty = output && output.size < MIN_VIDEO_BYTES;
  if (empty) await fsp.rm(outputPath, { force: true }).catch(() => {});
  if (errorMessage || !output?.size || empty || isUnfinished(job.dir, job.fileName)) {
    Object.assign(job, {
      status: 'error',
      message: '',
      error:
        errorMessage ||
        (empty
          ? 'Nothing was downloaded for that part of the VOD. Try again, or pick a slightly earlier end time.'
          : exitCode
            ? `The command stopped with exit code ${exitCode}.`
            : 'The download did not finish. See the output for details.'),
      hasParts: (await partFiles(job)).length > 0,
    });
    return;
  }
  Object.assign(job, { status: 'done', progress: 1, message: '', outputPath, size: output.size, hasParts: false });
}

/**
 * Joins the parts downloaded so far into a playable video, without downloading more.
 * Used when a live recording is stopped, or to rescue an interrupted download.
 */
async function saveDownloadedParts(job, outputPath) {
  const internal = internals.get(job.id);
  internal.saveRequested = false;
  internal.saveOnly = false;
  Object.assign(job, {
    status: 'merging',
    progress: 0,
    stats: null,
    error: null,
    message: job.stopAtLiveEdge ? 'Joining the parts into one video…' : 'Saving what has been downloaded…',
  });
  emit();

  if ((await partFiles(job)).every((file) => !file.includes('.part-Frag'))) {
    Object.assign(job, { status: 'error', message: '', error: 'There are no downloaded parts to save.', hasParts: false });
    return;
  }
  await fsp.rm(outputPath, { force: true }); // ffmpeg refuses to overwrite

  let errorMessage = null;
  const onLine = (line) => {
    if (FFMPEG_TIME_REGEX.test(line)) return;
    addLog(job, line);
    errorMessage = readErrorLine(line) || errorMessage;
  };
  const exitCode = await runCommand(job, tools.twitchDlpCommand([outputPath, '--merge-fragments']), onLine);

  const output = await fsp.stat(outputPath).catch(() => null);
  if (errorMessage || !output?.size || output.size < MIN_VIDEO_BYTES) {
    Object.assign(job, {
      status: 'error',
      message: '',
      error: errorMessage || `Saving the downloaded parts failed (exit code ${exitCode}).`,
      hasParts: (await partFiles(job)).length > 0,
    });
    return;
  }
  // --merge-fragments keeps the parts, so clean them up now that the video is saved.
  await removePartFiles(job);
  Object.assign(job, {
    status: 'done',
    progress: 1,
    message: '',
    outputPath,
    size: output.size,
    hasParts: false,
    savedEarly: !job.stopAtLiveEdge,
  });
}

async function finishCancelled(job) {
  job.status = 'cancelled';
  job.hasParts = (await partFiles(job)).some((file) => file.includes('.part-Frag'));
  job.message = job.hasParts
    ? 'Stopped. Save what was downloaded, or start it again to continue where it left off.'
    : 'Stopped.';
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
    isLive: Boolean(o.isLive),
    followLive: Boolean(o.followLive),
    stopAtLiveEdge: Boolean(o.stopAtLiveEdge),
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
    savedEarly: false,
    createdAt: Date.now(),
    finishedAt: null,
  };
  internals.set(job.id, { log: [], child: null, cancelRequested: false, saveRequested: false, saveOnly: false });
  jobs.push(job);
  emit();
  pump();
  return job;
}

/** Stops a running download. With { save: true } the parts downloaded so far become a video. */
async function cancel(id, { save = false } = {}) {
  const job = find(id);
  if (!job || !isActive(job)) return;
  const internal = internals.get(id);
  if (job.status === 'queued') {
    Object.assign(job, { status: 'cancelled', message: 'Removed from the queue.' });
    return emit();
  }
  if (save) internal.saveRequested = true;
  else internal.cancelRequested = true;
  job.message = save ? 'Stopping and saving…' : 'Stopping…';
  emit();
  if (internal.child) await U.killTree(internal.child.pid);
}

/** Joins the parts of a stopped or failed download into a playable video. */
function saveParts(id) {
  const job = find(id);
  if (!job || isActive(job) || !job.hasParts) return;
  internals.get(id).saveOnly = true;
  internals.get(id).cancelRequested = false;
  Object.assign(job, { status: 'queued', progress: 0, stats: null, error: null, message: 'Waiting to save…', finishedAt: null });
  emit();
  pump();
}

async function cancelAll() {
  await Promise.all(jobs.filter(isActive).map((j) => cancel(j.id)));
}

function retry(id) {
  const job = find(id);
  if (!job || isActive(job)) return;
  Object.assign(job, { status: 'queued', progress: 0, stats: null, message: '', error: null, hasParts: false, savedEarly: false, finishedAt: null });
  Object.assign(internals.get(id), { cancelRequested: false, saveRequested: false, saveOnly: false });
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
  await removePartFiles(job);
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
  saveParts,
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
