const NATIVE_HOST = "com.example.m3u8downloader";
const ICON_PATH = "assets/icon128.png";

const videosByTab = new Map();
const downloadStates = new Map();

const activeDownloads = new Map();

const cancelRequests = new Set();

const reconnectAttempts = new Map();
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_BASE_DELAY = 2000;
const CONNECTION_TIMEOUT = 90000;

const allowUrls = ["vntd-thvn.vtvdigital.vn"];

function isTargetUrl(tabOrUrl) {
  if (!tabOrUrl) return false;

  let hostname;
  if (typeof tabOrUrl === "string") {
    try {
      hostname = new URL(tabOrUrl).hostname;
    } catch {
      return false;
    }
  } else {
    try {
      hostname = new URL(tabOrUrl.url).hostname;
    } catch {
      return false;
    }
  }

  return allowUrls.includes(hostname);
}

async function setVideoForTab(entry) {
  if (videosByTab.size > 0 || downloadStates.size > 0) {
    let hasActiveVideo = false;

    for (const [url, state] of downloadStates.entries()) {
      if (state.isDownloading || state.isFailed) {
        hasActiveVideo = true;
        break;
      }
    }

    if (hasActiveVideo) {
      return;
    }

    videosByTab.clear();
    downloadStates.clear();
  }
  const tabId = entry.tabId;
  if (tabId >= 0 && isTargetUrl(entry.pageUrl)) {
    videosByTab.set(tabId, entry);
  }
  // if (tabId >= 0) {
  //   videosByTab.set(tabId, entry);
  // }

  chrome.runtime
    .sendMessage({ type: "video-updated", payload: entry })
    .catch(() => {});
}

async function sendToNative(entry) {
  const message = {
    url: entry.url,
    tabTitle: entry.tabTitle,
    pageUrl: entry.pageUrl,
    detectedAt: entry.detectedAt,
    previewImage: entry.previewImage ?? null,
    autoStart: true,
  };
  return chrome.runtime.sendNativeMessage(NATIVE_HOST, message);
}

async function resolvePreview(tab) {
  if (!tab?.id) {
    return { image: tab?.favIconUrl ?? null, title: tab?.title ?? null };
  }

  if (!tab.url?.startsWith("http")) {
    return { image: tab?.favIconUrl ?? null, title: tab?.title ?? null };
  }

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const absolutify = (url) => {
          if (!url) return null;
          try {
            return new URL(url, document.baseURI).href;
          } catch (_error) {
            return url;
          }
        };

        const attempts = [];

        const videos = Array.from(document.querySelectorAll("video"));
        for (const video of videos) {
          if (video.poster) attempts.push(video.poster);
          if (video.currentSrc) attempts.push(video.currentSrc);
          if (video.src) attempts.push(video.src);
          const posterSource = video.querySelector(
            "source[poster], source[data-poster]"
          );
          if (posterSource?.poster) attempts.push(posterSource.poster);
        }

        const metaSelectors = [
          'meta[property="og:image"]',
          'meta[property="og:image:secure_url"]',
          'meta[name="og:image"]',
          'meta[name="twitter:image"]',
          'meta[property="twitter:image"]',
          'link[rel~="image_src"]',
        ];

        for (const selector of metaSelectors) {
          const el = document.querySelector(selector);
          if (!el) continue;
          const content = el.content || el.href;
          if (content) attempts.push(content);
        }

        for (const img of document.querySelectorAll(
          "img[poster], img[data-poster]"
        )) {
          attempts.push(img.getAttribute("poster"));
          attempts.push(img.getAttribute("data-poster"));
        }

        const normalized = attempts
          .map((candidate) => absolutify(candidate))
          .filter(Boolean)
          .filter(
            (candidate, index, array) => array.indexOf(candidate) === index
          );

        const parsed =
          normalized.find((candidate) =>
            /\.(jpe?g|png|gif|webp|avif|heic|heif)$/i.test(candidate)
          ) ??
          normalized[0] ??
          null;

        return {
          image: parsed,
          title: document.title ?? null,
        };
      },
    });

    const image = result?.result?.image ?? null;
    const title = result?.result?.title ?? tab?.title ?? null;
    return {
      image: image ?? tab?.favIconUrl ?? null,
      title,
    };
  } catch (error) {
    return {
      image: tab?.favIconUrl ?? null,
      title: tab?.title ?? null,
    };
  }
}

