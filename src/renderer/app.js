'use strict';
const api = window.esmount;
const $ = (id) => document.getElementById(id);

const ui = {
  state: null,
  video: null,
  formats: null,
  format: null,
  loadingId: null,
  loadToken: 0,
  duration: 0,
  start: 0,
  end: 0,
  submitting: false,
  setupSlow: false,
  setupTimer: null,
  jobCards: new Map(),
  openLogs: new Set(),
  flashJobId: null,
  dirInitialized: false,
  previewKey: null,
};

// ---------------------------------------------------------------- helpers

const pad2 = (n) => String(n).padStart(2, '0');

function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 3600)}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

/** "1:23:45", "83:45", "5025", "1h23m45s", "90m" -> seconds (NaN if invalid, null if empty). */
function parseTime(text) {
  const value = String(text).trim().toLowerCase().replace(/\s+/g, '');
  if (!value) return null;
  const units = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (units && (units[1] || units[2] || units[3])) return (Number(units[1]) || 0) * 3600 + (Number(units[2]) || 0) * 60 + (Number(units[3]) || 0);
  if (/^\d+(:\d{1,2}){0,2}$/.test(value)) {
    const parts = value.split(':').map(Number);
    if (parts.slice(1).some((p) => p >= 60)) return NaN;
    return parts.reduce((total, part) => total * 60 + part, 0);
  }
  return NaN;
}

