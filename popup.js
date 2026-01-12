async function getLatestVideo() {
  return chrome.runtime.sendMessage({ type: "get-latest-video" });
}

function escapeHtml(value) {
  if (value == null) return "";
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return char;
    }
  });
}

function getHostname(url) {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch (_error) {
    return url;
  }
}

function formatDuration(seconds) {
  if (!seconds || isNaN(seconds)) return "";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(
      2,
      "0"
    )}`;
  }
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

async function render() {
  const links = await getLatestVideo();
  const linksList = document.getElementById("links");
  const errorBox = document.getElementById("error");

  linksList.innerHTML = "";
  errorBox.hidden = true;
  errorBox.textContent = "";

  if (!links.length) {
    linksList.innerHTML = `
      <li class="empty-placeholder">
            <div class="logo">
              <span></span>
              <span></span>
              <span></span>
            </div>
        <div class="empty-placeholder__caption">Waiting for media...</div>
      </li>
    `;
    return;
  }

  const downloadStates = await chrome.runtime.sendMessage({
    type: "get-download-state",
  });
  const stateMap = new Map(downloadStates.map((s) => [s.url, s]));

  for (const entry of links) {
    const li = document.createElement("li");
    li.className = "link-item";

    const tabTitle = escapeHtml(entry.tabTitle ?? "Unknown stream");
    const previewUrl = escapeHtml(entry.previewImage ?? "");

    const thumbnailMarkup = `
      <div class="thumbnail video-preview">
        <video class="preview-video" muted playsinline></video>
        <span class="duration"></span>
        <div class="play-overlay">▶</div>
      </div>
    `;

    li.innerHTML = `
      <div class="link-top">
        ${thumbnailMarkup}
        <div class="meta">
          <p title="${tabTitle}">${tabTitle}</p>
          <div class="link-actions">
            <button class="primary send">Download</button>
          </div>
        </div>
      </div>
      `;

    const videoElement = li.querySelector(".preview-video");
    const playOverlay = li.querySelector(".play-overlay");
    const thumbnail = li.querySelector(".thumbnail");

    if (window.Hls && window.Hls.isSupported()) {
      const hls = new Hls({
        maxBufferLength: 15,
        maxMaxBufferLength: 15,
        enableWorker: true,
        maxLoadingDelay: 4,
        manifestLoadingTimeOut: 10000,
        manifestLoadingMaxRetry: 2,
        levelLoadingTimeOut: 10000,
      });

      let hasLoaded = false;
      let loadTimeout = setTimeout(() => {
        if (!hasLoaded) {
          videoElement.style.display = "none";
          playOverlay.style.display = "none";
          hls.destroy();
        }
      }, 12000);

      hls.loadSource(entry.url);
      hls.attachMedia(videoElement);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        clearTimeout(loadTimeout);
        hasLoaded = true;
        videoElement.play().catch(() => {});
        playOverlay.style.opacity = "0";

        videoElement.addEventListener("loadedmetadata", () => {
          const duration = videoElement.duration;
          if (duration && isFinite(duration)) {
            const durationSpan = li.querySelector(".duration");
            if (durationSpan) {
              durationSpan.textContent = formatDuration(duration);
            }
          }
        });
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          clearTimeout(loadTimeout);
          hls.destroy();

          videoElement.style.display = "none";
          playOverlay.style.display = "none";

          if (previewUrl) {
            thumbnail.innerHTML = `<img src="${previewUrl}" alt="Preview" /><span class="duration"></span>`;
          } else {
            thumbnail.innerHTML = `
              <div class="video-placeholder">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polygon points="5 3 19 12 5 21 5 3"></polygon>
                </svg>
              </div>
              <span class="duration"></span>
            `;
            thumbnail.style.backgroundColor = "rgba(15, 23, 42, 0.3)";
          }
        }
      });
    } else if (videoElement.canPlayType("application/vnd.apple.mpegurl")) {
      videoElement.src = entry.url;

      videoElement.play().catch(() => {});
      playOverlay.style.opacity = "0";

      videoElement.addEventListener("loadedmetadata", () => {
        const duration = videoElement.duration;
        if (duration && isFinite(duration)) {
          const durationSpan = li.querySelector(".duration");
          if (durationSpan) {
            durationSpan.textContent = formatDuration(duration);
          }
        }
      });
    }

    const actionsDiv = li.querySelector(".link-actions");
    const sendBtn = li.querySelector("button");
    const state = stateMap.get(entry.url);
    if (state) {
      if (state.isDownloading) {
        const isConverting =
          state.status &&
          state.status.toLowerCase().includes("conversion") &&
          state.progress >= 99;

        actionsDiv.innerHTML = `
          <div class="progress-container">
            <div class="progress-info">
              <span class="progress-text">${state.status}</span>
              <span class="progress-percent">${Math.round(
                state.progress
              )}%</span>
            </div>
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${Math.min(
                state.progress,
                100
              )}%"></div>
            </div>
          </div>
          ${
            isConverting
              ? '<span class="spinner"></span>'
              : '<button class="cancel-btn">Cancel</button>'
          }
        `;

        if (!isConverting) {
          const cancelBtn = actionsDiv.querySelector(".cancel-btn");
          cancelBtn.addEventListener("click", async () => {
            try {
              await chrome.runtime.sendMessage({
                type: "cancel-download",
                payload: { url: entry.url },
              });
            } catch (error) {
              render().catch(console.error);
            }
          });
        }
      } else if (state.isFailed) {
        actionsDiv.innerHTML = `
          <div class="error-container">
            <span class="error-text">❌ Error</span>
          </div>
          <button class="retry-btn">Retry</button>
        `;

        const retryBtn = actionsDiv.querySelector(".retry-btn");
        retryBtn.addEventListener("click", async () => {
          retryBtn.disabled = true;
          retryBtn.textContent = "Retrying...";

          await chrome.runtime.sendMessage({
            type: "clear-failed-state",
            payload: { url: entry.url },
          });

          actionsDiv.innerHTML = `
            <div class="progress-container">
              <div class="progress-info">
                <span class="progress-text">Connecting...</span>
                <span class="progress-percent">0%</span>
              </div>
              <div class="progress-bar">
                <div class="progress-fill" style="width: 0%"></div>
              </div>
            </div>
            <button class="cancel-btn">Cancel</button>
          `;

          const cancelBtn = actionsDiv.querySelector(".cancel-btn");
          cancelBtn.addEventListener("click", async () => {
            try {
              await chrome.runtime.sendMessage({
                type: "cancel-download",
                payload: { url: entry.url },
              });
            } catch (error) {
              render().catch(console.error);
            }
          });

          try {
            await chrome.runtime.sendMessage({
              type: "resend-link",
              payload: entry,
            });
          } catch (error) {
            render().catch(console.error);
          }
        });
      } else if (state.progress >= 100) {
        actionsDiv.innerHTML = `
          <button class="primary completed">✓ Completed</button>
          <button class="open-folder-btn">Open Folder</button>
        `;

        const openFolderBtn = actionsDiv.querySelector(".open-folder-btn");
        openFolderBtn?.addEventListener("click", () => {
          chrome.runtime
            .sendMessage({
              type: "open-folder",
              payload: { filePath: state.filePath },
            })
            .catch(console.error);
        });
      }

      linksList.appendChild(li);
      continue;
    }

    const handleDownload = async () => {
      actionsDiv.innerHTML = `
        <div class="progress-container">
          <div class="progress-info">
            <span class="progress-text">Downloading...</span>
            <span class="progress-percent">0%</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill" style="width: 0%"></div>
          </div>
        </div>
        <button class="cancel-btn">Cancel</button>
      `;

      const cancelBtn = actionsDiv.querySelector(".cancel-btn");
      cancelBtn.addEventListener("click", async () => {
        try {
          await chrome.runtime.sendMessage({
            type: "cancel-download",
            payload: { url: entry.url },
          });
        } catch (error) {
          render().catch(console.error);
        }
      });

      try {
        await chrome.runtime.sendMessage({
          type: "resend-link",
          payload: entry,
        });
      } catch (error) {
        errorBox.textContent = error?.message ?? String(error);
        errorBox.hidden = false;
        render().catch(console.error);
      }
    };

    sendBtn.addEventListener("click", handleDownload);

    linksList.appendChild(li);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "video-updated") {
    render().catch(console.error);
  }
  if (message?.type === "native-error") {
    const errorBox = document.getElementById("error");
    errorBox.textContent = message.payload;
    errorBox.hidden = false;
  }

  if (message?.type === "download-error") {
    render().catch(console.error);
  }

  if (message?.type === "download-completed") {
    render().catch(console.error);
  }

  if (message?.type === "download-progress") {
    const { progress, status, message: messageText } = message.payload;

    const progressFill = document.querySelector(".progress-fill");
    const progressPercent = document.querySelector(".progress-percent");
    const progressText = document.querySelector(".progress-text");
    const cancelBtn = document.querySelector(".cancel-btn");
    const convertingLoader = document.querySelector(".converting-loader");

    if (progressFill && progressPercent) {
      progressFill.style.width = `${Math.min(progress, 100)}%`;
      progressPercent.textContent = `${Math.round(progress)}%`;

      if (progressText && status) {
        progressText.textContent = status;
      }

      if (
        status &&
        status.toLowerCase().includes("conversion") &&
        progress >= 99 &&
        cancelBtn &&
        !convertingLoader
      ) {
        cancelBtn.outerHTML = '<span class="spinner"></span>';
      }
    }
  }

  if (message?.type === "download-cancelled") {
    render().catch(console.error);
  }
});

render().catch((error) => {
  const errorBox = document.getElementById("error");
  errorBox.textContent = error?.message ?? String(error);
  errorBox.hidden = false;
});
