'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');
const P = require('./paths');

fs.mkdirSync(P.LOGS, { recursive: true });
const LOG_FILE = path.join(P.LOGS, 'app.log');
try {
  if (fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, `${LOG_FILE}.old`);
} catch {}

const USER_AGENT = 'Esmount-VOD-Downloader';

function log(...parts) {
  const text = parts
    .map((p) => (p instanceof Error ? p.stack || p.message : typeof p === 'string' ? p : JSON.stringify(p)))
    .join(' ');
  const line = `[${new Date().toISOString()}] ${text}`;
  try {
    fs.appendFileSync(LOG_FILE, `${line}\n`);
  } catch {}
  console.log(line);
}

const ANSI_REGEX = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const stripAnsi = (s) => s.replace(ANSI_REGEX, '');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}

function collect(child, timeout) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = timeout ? setTimeout(() => killTree(child.pid), timeout) : null;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/** Runs a program directly (no shell) and collects its output. */
function run(command, args, { cwd, env, timeout = 0 } = {}) {
  const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return collect(child, timeout);
}

/** Quotes one argument for a cmd.exe command line. */
function quoteArg(value) {
  const text = String(value);
  if (/^[\w@.,:/\\=+-]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '')}"`;
}

/** Starts a command line in cmd.exe, exactly like typing it into a Command Prompt. */
function spawnCommand(commandLine, { cwd, env } = {}) {
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], {
    cwd,
    env,
    windowsHide: true,
    windowsVerbatimArguments: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function runCommand(commandLine, { cwd, env, timeout = 0 } = {}) {
  return collect(spawnCommand(commandLine, { cwd, env }), timeout);
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    const child = spawn('taskkill.exe', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
}

/** Calls onLine for every line of a stream, treating \r as a line break too (progress output). */
function onLines(stream, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const parts = buffer.split(/\r\n|\r|\n/);
    buffer = parts.pop();
    for (const part of parts) if (part.trim()) onLine(stripAnsi(part));
  });
  stream.on('end', () => {
    if (buffer.trim()) onLine(stripAnsi(buffer));
    buffer = '';
  });
}

async function downloadFile(url, destination, onProgress) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status} ${res.statusText})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const partial = `${destination}.partial`;
  let done = 0;
  let lastReport = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      done += chunk.length;
      const now = Date.now();
      if (onProgress && now - lastReport > 250) {
        lastReport = now;
        onProgress(done, total);
      }
      callback(null, chunk);
    },
  });
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  try {
    await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(partial));
  } catch (err) {
    await fsp.rm(partial, { force: true });
    throw err;
  }
  onProgress?.(done, total);
  await fsp.rename(partial, destination);
}

async function fetchJson(url, { timeout = 15000 } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchText(url, { timeout = 15000 } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.text();
}

async function extractZip(zip, destination) {
  await fsp.mkdir(destination, { recursive: true });
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (fs.existsSync(tar)) {
    const { code } = await run(tar, ['-xf', zip, '-C', destination]);
    if (code === 0) return;
  }
  const script = `Expand-Archive -LiteralPath '${zip.replaceAll("'", "''")}' -DestinationPath '${destination.replaceAll("'", "''")}' -Force`;
  const { code, stderr } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (code !== 0) throw new Error(`could not unpack ${path.basename(zip)}: ${stderr.trim()}`);
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 3723 -> "1:02:03" */
function formatClock(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 3600)}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

/** 3723 -> "1h02m03s" (safe for file names) */
function formatStamp(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 3600)}h${pad2(Math.floor((s % 3600) / 60))}m${pad2(s % 60)}s`;
}

// Look-alike replacements (same style twitch-dlp uses). "%" is replaced too, because cmd.exe expands it.
const FILENAME_REPLACEMENTS = { '\\': '⧹', '/': '⧸', ':': '：', '*': '＊', '?': '？', '"': '＂', '<': '＜', '>': '＞', '|': '｜', '%': '％' };

function sanitizeFileName(name) {
  return name
    .replace(/[\\/:*?"<>|%]/g, (c) => FILENAME_REPLACEMENTS[c])
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
}

module.exports = {
  USER_AGENT,
  log,
  stripAnsi,
  readJson,
  writeJson,
  run,
  quoteArg,
  spawnCommand,
  runCommand,
  killTree,
  onLines,
  downloadFile,
  fetchJson,
  fetchText,
  extractZip,
  formatClock,
  formatStamp,
  sanitizeFileName,
};
