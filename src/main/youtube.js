'use strict';
// YouTube support: video details and qualities come from `yt-dlp -J`, downloads run yt-dlp itself.
const U = require('./util');
const tools = require('./tools');

const ID = '([\\w-]{11})';
const URL_REGEXES = [
  new RegExp(`(?:^|\\/\\/|\\.)youtube(?:-nocookie)?\\.com\\/watch\\?(?:[^#]*&)?v=${ID}`, 'i'),
  new RegExp(`(?:^|\\/\\/|\\.)youtube(?:-nocookie)?\\.com\\/(?:live|shorts|embed|v)\\/${ID}`, 'i'),
  new RegExp(`(?:^|\\/\\/)youtu\\.be\\/${ID}`, 'i'),
];

/** Accepts watch?v=, youtu.be/, /live/, /shorts/ and /embed/ links. A ?t= in the link is the start time. */
function parseUrl(input) {
  const text = String(input || '').trim();
  const id = URL_REGEXES.map((r) => text.match(r)).find(Boolean)?.[1];
  if (!id) return null;
  let start = null;
  const t = text.match(/[?&#](?:t|start)=(?:(\d+)h)?(?:(\d+)m)?(\d+)?s?(?=$|[&#])/i);
  if (t && (t[1] || t[2] || t[3])) start = (Number(t[1]) || 0) * 3600 + (Number(t[2]) || 0) * 60 + (Number(t[3]) || 0);
  return { id, url: `https://www.youtube.com/watch?v=${id}`, start };
}

const requireVideo = (input) => {
  const parsed = parseUrl(input);
  if (!parsed) throw new Error('That does not look like a YouTube link. It should look like https://www.youtube.com/watch?v=FYPabo8zmJg');
  return parsed;
};

/** Quality ids look like "1080p" or "1080p60"; this is the yt-dlp format selector for one. */
function formatSelector(formatId) {
  if (formatId === 'audio_only') return 'ba[ext=m4a]/ba/b';
  const m = String(formatId).match(/^(\d+)p(\d+)?$/);
  if (!m) throw new Error('Please choose a quality.');
  const filter = `[height<=?${m[1]}]${m[2] ? `[fps<=?${m[2]}]` : ''}`;
  return `bv*${filter}+ba/b${filter}`;
}

function friendlyError(output) {
  const error = output.match(/ERROR:\s*(?:\[youtube\]\s*\S+:\s*)?(.+)/)?.[1]?.trim();
  if (/private video|members-only|join this channel/i.test(output)) return 'This video is private or members-only, so it cannot be downloaded.';
  if (/sign in to confirm|not a bot/i.test(output)) return 'YouTube asked to confirm you are not a bot, so this video cannot be downloaded right now. Try again later.';
  if (/video unavailable|not available|removed|terminated/i.test(output)) return 'This video is unavailable. It may have been removed or be blocked in your country.';
  return error ? `yt-dlp: ${error}` : 'Could not get this video from YouTube.';
}

function toFormats(info) {
  const video = (info.formats || []).filter((f) => f.vcodec && f.vcodec !== 'none' && f.height);
  const bestAudio = Math.max(0, ...(info.formats || []).filter((f) => f.vcodec === 'none' && f.acodec !== 'none').map((f) => f.abr || f.tbr || 0));
  const byLabel = new Map();
  for (const f of video) {
    const fps = Math.round(f.fps || 0);
    const label = `${f.height}p${fps > 30 ? fps : ''}`;
    const kbps = Math.round((f.tbr || f.vbr || 0) + bestAudio) || null;
    const current = byLabel.get(label);
    if (!current || (kbps || 0) > (current.kbps || 0)) {
      byLabel.set(label, { id: label, label, resolution: f.width ? `${f.width}x${f.height}` : null, height: f.height, fps: fps || null, kbps, source: false, audioOnly: false });
    }
  }
  const formats = [...byLabel.values()].sort((a, b) => b.height - a.height || (b.fps || 0) - (a.fps || 0));
  if (bestAudio > 0) formats.push({ id: 'audio_only', label: 'Audio only', resolution: null, height: null, fps: null, kbps: Math.round(bestAudio), source: false, audioOnly: true });
  return formats;
}

function toVideo(info) {
  const date = String(info.upload_date || '').match(/^(\d{4})(\d{2})(\d{2})$/);
  return {
    id: info.id,
    url: `https://www.youtube.com/watch?v=${info.id}`,
    title: info.title || 'Untitled video',
    channel: info.channel || info.uploader || 'Unknown channel',
    channelLogin: '',
    game: '',
    duration: Math.floor(Number(info.duration)) || 0,
    createdAt: date ? `${date[1]}-${date[2]}-${date[3]}T00:00:00Z` : null,
    type: 'YOUTUBE',
    isLive: false,
    thumbnail: info.thumbnail || null,
  };
}

const cache = new Map(); // id -> { at, promise }
const CACHE_MS = 10 * 60 * 1000;

async function fetchInfo(url) {
  await tools.whenYtDlpReady();
  const args = ['-J', '--no-playlist', '--no-warnings', '--js-runtimes', 'node', url];
  const { code, stdout, stderr } = await U.run(tools.ytDlpExe(), args, { env: tools.commandEnv(), timeout: 2 * 60 * 1000 });
  let info = null;
  try {
    info = JSON.parse(stdout);
  } catch {}
  if (code !== 0 || !info) {
    const output = U.stripAnsi(`${stdout.slice(0, 2000)}\n${stderr}`);
    U.log(`yt-dlp -J failed (exit ${code}):`, output);
    throw new Error(friendlyError(output));
  }
  if (info.is_live || info.live_status === 'is_live' || info.live_status === 'is_upcoming') {
    throw new Error('This is a live stream or an upcoming premiere. Only finished YouTube videos can be downloaded.');
  }
  const formats = toFormats(info);
  if (formats.length === 0) throw new Error('No downloadable video qualities were found for this video.');
  return { video: toVideo(info), formats };
}

function getInfo(parsed) {
  const hit = cache.get(parsed.id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
  const entry = { at: Date.now(), promise: null };
  entry.promise = fetchInfo(parsed.url).catch((err) => {
    cache.delete(parsed.id);
    throw err;
  });
  cache.set(parsed.id, entry);
  return entry.promise;
}

async function getVideo(input) {
  const parsed = requireVideo(input);
  return { ...(await getInfo(parsed)).video, start: parsed.start };
}

async function getFormats(input) {
  return (await getInfo(requireVideo(input))).formats;
}

module.exports = { parseUrl, getVideo, getFormats, formatSelector };
