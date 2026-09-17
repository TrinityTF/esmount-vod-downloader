'use strict';
const U = require('./util');
const tools = require('./tools');

// Public web client id (the same one twitch.tv and twitch-dlp use).
const GQL_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const VIDEO_QUERY = `query VideoInfo($id: ID!) {
  video(id: $id) {
    id title lengthSeconds createdAt broadcastType
    previewThumbnailURL(width: 640, height: 360)
    owner { login displayName }
    game { displayName }
  }
}`;

const VOD_URL_REGEX = /(?:^|\/\/|\.)twitch\.tv\/(?:videos|[^/?#]+\/v(?:ideo)?)\/(\d+)/i;
const PLAYER_URL_REGEX = /player\.twitch\.tv\/\?.*?\bvideo=v?(\d+)/i;

/** Accepts twitch.tv/videos/123, twitch.tv/<channel>/v/123, player links, or a bare id. */
function parseVodUrl(input) {
  const text = String(input || '').trim();
  const match = text.match(VOD_URL_REGEX) || text.match(PLAYER_URL_REGEX) || text.match(/^v?(\d{5,})$/);
  if (!match) return null;
  let start = null;
  const t = text.match(/[?&]t=(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i);
  if (t && (t[1] || t[2] || t[3])) start = (Number(t[1]) || 0) * 3600 + (Number(t[2]) || 0) * 60 + (Number(t[3]) || 0);
  return { id: match[1], url: `https://www.twitch.tv/videos/${match[1]}`, start };
}

const cache = new Map(); // id -> { at, info }
const CACHE_MS = 10 * 60 * 1000;

async function fetchMetadata(id) {
  const res = await fetch('https://gql.twitch.tv/gql', {
    method: 'POST',
    headers: { 'Client-Id': GQL_CLIENT_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: VIDEO_QUERY, variables: { id } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Twitch did not respond (${res.status}). Please try again.`);
  const body = await res.json();
  const video = body?.data?.video;
  if (!video) throw new Error('This VOD was not found. It may have been deleted, or it is private or sub-only.');
  return {
    id: video.id,
    url: `https://www.twitch.tv/videos/${video.id}`,
    title: video.title || 'Untitled Broadcast',
    channel: video.owner?.displayName || video.owner?.login || 'Unknown channel',
    channelLogin: video.owner?.login || '',
    game: video.game?.displayName || '',
    duration: Number(video.lengthSeconds) || 0,
    createdAt: video.createdAt,
    type: video.broadcastType,
    thumbnail: video.previewThumbnailURL && !video.previewThumbnailURL.includes('404_processing') ? video.previewThumbnailURL : null,
  };
}

/** Parses the console.table printed by `twitch-dlp -F`. */
function parseFormatsTable(output) {
  let header = null;
  const rows = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('│')) continue;
    const cells = line.split('│').slice(1, -1).map((c) => c.trim());
    if (cells[0] === '(index)') {
      header = cells;
      continue;
    }
    if (!header) continue;
    const row = {};
    header.forEach((name, i) => {
      const value = cells[i] ?? '';
      if (value === '' || value === 'null' || value === 'undefined') row[name] = null;
      else if (/^'.*'$/.test(value)) row[name] = value.slice(1, -1);
      else if (value === 'true' || value === 'false') row[name] = value === 'true';
      else if (/^-?\d+(\.\d+)?$/.test(value)) row[name] = Number(value);
      else row[name] = value;
    });
    if (row.format_id) rows.push(row);
  }
  return rows;
}

function toFormat(row) {
  const id = String(row.format_id);
  const isAudio = id.toLowerCase() === 'audio_only';
  const kbps = Number.parseInt(row.total_bitrate, 10) || null;
  const height = String(row.resolution || '').match(/x(\d+)$/)?.[1];
  return {
    id,
    label: isAudio ? 'Audio only' : id,
    resolution: isAudio ? null : row.resolution || null,
    height: height ? Number(height) : null,
    fps: row.fps || null,
    kbps,
    source: row.source === true,
    audioOnly: isAudio,
  };
}

async function fetchFormats(url) {
  await tools.whenTwitchDlpReady();
  const command = tools.twitchDlpCommand([url, '-F']);
  const { code, stdout, stderr } = await U.runCommand(command, { env: tools.commandEnv(), timeout: 2 * 60 * 1000 });
  const formats = parseFormatsTable(stdout).map(toFormat);
  if (formats.length === 0) {
    const output = U.stripAnsi(`${stdout}\n${stderr}`);
    U.log(`${command} failed (exit ${code}):`, output);
    const error = output.match(/ERROR:\s*(.+)/)?.[1];
    if (/might be private/i.test(output)) throw new Error('This VOD seems to be private, deleted, or sub-only, so it cannot be downloaded.');
    throw new Error(error ? `twitch-dlp: ${error}` : 'Could not get the available qualities for this VOD.');
  }
  // twitch-dlp lists the worst quality first; show the best first.
  return formats.reverse();
}

/** Caches successful results of fn(key) for a few minutes, sharing in-flight requests. */
function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && (!hit.at || Date.now() - hit.at < CACHE_MS)) return hit.promise;
  const entry = { at: 0, promise: null };
  entry.promise = fn().then(
    (value) => {
      entry.at = Date.now();
      return value;
    },
    (err) => {
      cache.delete(key);
      throw err;
    },
  );
  cache.set(key, entry);
  return entry.promise;
}

function requireVod(input) {
  const parsed = parseVodUrl(input);
  if (!parsed) throw new Error('That does not look like a Twitch VOD link. It should look like https://www.twitch.tv/videos/123456789');
  return parsed;
}

/** Title, channel, duration, thumbnail… plus the start time if the link had ?t=. */
async function getVideo(input) {
  const parsed = requireVod(input);
  const meta = await cached(`meta:${parsed.id}`, () => fetchMetadata(parsed.id));
  return { ...meta, start: parsed.start };
}

/** Available qualities, best first. */
function getFormats(input) {
  const parsed = requireVod(input);
  return cached(`formats:${parsed.id}`, () => fetchFormats(parsed.url));
}

module.exports = { parseVodUrl, getVideo, getFormats };