async function processEntry(entry, tab) {
  entry.tabTitle = entry.tabTitle ?? tab?.title ?? "Unknown tab";
  entry.pageUrl = entry.pageUrl ?? tab?.url ?? "";
  entry.detectedAt = entry.detectedAt ?? Date.now();

  const preview = await resolvePreview(tab);
  if (!entry.previewImage && preview.image) {
    entry.previewImage = preview.image;
  }
  if (!entry.tabTitle && preview.title) {
    entry.tabTitle = preview.title;
  }

  if (isTargetUrl(tab)) await setVideoForTab(entry);
  // await setVideoForTab(entry);
}

async function attemptReconnect(url, payload, attemptNumber = 0) {
  if (attemptNumber >= MAX_RECONNECT_ATTEMPTS) {
    reconnectAttempts.delete(url);

    const currentProgress = downloadStates.get(url)?.progress || 0;
    downloadStates.set(url, {
      progress: currentProgress,
      status: "Connection failed",
      isDownloading: false,
      isFailed: true,
      errorMessage: "Unable to connect. Please click Retry to try again.",
    });

    chrome.runtime
      .sendMessage({
        type: "download-error",
        payload: { url, message: "Unable to connect after multiple attempts" },
      })
      .catch(() => {});

    return;
  }
  reconnectAttempts.set(url, attemptNumber + 1);

  const delay = Math.min(
    RECONNECT_BASE_DELAY * Math.pow(2, attemptNumber),
    30000
  );

  const currentProgress = downloadStates.get(url)?.progress || 0;
  const waitSeconds = Math.round(delay / 1000);
  downloadStates.set(url, {
    progress: currentProgress,
    status: `Reconnecting in ${waitSeconds}s... (${
      attemptNumber + 1
    }/${MAX_RECONNECT_ATTEMPTS})`,
    isDownloading: true,
    isFailed: false,
  });

  chrome.runtime
    .sendMessage({
      type: "download-progress",
      payload: {
        url: url,
        progress: currentProgress,
        status: `Reconnecting in ${waitSeconds}s... (${
          attemptNumber + 1
        }/${MAX_RECONNECT_ATTEMPTS})`,
      },
    })
    .catch(() => {});

  await new Promise((resolve) => setTimeout(resolve, delay));

  try {
    await startDownload(payload);
  } catch (error) {
    await attemptReconnect(url, payload, attemptNumber + 1);
  }
}