function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i >= 3 ? 2 : 0)} ${units[i]}`;
}

const prettySize = (text) => String(text || '').replace(/([\d.]+)\s*([KMGT]?B)/i, '$1 $2');

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function button(label, className, onClick, iconName) {
  const btn = el('button', `btn small ${className}`);
  btn.type = 'button';
  if (iconName) btn.append(icon(iconName));
  btn.append(label);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await onClick();
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

let toastTimer = null;
function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), 3000);
}

const VOD_REGEXES = [/(?:^|\/\/|\.)twitch\.tv\/(?:videos|[^/?#]+\/v(?:ideo)?)\/(\d+)/i, /player\.twitch\.tv\/\?.*?\bvideo=v?(\d+)/i, /^v?(\d{5,})$/];
const parseVodId = (text) => VOD_REGEXES.map((r) => String(text).trim().match(r)).find(Boolean)?.[1] || null;

// ---------------------------------------------------------------- step 1: VOD link

const URL_HINT = 'Paste a link to a Twitch VOD (past broadcast, highlight or upload).';

function setUrlHint(text, isError = false) {
  const hint = $('url-hint');
  hint.textContent = text;
  hint.hidden = !text;
  hint.classList.toggle('error', isError);
  $('url').classList.toggle('invalid', isError);
}

function resetVideo() {
  ui.loadToken++;
  Object.assign(ui, { video: null, formats: null, format: null, loadingId: null, duration: 0, start: 0, end: 0 });
  $('video-card').hidden = true;
  $('video-skeleton').hidden = true;
  $('live-choice').hidden = true;
  renderQualitiesMessage('Paste a link to see the available qualities.');
  $('range-summary').textContent = '';
  updateForm();
}

function onUrlChanged() {
  const text = $('url').value.trim();
  if (!text) {
    resetVideo();
    return setUrlHint(URL_HINT);
  }
  const id = parseVodId(text);
  if (!id) {
    resetVideo();
    return setUrlHint('That doesn’t look like a Twitch VOD link. It should look like https://www.twitch.tv/videos/123456789', true);
  }
  if (id === ui.loadingId) return;
  loadVideo(text, id);
}

async function loadVideo(url, id) {
  const token = ++ui.loadToken;
  Object.assign(ui, { video: null, formats: null, format: null, loadingId: id });
  document.querySelector('input[name="live-mode"][value="stop"]').checked = true;
  $('video-card').hidden = true;
  $('live-choice').hidden = true;
  $('video-skeleton').hidden = false;
  setUrlHint('Looking up the VOD…');
  renderQualitiesLoading();
  updateForm();

  const videoRequest = api.getVideo(url);
  const formatsRequest = api.getFormats(url);
  formatsRequest.catch(() => {});

  try {
    const video = await videoRequest;
    if (token !== ui.loadToken) return;
    ui.video = video;
    renderVideo(video);
    setUrlHint('');
    setDuration(video.duration, video.start);
  } catch (err) {
    if (token !== ui.loadToken) return;
    ui.loadingId = null;
    $('video-skeleton').hidden = true;
    setUrlHint(err.message, true);
    renderQualitiesMessage('Paste a link to see the available qualities.');
    return updateForm();
  }

  try {
    const formats = await formatsRequest;
    if (token !== ui.loadToken) return;
    ui.formats = formats;
    renderQualities();
  } catch (err) {
    if (token !== ui.loadToken) return;
    renderQualitiesMessage(err.message, true, () => loadVideo(url, id));
  }
  updateForm();
}

function renderVideo(video) {
  $('video-skeleton').hidden = true;
  $('video-card').hidden = false;
  const thumb = $('video-thumb');
  thumb.hidden = !video.thumbnail;
  if (video.thumbnail) thumb.src = video.thumbnail;
  $('video-live').hidden = !video.isLive;
  $('video-length').textContent = clock(video.duration);
  $('video-title').textContent = video.title;
  const date = video.createdAt ? new Date(video.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  $('video-sub').textContent = [video.channel, video.game, date].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------- step 2: time range

function setDuration(duration, start) {
  ui.duration = duration;
  for (const id of ['range-start', 'range-end']) $(id).max = String(duration);
  $('scale-end').textContent = clock(duration);
  setRange(start && start < duration ? start : 0, duration);
}

function setRange(start, end) {
  ui.start = start;
  ui.end = end;
  $('range-start').value = String(start);
  $('range-end').value = String(end);
  for (const [id, value] of [['start', start], ['end', end]]) {
    if (document.activeElement !== $(id)) {
      $(id).value = clock(value);
      $(id).classList.remove('invalid');
    }
  }
  const pct = (v) => (ui.duration ? (v / ui.duration) * 100 : 0);
  $('range-fill').style.left = `${pct(start)}%`;
  $('range-fill').style.right = `${100 - pct(end)}%`;
  updateLiveChoice();
  renderSummary();
  updateForm();
}

// ---------------------------------------------------------------- still-live broadcasts

/** The end is "as far as it goes", so a live broadcast leaves a choice to make. */
const endIsAtMax = () => ui.end >= ui.duration;
const isLiveChoice = () => Boolean(ui.video?.isLive) && endIsAtMax();
const followLive = () => isLiveChoice() && document.querySelector('input[name="live-mode"]:checked')?.value === 'follow';

function updateLiveChoice() {
  $('live-choice').hidden = !isLiveChoice();
  $('live-stop-time').textContent = clock(ui.duration);
}

/** A live VOD keeps growing, so refresh its length while it is on screen. */
async function refreshLiveVideo() {
  if (!ui.video?.isLive || ui.submitting) return;
  const token = ui.loadToken;
  const video = await api.getVideo(ui.video.url).catch(() => null);
  if (!video || token !== ui.loadToken || !ui.video) return;
  ui.video = { ...video, start: ui.video.start };
  renderVideo(ui.video);
  if (video.duration === ui.duration) return;
  const keepEndAtMax = endIsAtMax();
  ui.duration = video.duration;
  for (const id of ['range-start', 'range-end']) $(id).max = String(video.duration);
  $('scale-end').textContent = clock(video.duration);
  setRange(ui.start, keepEndAtMax ? video.duration : Math.min(ui.end, video.duration));
}

/** Applies a typed time. Returns false if it is not usable. */
function applyTypedTime(which, { final }) {
  const input = $(which);
  let value = parseTime(input.value);
  if (value === null && which === 'end') value = ui.duration;
  if (value === null && which === 'start') value = 0;
  const valid =
    Number.isFinite(value) && value >= 0 && value <= ui.duration && (which === 'start' ? value < ui.end : value > ui.start);
  if (valid) {
    if (which === 'start') setRange(value, ui.end);
    else setRange(ui.start, value);
    if (final) input.value = clock(value);
  }
  input.classList.toggle('invalid', final && !valid);
  if (final && !valid) {
    $('range-summary').textContent =
      which === 'start' ? `The start must be a time before ${clock(ui.end)}.` : `The end must be after ${clock(ui.start)} and no later than ${clock(ui.duration)}.`;
  }
  updateForm();
  return valid;
}

function renderSummary() {
  if (!ui.video) return ($('range-summary').textContent = '');
  if (followLive()) {
    $('range-summary').textContent =
      ui.start === 0
        ? 'Whole VOD, and it keeps recording while the stream is live'
        : `From ${clock(ui.start)}, and it keeps recording while the stream is live`;
    return;
  }
  const length = ui.end - ui.start;
  const whole = ui.start === 0 && endIsAtMax();
  const soFar = whole && ui.video.isLive;
  let text = whole ? `${soFar ? 'Whole VOD so far' : 'Whole VOD'} · ${clock(length)}` : `${clock(ui.start)} → ${clock(ui.end)} · ${clock(length)} long`;
  const format = selectedFormat();
  if (format?.kbps) text += ` · about ${formatBytes(((format.kbps * 1024) / 8) * length)}`;
  $('range-summary').textContent = text;
}

// ---------------------------------------------------------------- step 3: quality

const selectedFormat = () => ui.formats?.find((f) => f.id === ui.format) || null;

function renderQualitiesMessage(text, isError = false, retry = null) {
  const box = $('qualities');
  const message = el('p', `placeholder${isError ? ' error' : ''}`, text);
  if (retry) {
    const again = el('button', 'link-btn', 'Try again');
    again.type = 'button';
    again.addEventListener('click', retry);
    message.append(' ', again);
  }
  box.replaceChildren(message);
}

function renderQualitiesLoading() {
  const box = $('qualities');
  box.replaceChildren();
  for (let i = 0; i < 4; i++) box.append(el('div', 'quality skeleton-chip shimmer'));
  if (ui.state && ui.state.tools.status !== 'ready') {
    box.append(el('p', 'placeholder', 'Loading qualities… (waiting for the downloader tools to finish setting up)'));
  }
}

function renderQualities() {
  const preferred = ui.format || ui.state?.settings.quality;
  const chosen = ui.formats.find((f) => f.id === preferred) || ui.formats[0];
  ui.format = chosen.id;

  const box = $('qualities');
  box.replaceChildren();
  for (const format of ui.formats) {
    const label = el('label', 'quality');
    const input = el('input');
    input.type = 'radio';
    input.name = 'quality';
    input.value = format.id;
    input.checked = format.id === chosen.id;
    input.addEventListener('change', () => {
      ui.format = format.id;
      renderSummary();
      updateForm();
    });
    const name = el('span', 'q-name', format.label);
    if (format.source) name.append(el('span', 'q-tag', 'Source'));
    const details = format.audioOnly ? 'No video' : [format.resolution?.replace('x', '×'), format.fps ? `${format.fps} fps` : null].filter(Boolean).join(' · ');
    label.append(input, name, el('span', 'q-detail', details || ' '));
    box.append(label);
  }
  renderSummary();
}

// ---------------------------------------------------------------- step 4 + submit

function formOptions() {
  return {
    url: $('url').value.trim(),
    start: ui.start,
    end: endIsAtMax() ? null : ui.end,
    format: ui.format,
    dir: $('dir').value.trim(),
    followLive: followLive(),
  };
}

const formReady = () =>
  Boolean(ui.video && ui.formats && ui.format && ui.end > ui.start && $('dir').value.trim()) &&
  !$('start').classList.contains('invalid') &&
  !$('end').classList.contains('invalid');

function updateForm() {
  $('range-step').disabled = !ui.video;
  $('quality-step').disabled = !ui.formats;
  $('submit').disabled = !formReady() || ui.submitting;
  const busy = ui.state?.jobs.some((j) => ['queued', 'preparing', 'downloading', 'merging'].includes(j.status));
  $('submit-text').textContent = busy ? 'Add to queue' : 'Download';

  // Refresh the command preview when the inputs change (or a download finishes, which can change the file name).
  const finished = ui.state?.jobs.filter((j) => j.status === 'done').length || 0;
  const key = formReady() ? JSON.stringify([formOptions(), finished]) : '';
  if (key !== ui.previewKey) {
    ui.previewKey = key;
    schedulePreview();
  }
}

let previewToken = 0;
const schedulePreview = debounce(async () => {
  const token = ++previewToken;
  if (!formReady()) return ($('command-preview').hidden = true);
  try {
    const command = await api.previewCommand(formOptions());
    if (token !== previewToken) return;
    $('command-text').textContent = command;
    $('command-preview').hidden = false;
  } catch {
    if (token === previewToken) $('command-preview').hidden = true;
  }
}, 200);

function showFormError(message) {
  $('form-error').textContent = message;
  $('form-error').hidden = !message;
}

async function submit(event) {
  event.preventDefault();
  if (!formReady() || ui.submitting) return;
  ui.submitting = true;
  showFormError('');
  updateForm();
  const queued = ui.state?.jobs.some((j) => ['queued', 'preparing', 'downloading', 'merging'].includes(j.status));
  try {
    const job = await api.startDownload(formOptions());
    ui.flashJobId = job.id;
    toast(queued ? 'Added to the queue' : 'Download started');
  } catch (err) {
    showFormError(err.message);
  } finally {
    ui.submitting = false;
    updateForm();
  }
}

// ---------------------------------------------------------------- status & setup

function renderStatus(state) {
  const pill = $('status-pill');
  const active = state.jobs.filter((j) => ['preparing', 'downloading', 'merging'].includes(j.status)).length;
  const queued = state.jobs.filter((j) => j.status === 'queued').length;
  let mode = 'ready';
  let text = 'Ready';
  if (state.tools.status === 'error') [mode, text] = ['error', 'Setup problem'];
  else if (active) [mode, text] = ['busy', queued ? `Downloading · ${queued} in queue` : 'Downloading'];
  else if (state.tools.status !== 'ready') [mode, text] = ['working', 'Setting up…'];
  pill.dataset.state = mode;
  $('status-text').textContent = text;
}

const STEP_ICONS = { done: 'check', error: 'x' };

function renderSetup(tools) {
  if (tools.status === 'working' && !ui.setupTimer) {
    ui.setupTimer = setTimeout(() => {
      ui.setupSlow = true;
      if (ui.state) renderSetup(ui.state.tools);
    }, 2500);
  }
  const downloading = Object.values(tools.steps).some((s) => s.progress !== null);
  $('setup-card').hidden = !(tools.status === 'error' || (tools.status === 'working' && (ui.setupSlow || downloading)));

  const list = $('setup-steps');
  list.replaceChildren();
  for (const step of Object.values(tools.steps)) {
    const item = el('li', 'setup-step');
    item.dataset.status = step.status;
    const iconBox = el('span', 's-icon');
    if (step.status === 'working') iconBox.append(el('span', 'spinner'));
    else if (STEP_ICONS[step.status]) iconBox.append(icon(STEP_ICONS[step.status]));
    const text = el('div', 's-text');
    text.append(el('span', 's-label', step.label), el('span', 's-detail', step.detail));
    item.append(iconBox, text);
    if (step.progress !== null && step.status === 'working') {
      const bar = el('div', 'progress');
      const fill = el('div', 'bar');
      fill.style.width = `${Math.round(step.progress * 100)}%`;
      bar.append(fill);
      item.append(bar);
    }
    list.append(item);
  }
  $('setup-error').hidden = tools.status !== 'error';
  $('setup-error-text').textContent = tools.error || '';
  $('setup-subtitle').textContent =
    tools.status === 'error' ? 'Something went wrong while getting the downloader ready.' : 'Getting the tools the downloader needs. This only takes long the first time.';
}

// ---------------------------------------------------------------- downloads list

const ACTIVE = ['queued', 'preparing', 'downloading', 'merging'];
const STATUS_LABELS = {
  queued: ['In queue', null],
  preparing: ['Starting', null],
  downloading: ['Downloading', null],
  merging: ['Joining', null],
  done: ['Done', 'check'],
  error: ['Failed', 'alert'],
  cancelled: ['Stopped', null],
};

function createJobCard(job) {
  const card = el('article', 'job');
  card.dataset.id = job.id;

  const thumb = el('div', 'thumb');
  const img = el('img');
  img.alt = '';
  thumb.append(img);

  const body = el('div', 'job-body');
  const top = el('div', 'job-top');
  const title = el('div', 'job-title');
  const chip = el('span', 'chip');
  top.append(title, chip);
  const sub = el('div', 'job-sub');
  const progress = el('div', 'progress');
  const bar = el('div', 'bar');
  progress.append(bar);
  const stats = el('div', 'job-stats');
  const statsLeft = el('span');
  const statsRight = el('span');
  stats.append(statsLeft, statsRight);
  const message = el('div', 'job-message');
  const actions = el('div', 'job-actions');

  const details = el('details', 'job-log');
  const summary = el('summary', null, 'Command & output');
  const command = el('div', 'command');
  const commandHead = el('div', 'command-head');
  const commandLabel = el('span');
  commandLabel.append(icon('terminal'), 'Command');
  const copy = el('button', 'link-btn', 'Copy');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    const current = ui.state.jobs.find((j) => j.id === job.id);
    if (!current?.command) return;
    await api.copyText(current.command);
    toast('Command copied');
  });
  commandHead.append(commandLabel, copy);
  const code = el('code');
  command.append(commandHead, code);
  const output = el('pre');
  details.append(summary, command, output);
  details.addEventListener('toggle', async () => {
    if (!details.open) return ui.openLogs.delete(job.id);
    ui.openLogs.add(job.id);
    const lines = await api.getDownloadLog(job.id).catch(() => []);
    output.textContent = lines.length ? `${lines.join('\n')}\n` : 'No output yet.\n';
    output.scrollTop = output.scrollHeight;
  });

  body.append(top, sub, progress, stats, message, actions, details);
  card.append(thumb, body);
  card.refs = { img, title, chip, sub, progress, bar, stats, statsLeft, statsRight, message, actions, code, output, actionsKey: '' };
  return card;
}

function jobActions(job) {
  const buttons = [];
  if (ACTIVE.includes(job.status)) {
    if (job.status === 'queued') return [button('Remove from queue', 'danger', () => api.cancelDownload(job.id), 'x')];
    // A live recording has no natural end, so stopping it has to save the video too.
    if (job.followLive && job.status !== 'merging') {
      buttons.push(button('Stop & save', 'secondary', () => api.stopAndSaveDownload(job.id), 'check'));
    }
    buttons.push(button('Stop', 'danger', () => api.cancelDownload(job.id), 'x'));
    return buttons;
  }
  if (job.status === 'done') buttons.push(button('Show in folder', 'secondary', () => api.showDownload(job.id), 'folder'));
  if (job.status === 'error') buttons.push(button('Try again', 'secondary', () => api.retryDownload(job.id), 'refresh'));
  if (job.status === 'cancelled') buttons.push(button(job.hasParts ? 'Resume' : 'Start again', 'secondary', () => api.retryDownload(job.id), 'refresh'));
  if (job.hasParts) {
    buttons.push(button('Save what was downloaded', 'secondary', () => api.saveDownloadedParts(job.id), 'check'));
    buttons.push(button('Delete partial files', 'danger', () => api.deleteParts(job.id), 'trash'));
  }
  buttons.push(button('Remove', 'secondary', () => api.removeDownload(job.id)));
  return buttons;
}

function updateJobCard(card, job) {
  const r = card.refs;
  if (job.thumbnail && r.img.getAttribute('src') !== job.thumbnail) r.img.src = job.thumbnail;
  r.img.hidden = !job.thumbnail;
  r.title.textContent = job.title;
  r.title.title = job.title;

  const whole = job.start === 0 && job.end === null;
  const range = job.followLive
    ? `${job.start === 0 ? 'Whole VOD' : clock(job.start)} → while live`
    : whole
      ? 'Whole VOD'
      : `${clock(job.start)} → ${job.end === null ? clock(job.duration) : clock(job.end)}`;
  r.sub.textContent = [job.channel, range, job.formatLabel].join(' · ');

  const recording = job.followLive && ['downloading', 'preparing'].includes(job.status);
  const [label, iconName] = recording ? ['Recording live', null] : STATUS_LABELS[job.status] || [job.status, null];
  r.chip.dataset.status = recording ? 'live' : job.status;
  r.chip.replaceChildren(...(recording ? [el('span', 'live-dot')] : iconName ? [icon(iconName)] : []), label);

  const showBar = ['preparing', 'downloading', 'merging', 'done'].includes(job.status);
  r.progress.hidden = !showBar;
  r.progress.classList.toggle('indeterminate', job.status === 'preparing' || recording || (job.status === 'merging' && !job.progress));
  r.progress.classList.toggle('done', job.status === 'done');
  r.bar.style.width = `${Math.round((job.status === 'done' ? 1 : job.progress) * 100)}%`;

  let left = '';
  let right = '';
  if (recording && job.stats) {
    left = `${job.stats.parts.split('/')[0]} parts · ~${prettySize(job.stats.size)}`;
    right = prettySize(job.stats.speed);
  } else if (job.status === 'downloading' && job.stats) {
    left = `${Math.floor(job.progress * 100)}% · of ~${prettySize(job.stats.size)}`;
    right = `${prettySize(job.stats.speed)} · ${job.stats.eta} left`;
  } else if (job.status === 'merging') {
    left = job.progress ? `${Math.floor(job.progress * 100)}%` : '';
  } else if (job.status === 'done') {
    left = `Saved · ${formatBytes(job.size)}`;
  }
  r.statsLeft.textContent = left;
  r.statsRight.textContent = right;
  r.stats.hidden = !left && !right;

  const text =
    job.status === 'error'
      ? job.error
      : job.status === 'done'
        ? `${job.savedEarly ? 'Saved what was downloaded · ' : ''}${job.fileName}`
        : job.message;
  r.message.textContent = text || '';
  r.message.hidden = !text;
  r.message.className = `job-message${job.status === 'error' ? ' error' : job.status === 'done' ? ' success' : ''}`;

  const key = `${job.status}|${job.hasParts}|${job.followLive}`;
  if (r.actionsKey !== key) {
    r.actionsKey = key;
    r.actions.replaceChildren(...jobActions(job));
  }
  r.code.textContent = job.command || 'The command appears here when the download starts.';
}

function renderJobs(jobs) {
  const list = $('jobs');
  $('jobs-empty').hidden = jobs.length > 0;
  $('jobs-count').hidden = jobs.length === 0;
  $('jobs-count').textContent = String(jobs.length);
  $('clear-finished').hidden = !jobs.some((j) => !ACTIVE.includes(j.status));

  const ordered = [...jobs].reverse();
  const seen = new Set();
  ordered.forEach((job, index) => {
    seen.add(job.id);
    let card = ui.jobCards.get(job.id);
    if (!card) {
      card = createJobCard(job);
      ui.jobCards.set(job.id, card);
    }
    updateJobCard(card, job);
    if (list.children[index] !== card) list.insertBefore(card, list.children[index] || null);
    if (ui.flashJobId === job.id) {
      ui.flashJobId = null;
      card.classList.add('flash');
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  });
  for (const [id, card] of ui.jobCards) {
    if (!seen.has(id)) {
      card.remove();
      ui.jobCards.delete(id);
      ui.openLogs.delete(id);
    }
  }
}

function appendLog({ jobId, line }) {
  if (!ui.openLogs.has(jobId)) return;
  const output = ui.jobCards.get(jobId)?.refs.output;
  if (!output) return;
  const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 30;
  if (output.textContent === 'No output yet.\n') output.textContent = '';
  output.textContent += `${line}\n`;
  if (atBottom) output.scrollTop = output.scrollHeight;
}

// ---------------------------------------------------------------- updates

function renderUpdate(update, version) {
  const dialog = $('update-dialog');
  const busy = update.status === 'downloading' || update.status === 'ready';
  const wanted = (update.status === 'available' && !update.dismissed) || busy;
  if (wanted && !dialog.open) dialog.showModal();
  if (!wanted && dialog.open) dialog.close();

  if (update.status === 'downloading') $('update-text').textContent = `Downloading version ${update.version}… ${Math.round(update.progress * 100)}%`;
  else if (update.status === 'ready') $('update-text').textContent = 'Installing the update. The app will restart in a moment…';
  else $('update-text').textContent = `Version ${update.version} is ready to install (you have ${version}). Update now?`;

  $('update-changes').replaceChildren(...update.notes.map((line) => el('li', null, line)));
  $('update-progress').hidden = !busy;
  $('update-progress').firstElementChild.style.width = `${Math.round(update.progress * 100)}%`;
  $('update-error').hidden = !update.error || busy;
  $('update-error').textContent = update.error || '';
  $('update-now').disabled = busy;
  $('update-later').disabled = busy;
  $('update-now').replaceChildren(...(busy ? [el('span', 'spinner'), 'Updating…'] : [icon('download'), 'Update now']));

  const footer = $('footer-update');
  const link = (text, onClick) => {
    const btn = el('button', 'link-btn', text);
    btn.type = 'button';
    btn.addEventListener('click', onClick);
    return btn;
  };
  const check = () => api.checkForUpdates();
  switch (update.status) {
    case 'dev':
      footer.replaceChildren('Development build (updates are off)');
      break;
    case 'checking':
      footer.replaceChildren('Checking for updates…');
      break;
    case 'none':
      footer.replaceChildren('Up to date · ', link('Check again', check));
      break;
    case 'available':
      footer.replaceChildren(`Version ${update.version} available · `, link('Update now', () => api.installUpdate().catch((err) => toast(err.message))));
      break;
    case 'downloading':
    case 'ready':
      footer.replaceChildren('Updating…');
      break;
    case 'error':
      footer.replaceChildren(`${update.error} · `, link('Try again', check));
      break;
    default:
      footer.replaceChildren(link('Check for updates', check));
  }
}

// ---------------------------------------------------------------- state

function applyState(state) {
  const first = !ui.state;
  ui.state = state;
  if (!ui.dirInitialized && state.settings.downloadDir) {
    ui.dirInitialized = true;
    if (!$('dir').value) $('dir').value = state.settings.downloadDir;
  }
  if (first && ui.loadingId && !ui.formats) renderQualitiesLoading();

  renderStatus(state);
  renderSetup(state.tools);
  renderJobs(state.jobs);
  renderUpdate(state.update, state.version);
  $('footer-version').textContent = `v${state.version}`;
  const twitchDlp = state.tools.steps.twitchDlp;
  $('footer-tools').textContent = twitchDlp.status === 'done' ? `twitch-dlp ${twitchDlp.detail}` : 'twitch-dlp';
  updateForm();
}

// ---------------------------------------------------------------- wiring

function init() {
  setUrlHint(URL_HINT);

  const url = $('url');
  url.addEventListener('input', debounce(onUrlChanged, 350));
  url.addEventListener('paste', () => setTimeout(onUrlChanged, 0));
  url.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), onUrlChanged()));

  // Ctrl+V anywhere in the window pastes a VOD link into the link box.
  document.addEventListener('paste', (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const text = e.clipboardData?.getData('text') || '';
    if (!parseVodId(text)) return;
    url.value = text.trim();
    onUrlChanged();
  });

  $('range-start').addEventListener('input', () => {
    const value = Math.min(Number($('range-start').value), ui.end - 1);
    setRange(Math.max(0, value), ui.end);
  });
  $('range-end').addEventListener('input', () => {
    const value = Math.max(Number($('range-end').value), ui.start + 1);
    setRange(ui.start, Math.min(ui.duration, value));
  });
  for (const id of ['start', 'end']) {
    $(id).addEventListener('input', () => applyTypedTime(id, { final: false }));
    $(id).addEventListener('blur', () => applyTypedTime(id, { final: true }));
    $(id).addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), $(id).blur()));
  }
  $('whole-vod').addEventListener('click', () => setRange(0, ui.duration));
  for (const radio of document.querySelectorAll('input[name="live-mode"]')) {
    radio.addEventListener('change', () => {
      renderSummary();
      updateForm();
    });
  }
  setInterval(refreshLiveVideo, 45000);

  $('browse').addEventListener('click', async () => {
    const dir = await api.pickFolder($('dir').value.trim()).catch((err) => toast(err.message));
    if (!dir) return;
    $('dir').value = dir;
    api.saveSettings({ downloadDir: dir });
    updateForm();
  });
  $('open-dir').addEventListener('click', () => api.openFolder($('dir').value.trim()).catch((err) => toast(err.message)));
  $('dir').addEventListener('input', debounce(updateForm, 250));
  $('dir').addEventListener('change', () => $('dir').value.trim() && api.saveSettings({ downloadDir: $('dir').value.trim() }));

  $('copy-command').addEventListener('click', async () => {
    await api.copyText($('command-text').textContent);
    toast('Command copied');
  });
  $('download-form').addEventListener('submit', submit);
  $('clear-finished').addEventListener('click', () => api.clearFinished());
  $('setup-retry').addEventListener('click', () => api.retrySetup());

  $('update-now').addEventListener('click', () =>
    api.installUpdate().catch((err) => {
      $('update-error').textContent = err.message;
      $('update-error').hidden = false;
    }),
  );
  const later = () => {
    api.dismissUpdate();
    $('update-dialog').close();
  };
  $('update-later').addEventListener('click', later);
  $('update-dialog').addEventListener('cancel', (e) => {
    e.preventDefault();
    if (!$('update-later').disabled) later();
  });

  api.onState(applyState);
  api.onLog(appendLog);
  api.getState().then(applyState);
  url.focus();
}

init();
