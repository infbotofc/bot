/**
 * .song (FINAL) - YouTube Search -> Sends Audio File
 * --------------------------------------------------
 * Fixes / Improvements:
 * - Better YouTube search filtering (no live, no shorts, reasonable duration)
 * - Uses @distube/ytdl-core (patched) + optional cookie agent
 * - Downloads best audio, saves as .m4a by default (correct container)
 * - If ffmpeg exists, converts to .mp3 automatically
 * - Sends as audio if small enough, otherwise as document
 * - More reliable temp cleanup + clear user messages
 *
 * Optional ENV:
 * - YT_COOKIE : YouTube cookie string to improve reliability for some videos
 * - MAX_AUDIO_MB : override send-as-audio size limit (default 25)
 */

const yts = require('yt-search');
const ytdl = require('@distube/ytdl-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MAX_AUDIO_MB = Number(process.env.MAX_AUDIO_MB || 25);

function safeName(name, maxLen = 120) {
  const s = (name || 'audio')
    .toString()
    .replace(/[^a-zA-Z0-9 _.-]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > maxLen ? s.slice(0, maxLen).trim() : s;
}

function bytesToMB(bytes) {
  return bytes / 1024 / 1024;
}

function hasFfmpeg() {
  try {
    const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

function pickBestVideo(search) {
  const videos = Array.isArray(search?.videos) ? search.videos : [];
  if (!videos.length) return null;

  // Filter: no live, no shorts, duration 30s - 30min (tweakable)
  const filtered = videos.filter(v => {
    const sec = Number(v.seconds || 0);
    const url = String(v.url || '');
    const isLive = !!v.live;
    const isShort = url.includes('/shorts/');
    return !isLive && !isShort && sec >= 30 && sec <= 30 * 60;
  });

  // Prefer first good match
  return filtered[0] || videos[0];
}

function getYtdlAgent() {
  // If cookies provided, create an agent (helps bypass some restrictions)
  const cookie = process.env.YT_COOKIE;
  if (cookie && cookie.trim()) {
    try {
      return ytdl.createAgent([{ name: 'cookie', value: cookie }]);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function downloadBestAudioToFile(videoUrl, outPath) {
  const agent = getYtdlAgent();

  // ytdl will handle formats; we still try to pick best audio-only format
  const info = await ytdl.getInfo(videoUrl, agent ? { agent } : undefined);
  const formats = ytdl.filterFormats(info.formats, 'audioonly');

  // Choose best by audio bitrate, then by content length
  formats.sort((a, b) => {
    const abrA = Number(a.audioBitrate || 0);
    const abrB = Number(b.audioBitrate || 0);
    if (abrB !== abrA) return abrB - abrA;
    const lenA = Number(a.contentLength || 0);
    const lenB = Number(b.contentLength || 0);
    return lenB - lenA;
  });

  const chosen = formats[0];
  if (!chosen) throw new Error('No audio formats available for this video.');

  await new Promise((resolve, reject) => {
    const stream = ytdl.downloadFromInfo(info, {
      format: chosen,
      highWaterMark: 1 << 25,
      ...(agent ? { agent } : {}),
    });

    const write = fs.createWriteStream(outPath);

    stream.on('error', reject);
    write.on('error', reject);
    write.on('finish', resolve);

    stream.pipe(write);
  });

  return {
    title: info.videoDetails?.title || 'Unknown Title',
    author: info.videoDetails?.author?.name || info.videoDetails?.author || 'Unknown Artist',
    lengthSeconds: Number(info.videoDetails?.lengthSeconds || 0),
    thumbnail: (info.videoDetails?.thumbnails || []).slice(-1)[0]?.url || '',
  };
}

function ffmpegConvertToMp3(inFile, outFile) {
  // -vn no video, -b:a 192k good default
  const r = spawnSync('ffmpeg', ['-y', '-i', inFile, '-vn', '-b:a', '192k', outFile], { stdio: 'ignore' });
  return r.status === 0;
}

module.exports = {
  command: 'song',
  aliases: ['rsong', 'music2'],
  category: 'download',
  description: 'Search YouTube and send the audio file',
  usage: '.song <song name>',

  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;
    const query = args.join(' ').trim();

    if (!query) {
      return await sock.sendMessage(
        chatId,
        { text: '🎵 *Which song do you want?*\n\nUsage: `.song <song name>`' },
        { quoted: message }
      );
    }

    const tmpBase = `song_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tmpM4a = path.join(os.tmpdir(), `${tmpBase}.m4a`);
    const tmpMp3 = path.join(os.tmpdir(), `${tmpBase}.mp3`);

    try {
      await sock.sendPresenceUpdate('composing', chatId);

      const search = await yts(query);
      const video = pickBestVideo(search);
      if (!video?.url) {
        return await sock.sendMessage(chatId, { text: '❌ No YouTube results found.' }, { quoted: message });
      }

      // Send quick info first (from search)
      const infoText =
        `╭──〔 🎵 *SONG FOUND* 〕\n` +
        `│ 📝 *Title:* ${video.title || 'Unknown'}\n` +
        `│ 👤 *Channel:* ${video.author?.name || 'Unknown'}\n` +
        `│ ⏱️ *Duration:* ${video.timestamp || 'Unknown'}\n` +
        `│ 🔗 *Link:* ${video.url}\n` +
        `╰──────────────\n\n` +
        `⏳ *Downloading audio...*`;

      if (video.thumbnail) {
        await sock.sendMessage(chatId, { image: { url: video.thumbnail }, caption: infoText }, { quoted: message });
      } else {
        await sock.sendMessage(chatId, { text: infoText }, { quoted: message });
      }

      await sock.sendPresenceUpdate('recording', chatId);

      // Download best audio to .m4a (correct container from YouTube formats)
      const meta = await downloadBestAudioToFile(video.url, tmpM4a);

      const baseTitle = safeName(meta.title);

      // Convert to mp3 if ffmpeg exists
      let finalPath = tmpM4a;
      let finalMime = 'audio/mp4';
      let finalName = `${baseTitle}.m4a`;

      if (hasFfmpeg()) {
        const ok = ffmpegConvertToMp3(tmpM4a, tmpMp3);
        if (ok && fs.existsSync(tmpMp3) && fs.statSync(tmpMp3).size > 5000) {
          finalPath = tmpMp3;
          finalMime = 'audio/mpeg';
          finalName = `${baseTitle}.mp3`;
        }
      }

      const stat = fs.statSync(finalPath);
      const sizeMB = bytesToMB(stat.size);

      // Send audio if small enough, else document
      if (sizeMB <= MAX_AUDIO_MB) {
        await sock.sendMessage(
          chatId,
          {
            audio: fs.createReadStream(finalPath),
            mimetype: finalMime,
            fileName: finalName,
          },
          { quoted: message }
        );
      } else {
        await sock.sendMessage(
          chatId,
          {
            document: fs.createReadStream(finalPath),
            mimetype: finalMime,
            fileName: finalName,
          },
          { quoted: message }
        );

        // Also share link for convenience
        await sock.sendMessage(
          chatId,
          { text: `⚠️ File is ${sizeMB.toFixed(1)}MB (sent as document).\n🔗 Source: ${video.url}` },
          { quoted: message }
        );
      }

    } catch (err) {
      console.error('[song] error:', err?.message || err);
      await sock.sendMessage(
        chatId,
        { text: `❌ *Download failed!*\n\n*Error:* ${err?.message || err}` },
        { quoted: message }
      );
    } finally {
      try { if (fs.existsSync(tmpM4a)) fs.unlinkSync(tmpM4a); } catch {}
      try { if (fs.existsSync(tmpMp3)) fs.unlinkSync(tmpMp3); } catch {}
      try { await sock.sendPresenceUpdate('paused', chatId); } catch {}
    }
  }
};