async function startDownload(payload) {
  const url = payload.url;

  return new Promise((resolve, reject) => {
    let port;
    let connectionTimeout;

    try {
      if (!downloadStates.has(url)) {
        downloadStates.set(url, {
          progress: 0,
          status: "Connecting...",
          isDownloading: true,
          isFailed: false,
        });

        chrome.runtime
          .sendMessage({
            type: "download-progress",
            payload: {
              url: url,
              progress: 0,
              status: "Connecting...",
            },
          })
          .catch(() => {});
      }

      port = chrome.runtime.connectNative(NATIVE_HOST);
      activeDownloads.set(url, port);

      connectionTimeout = setTimeout(() => {
        if (port) {
          port.disconnect();
        }

        activeDownloads.delete(url);

        const state = downloadStates.get(url);
        if (state && state.isDownloading && !cancelRequests.has(url)) {
          attemptReconnect(url, payload, reconnectAttempts.get(url) || 0);
        } else {
          downloadStates.delete(url);
          chrome.runtime
            .sendMessage({
              type: "native-error",
              payload: "Connection timeout. Native Host may not be running.",
            })
            .catch(() => {});
        }

        reject(new Error("Connection timeout"));
      }, CONNECTION_TIMEOUT);

      port.postMessage({
        url: payload.url,
        tabTitle: payload.tabTitle,
        pageUrl: payload.pageUrl,
        previewImage: payload.previewImage,
        detectedAt: payload.detectedAt,
        autoStart: true,
      });

      port.onMessage.addListener((msg) => {
        clearTimeout(connectionTimeout);

        reconnectAttempts.delete(url);

        if (msg.type === "started") {
          downloadStates.set(url, {
            progress: msg.progress || 0,
            status: msg.status || msg.message || "Starting conversion...",
            isDownloading: true,
            isFailed: false,
          });

          chrome.runtime
            .sendMessage({
              type: "download-progress",
              payload: {
                url: url,
                progress: msg.progress || 0,
                status: msg.status || msg.message || "Starting conversion...",
              },
            })
            .catch(() => {});
        } else if (msg.type === "progress") {
          downloadStates.set(url, {
            progress: msg.progress || 0,
            status: msg.status || msg.message || "Downloading...",
            isDownloading: true,
            isFailed: false,
          });

          chrome.runtime
            .sendMessage({
              type: "download-progress",
              payload: {
                url: url,
                progress: msg.progress || 0,
                status: msg.status || msg.message || "Downloading...",
              },
            })
            .catch(() => {});
        } else if (msg.type === "completed") {
          downloadStates.set(url, {
            progress: 100,
            status: msg.status || "Completed",
            filePath: msg.message,
            isDownloading: false,
            isFailed: false,
          });

          chrome.runtime
            .sendMessage({
              type: "download-completed",
              payload: {
                url: url,
                progress: 100,
                status: msg.status || "Completed",
                filePath: msg.message,
              },
            })
            .catch(() => {});

          activeDownloads.delete(url);
          reconnectAttempts.delete(url);

          // Keep completed state visible until new video or F5/reload

          port.disconnect();
          resolve();
        } else if (msg.type === "cancelled") {
          downloadStates.delete(url);
          cancelRequests.delete(url);
          reconnectAttempts.delete(url);

          // Remove from videosByTab to allow new detection
          for (const [tabId, video] of videosByTab.entries()) {
            if (video.url === url) {
              videosByTab.delete(tabId);
              break;
            }
          }

          chrome.runtime
            .sendMessage({
              type: "download-cancelled",
              payload: {
                url: url,
                message: msg.message || "User cancelled",
              },
            })
            .catch(() => {});
          activeDownloads.delete(url);
          port.disconnect();
          resolve();
        } else if (msg.type === "error") {
          const currentProgress = downloadStates.get(url)?.progress || 0;
          downloadStates.set(url, {
            progress: currentProgress,
            status: "Failed",
            isDownloading: false,
            isFailed: true,
            errorMessage: msg.message || msg.status || "Download failed",
          });

          chrome.runtime
            .sendMessage({
              type: "download-error",
              payload: {
                url: url,
                message: msg.message || msg.status || "Download failed",
              },
            })
            .catch(() => {});
          activeDownloads.delete(url);
          reconnectAttempts.delete(url);
          port.disconnect();
          reject(new Error(msg.message || "Download failed"));
        } else {
          if (msg.progress !== undefined) {
            downloadStates.set(url, {
              progress: msg.progress || 0,
              status: msg.status || msg.message || "Downloading...",
              isDownloading: true,
              isFailed: false,
            });

            chrome.runtime
              .sendMessage({
                type: "download-progress",
                payload: {
                  url: url,
                  progress: msg.progress || 0,
                  status: msg.status || msg.message || "Downloading...",
                },
              })
              .catch(() => {});
          }
        }
      });

      port.onDisconnect.addListener(() => {
        clearTimeout(connectionTimeout);
        activeDownloads.delete(url);

        const error = chrome.runtime.lastError;
        if (error) {
          const state = downloadStates.get(url);
          if (state && state.isDownloading && !cancelRequests.has(url)) {
            attemptReconnect(url, payload, reconnectAttempts.get(url) || 0);
          } else {
            if (state && state.isDownloading) {
              downloadStates.delete(url);
            }
            chrome.runtime
              .sendMessage({
                type: "native-error",
                payload: error.message || "Connection lost",
              })
              .catch(() => {});
          }
          reject(error);
        } else {
          resolve();
        }
      });
    } catch (error) {
      activeDownloads.delete(url);
      downloadStates.delete(url);
      chrome.runtime
        .sendMessage({
          type: "native-error",
          payload: "Failed to start download. Is Native Host running?",
        })
        .catch(() => {});
      reject(error);
    }
  });
}

