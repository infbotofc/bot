// Minimal fallback handler in case song.js tries to call it (shouldn't happen)
module.exports = {
  command: 'song_alt',
  aliases: [],
  category: 'download',
  description: 'Fallback song downloader (disabled)',
  usage: '.song <query>',
  async handler(sock, message, args, context = {}) {
    const chatId = context.chatId || message.key.remoteJid;
    await sock.sendMessage(chatId, { text: '❌ Alternate song handler is not available.' }, { quoted: message });
  }
};      }

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
