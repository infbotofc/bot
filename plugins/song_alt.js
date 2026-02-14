const yts = require('yt-search');
const axios = require('axios');

const rateLimiter = {
  queue: [], processing: false, lastRequest: 0, minDelay: 1000,
  add(fn) { return new Promise((resolve, reject) => { this.queue.push({ fn, resolve, reject }); this.process(); }); },
  async process() {
    if (this.processing) return; if (this.queue.length === 0) return; this.processing = true;
    const { fn, resolve, reject } = this.queue.shift();
    const now = Date.now(); const elapsed = now - this.lastRequest;
    if (elapsed < this.minDelay) await new Promise(r => setTimeout(r, this.minDelay - elapsed));
    this.lastRequest = Date.now();
    try { const result = await fn(); resolve(result); } catch (err) { reject(err); }
    this.processing = false; this.process();
  }
};

async function fetchWithRetry(url, maxRetries = 3, baseDelay = 2000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    "use strict";

    const yts = require("yt-search");
    const axios = require("axios");

    // ===== Helpers =====

    function sleep(ms) {
      return new Promise((r) => setTimeout(r, ms));
    }

    function sanitizeFileName(name) {
      return String(name || "song")
        .replace(/[\\/:*?"<>|]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
    }

    function isYouTubeLink(text) {
      const t = String(text || "");
      return /youtu\.be|youtube\.com/i.test(t);
    }

    function extractVideoId(input) {
      const str = String(input || "").trim();
      const patterns = [
        /(?:v=)([a-zA-Z0-9_-]{11})/,
        /youtu\.be\/([a-zA-Z0-9_-]{11})/,
        /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/,
        /^([a-zA-Z0-9_-]{11})$/,
      ];

      for (const re of patterns) {
        const m = str.match(re);
        if (m) return m[1];
      }
      return null;
    }

    async function downloadToBuffer(url, timeoutMs = 60000) {
      const res = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: timeoutMs,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
        },
        validateStatus: (s) => s >= 200 && s < 400,
      });

      return Buffer.from(res.data);
    }

    async function fetchWithRetry(url, { maxRetries = 4, baseDelay = 1200 } = {}) {
      let lastErr;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const res = await axios.get(url, {
            timeout: 30000,
            validateStatus: (s) => s < 500,
          });

          if (res.status === 429) {
            const retryAfter = res.headers?.["retry-after"];
            const waitMs = retryAfter
              ? Number.parseInt(retryAfter, 10) * 1000
              : baseDelay * attempt;

            if (attempt < maxRetries) {
              await sleep(waitMs + Math.floor(Math.random() * 250));
              continue;
            }
            throw new Error("RATE_LIMIT");
          }

          if (res.status >= 400) {
            throw new Error(`API_${res.status}`);
          }

          return res.data;
        } catch (err) {
          lastErr = err;

          if (attempt >= maxRetries) break;

          const backoff = baseDelay * Math.pow(2, attempt - 1);
          await sleep(backoff + Math.floor(Math.random() * 300));
        }
      }

      throw lastErr;
    }

    class RateLimiter {
      constructor({ minDelay = 1000 } = {}) {
        this.minDelay = minDelay;
        this.queue = [];
        this.running = false;
        this.lastAt = 0;
      }

      add(taskFn) {
        return new Promise((resolve, reject) => {
          this.queue.push({ taskFn, resolve, reject });
          this._run();
        });
      }

      async _run() {
        if (this.running) return;
        this.running = true;

        while (this.queue.length) {
          const now = Date.now();
          const elapsed = now - this.lastAt;
          if (elapsed < this.minDelay) await sleep(this.minDelay - elapsed);

          this.lastAt = Date.now();

          const { taskFn, resolve, reject } = this.queue.shift();
          try {
            const out = await taskFn();
            resolve(out);
          } catch (e) {
            reject(e);
          }
        }

        this.running = false;
      }
    }

    const apiLimiter = new RateLimiter({ minDelay: 1000 });

    function buildMp3ApiUrl(youtubeUrl) {
      return (
        "https://api.qasimdev.dpdns.org/api/loaderto/download" +
        "?apiKey=qasim-dev&format=mp3&url=" +
        encodeURIComponent(youtubeUrl)
      );
    }

    module.exports = {
      command: "song",
      aliases: ["music", "audio", "mp3"],
      category: "music",
      description: "Download song from YouTube (MP3)",
      usage: ".song <song name | youtube link>",
      async handler(sock, message, args, context = {}) {
        const chatId = context.chatId || message.key.remoteJid;
        const query = args.join(" ").trim();
        if (!query) {
          return sock.sendMessage(
            chatId,
            {
              text:
                "🎵 *Song Downloader*\n\n" +
                "Usage:\n" +
                ".song <song name | YouTube link>",
            },
            { quoted: message }
          );
        }
        try {
          let youtubeUrl;
          let videoInfo = null;
          if (isYouTubeLink(query)) {
            youtubeUrl = query;
            const id = extractVideoId(query);
            if (id) {
              try {
                videoInfo = await yts({ videoId: id });
              } catch (e) {}
            }
          } else {
            const results = await yts(query);
            const first = results?.videos?.[0];
            if (!first) {
              return sock.sendMessage(
                chatId,
                { text: "❌ No results found. Try another search." },
                { quoted: message }
              );
            }
            videoInfo = first;
            youtubeUrl = first.url;
          }
          const caption = videoInfo
            ? `🎶 *${videoInfo.title}*\n⏱ Duration: ${videoInfo.timestamp || "Unknown"}\n\n⏳ Downloading...`
            : "⏳ Downloading...";
          if (videoInfo?.thumbnail) {
            await sock.sendMessage(
              chatId,
              { image: { url: videoInfo.thumbnail }, caption },
              { quoted: message }
            );
          } else {
            await sock.sendMessage(chatId, { text: caption }, { quoted: message });
          }
          const apiUrl = buildMp3ApiUrl(youtubeUrl);
          const apiRes = await apiLimiter.add(() => fetchWithRetry(apiUrl, { maxRetries: 4, baseDelay: 1200 }));
          if (!apiRes?.success || !apiRes?.data?.downloadUrl) {
            throw new Error("INVALID_API_RESPONSE");
          }
          const data = apiRes.data;
          const candidates = [];
          if (data.downloadUrl) candidates.push(data.downloadUrl);
          if (Array.isArray(data.alternativeUrls)) {
            for (const item of data.alternativeUrls) {
              if (!item) continue;
              if (item.has_ssl && item.url) candidates.push(item.url);
            }
            for (const item of data.alternativeUrls) {
              if (!item) continue;
              if (!item.has_ssl && item.url) candidates.push(item.url);
            }
          }
          const title = sanitizeFileName(data.title || videoInfo?.title || "song");
          const fileName = `${title}.mp3`;
          let sent = false;
          let lastSendError = null;
          for (const url of candidates) {
            try {
              await sock.sendMessage(
                chatId,
                {
                  audio: { url },
                  mimetype: "audio/mpeg",
                  fileName,
                  ptt: false,
                },
                { quoted: message }
              );
              sent = true;
              break;
            } catch (e) {
              lastSendError = e;
            }
          }
          if (!sent && candidates.length) {
            for (const url of candidates) {
              try {
                const buf = await downloadToBuffer(url, 60000);
                await sock.sendMessage(
                  chatId,
                  {
                    audio: buf,
                    mimetype: "audio/mpeg",
                    fileName,
                    ptt: false,
                  },
                  { quoted: message }
                );
                sent = true;
                break;
              } catch (e) {
                lastSendError = e;
              }
            }
          }
          if (!sent) {
            throw lastSendError || new Error("ALL_URLS_FAILED");
          }
        } catch (err) {
          console.error("Song plugin error:", err);
          let msg = "❌ Failed to download song. ";
          const m = String(err?.message || err);
          if (m.includes("RATE_LIMIT") || m.includes("429") || m.includes("Rate")) {
            msg += "Service is busy. Try again in a minute.";
          } else if (m.includes("INVALID_API_RESPONSE")) {
            msg += "Downloader API returned an invalid response.";
          } else if (m.toLowerCase().includes("timeout")) {
            msg += "Timed out. Try a shorter video or try again.";
          } else if (m.startsWith("API_")) {
            msg += `Downloader API error (${m.replace("API_", "")}). Try again later.`;
          } else {
            msg += "Please try again later.";
          }
          await sock.sendMessage(chatId, { text: msg }, { quoted: message });
        }
      },
    };