async function handleDetection(details) {
  const tab =
    details.tabId >= 0
      ? await chrome.tabs.get(details.tabId).catch(() => null)
      : null;
  const entry = {
    url: details.url,
    tabId: details.tabId,
    tabTitle: tab?.title ?? "Unknown tab",
    pageUrl: tab?.url ?? details.initiator ?? "",
    method: details.method,
    detectedAt: Date.now(),
  };

  processEntry(entry, tab).catch(() => {});
}

// Clear state when tab is refreshed or navigated
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    // Tab is navigating to new URL or refreshing
    const videoEntry = videosByTab.get(tabId);
    if (videoEntry) {
      const url = videoEntry.url;

      // Clear state to allow new video detection
      videosByTab.delete(tabId);
      downloadStates.delete(url);
      reconnectAttempts.delete(url);

      if (activeDownloads.has(url)) {
        const port = activeDownloads.get(url);
        try {
          port.disconnect();
        } catch {}
        activeDownloads.delete(url);
      }
    }
  }
});

// Clear state when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  const videoEntry = videosByTab.get(tabId);
  if (videoEntry) {
    const url = videoEntry.url;

    videosByTab.delete(tabId);
    downloadStates.delete(url);
    reconnectAttempts.delete(url);

    if (activeDownloads.has(url)) {
      const port = activeDownloads.get(url);
      try {
        port.disconnect();
      } catch {}
      activeDownloads.delete(url);
    }
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "send-last",
      title: "Send latest M3U8 link to downloader",
      contexts: ["action"],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== "send-last") return;
  if (!latestVideo) {
    chrome.notifications.create({
      type: "basic",
      iconUrl: ICON_PATH,
      title: "No links captured yet",
      message: "Open a page with streaming video first.",
    });
    return;
  }

  try {
    await sendToNative(latestVideo);
  } catch (error) {}
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id == null) return;
  chrome.action.openPopup().catch(() => {});
});

chrome.webRequest.onCompleted.addListener(
  async (details) => {
    if (!details.url) return;
    if (!details.url.toLowerCase().includes(".m3u8")) return;

    // Ignore requests from extension itself (popup's HLS.js player)
    if (details.initiator?.startsWith("chrome-extension://")) return;
    if (details.tabId === -1) return; // Extension internal requests

    await handleDetection(details);
  },
  {
    urls: ["<all_urls>"],
    types: ["media", "xmlhttprequest", "other"],
  }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (details.url?.toLowerCase().includes(".m3u8")) {
      // Ignore errors from extension itself (popup's HLS.js player)
      if (details.initiator?.startsWith("chrome-extension://")) return;
      if (details.tabId === -1) return;
    }
  },
  {
    urls: ["<all_urls>"],
    types: ["media", "xmlhttprequest", "other"],
  }
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "get-latest-video") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const currentTab = tabs[0];
      const results = [];
      const seenUrls = new Set();

      for (const [url, state] of downloadStates.entries()) {
        if (seenUrls.has(url)) continue;

        let videoEntry = null;
        for (const [tabId, video] of videosByTab.entries()) {
          if (video.url === url) {
            videoEntry = video;
            break;
          }
        }

        if (!videoEntry) {
          videoEntry = {
            url: url,
            tabId: -1,
            tabTitle: "Download in progress",
            pageUrl: "",
            method: "M3U8",
            detectedAt: Date.now(),
          };
        }

        results.push(videoEntry);
        seenUrls.add(url);
      }

      if (currentTab) {
        const tabVideo = videosByTab.get(currentTab.id);
        if (tabVideo && !seenUrls.has(tabVideo.url)) {
          results.push(tabVideo);
          seenUrls.add(tabVideo.url);
        }
      }

      const uniqueResults = [];
      const finalUrls = new Set();
      const getBaseUrl = (url) => {
        try {
          const urlObj = new URL(url);
          return urlObj.origin + urlObj.pathname;
        } catch {
          return url;
        }
      };

      for (const video of results) {
        const baseUrl = getBaseUrl(video.url);
        if (!finalUrls.has(baseUrl)) {
          uniqueResults.push(video);
          finalUrls.add(baseUrl);
        }
      }

      sendResponse(uniqueResults);
    });
    return true;
  }

  if (message?.type === "get-download-state") {
    const states = Array.from(downloadStates.entries()).map(([url, state]) => ({
      url,
      ...state,
    }));
    sendResponse(states);
    return true;
  }

  if (message?.type === "clear-failed-state" && message.payload) {
    const url = message.payload.url;
    const state = downloadStates.get(url);
    if (state && state.isFailed) {
      downloadStates.delete(url);
    }
    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "resend-link" && message.payload) {
    const url = message.payload.url;

    if (activeDownloads.has(url)) {
      sendResponse({ ok: false, message: "Already downloading" });
      return true;
    }

    downloadStates.set(url, {
      progress: 0,
      status: "Connecting...",
      isDownloading: true,
      isFailed: false,
    });

    chrome.runtime
      .sendMessage({
        type: "download-progress",
        payload: {
          url: url,
          progress: 0,
          status: "Connecting...",
        },
      })
      .catch(() => {});

    reconnectAttempts.delete(url);

    startDownload(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, message: error.message }));

    return true;
  }

  if (message?.type === "cancel-download" && message.payload) {
    const url = message.payload.url;

    if (cancelRequests.has(url)) {
      sendResponse({ ok: false, message: "Already cancelling" });
      return true;
    }

    cancelRequests.add(url);

    fetch("http://localhost:9876/cancel")
      .then((response) => response.json())
      .then((data) => {
        activeDownloads.delete(url);
        cancelRequests.delete(url);
        downloadStates.delete(url);
        reconnectAttempts.delete(url);

        for (const [tabId, video] of videosByTab.entries()) {
          if (video.url === url) {
            videosByTab.delete(tabId);
            break;
          }
        }

        chrome.runtime
          .sendMessage({
            type: "download-cancelled",
            payload: { url },
          })
          .catch(() => {});
      })
      .catch((error) => {
        cancelRequests.delete(url);
      });

    sendResponse({ ok: true });
    return true;
  }

  if (message?.type === "open-folder") {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    port.postMessage({
      action: "open-folder",
      filePath: message.payload?.filePath,
    });

    port.onMessage.addListener((response) => {
      port.disconnect();
    });

    setTimeout(() => {
      port.disconnect();
    }, 2000);
  }

  if (message?.type === "video-detected" && message.payload?.url) {
    const tab = sender?.tab ?? null;
    const entry = {
      url: message.payload.url,
      tabId: tab?.id ?? -1,
      tabTitle: message.payload.tabTitle ?? tab?.title ?? "Unknown stream",
      pageUrl: message.payload.pageUrl ?? tab?.url ?? "",
      previewImage: message.payload.previewImage ?? null,
      method: message.payload.method ?? "VIDEO",
      detectedAt: Date.now(),
    };

    processEntry(entry, tab).catch(() => {});
  }

  if (message?.type === "download-video" && message.payload) {
    sendToNative(message.payload)
      .then((response) => {
        sendResponse({ success: true, response });
      })
      .catch((error) => {
        sendResponse({ success: false, error: error.message });
      });

    return true;
  }

  return false;
});
