const STORAGE_KEY = "capturedM3u8Links";
const SETTINGS_KEY = "settings";
const DEFAULT_SETTINGS = {
  nativeHost: "com.example.m3u8downloader",
  showNotifications: true,
  retentionHours: 24,
};

const ICON_PATH = "assets/icon128.png";

async function getSettings() {
  const stored = await chrome.storage.sync.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored?.[SETTINGS_KEY] ?? {}) };
}

async function setSettings(settings) {
  await chrome.storage.sync.remove({ [SETTINGS_KEY]: settings });
}

async function pushLink(entry) {
  const { url } = entry;
  const now = Date.now();
  const settings = await getSettings();
  const { retentionHours } = settings;

  const existing = await chrome.storage.local.get(STORAGE_KEY);
  const list = existing?.[STORAGE_KEY] ?? [];

  const normalizeKey = (candidate) => {
    if (!candidate || typeof candidate !== "string") return "";
    const trimmed = candidate.trim();
    try {
      const parsed = new URL(trimmed);
      parsed.hash = "";
      if (parsed.search) {
        const params = Array.from(parsed.searchParams.entries());
        if (params.length) {
          params.sort(([aKey, aValue], [bKey, bValue]) => {
            if (aKey === bKey) {
              return String(aValue).localeCompare(String(bValue));
            }
            return aKey.localeCompare(bKey);
          });
          const normalizedParams = new URLSearchParams();
          for (const [key, value] of params) {
            normalizedParams.append(key, value);
          }
          const serialized = normalizedParams.toString();
          parsed.search = serialized ? `?${serialized}` : "";
        } else {
          parsed.search = "";
        }
      }
      // Heuristic: many HLS CDN URLs embed short tokens and per-request numeric ids in the
      // path. For common cases like `/.../something.mp4/index.m3u8` we canonicalize by
      // preserving only the trailing path segments (so tokenized prefixes don't make
      // otherwise-identical manifests appear unique).
      try {
        const segments = parsed.pathname.split("/").filter(Boolean);
        if (
          segments.length >= 4 &&
          segments[segments.length - 1].toLowerCase().endsWith("index.m3u8")
        ) {
          const keep = 4; // keep last 4 segments: e.g. `vtvgo-media/vod/2025/11/04/.../index.m3u8`
          const tail = segments.slice(-keep).join("/");
          parsed.pathname = `/${tail}`;
        }
      } catch (_e) {
        // ignore and fall back to full path
      }

      return parsed.toString();
    } catch (_error) {
      return trimmed;
    }
  };

  const keyFor = (candidate) => {
    const normalized = normalizeKey(candidate);
    if (normalized) return normalized;
    if (candidate == null) return "";
    return String(candidate).trim();
  };

  const targetKey = keyFor(url);
  let mergedEntry = entry;

  if (targetKey) {
    const previous = list.find((item) => keyFor(item?.url) === targetKey);
    if (previous) {
      mergedEntry = {
        ...previous,
        ...entry,
        tabTitle: entry.tabTitle || previous.tabTitle || entry.tabTitle,
        pageUrl: entry.pageUrl || previous.pageUrl || entry.pageUrl,
        previewImage: entry.previewImage ?? previous.previewImage ?? null,
        detectedAt: entry.detectedAt,
      };
    }
  }

  const ordered = [];
  const seen = new Set();

  const pushIfNew = (item) => {
    if (!item) return;
    const key = keyFor(item.url);
    const dedupeKey = key || `__blank-${ordered.length}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    ordered.push(item);
  };

  pushIfNew(mergedEntry);
  for (const item of list) {
    pushIfNew(item);
  }

  const retentionMs =
    Math.max(1, retentionHours ?? DEFAULT_SETTINGS.retentionHours) *
    60 *
    60 *
    1000;
  const cutoff = now - retentionMs;
  const filtered = ordered.filter((item) => {
    if (!item?.detectedAt) return true;
    return item.detectedAt >= cutoff;
  });

  const trimmed = filtered.slice(0, 100);
  await chrome.storage.local.set({ [STORAGE_KEY]: trimmed });
  chrome.runtime
    .sendMessage({ type: "links-updated", payload: trimmed })
    .catch(() => {});
  return true;
}

async function sendToNative(entry) {
  const settings = await getSettings();
  const message = {
    url: entry.url,
    tabTitle: entry.tabTitle,
    pageUrl: entry.pageUrl,
    detectedAt: entry.detectedAt,
    previewImage: entry.previewImage ?? null,
  };
  console.log(message);
  return chrome.runtime.sendNativeMessage(settings.nativeHost, message);
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
    console.warn("Preview extraction failed", error);
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

  const isNew = await pushLink(entry);
  if (!isNew) return false;

  const settings = await getSettings();
  await notifyCapture(entry, settings);
  return true;
}

async function notifyCapture(entry, settings) {
  const prefs = settings ?? (await getSettings());
  if (!prefs.showNotifications) return;

  chrome.notifications.create(
    {
      type: "basic",
      iconUrl: ICON_PATH,
      title: "M3U8 stream detected",
      message: entry.url,
      contextMessage: "Click to send to downloader",
    },
    () => {
      if (chrome.runtime.lastError) {
        console.warn("Notification error", chrome.runtime.lastError);
      }
    }
  );
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

  await processEntry(entry, tab);
}

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.sync.get(SETTINGS_KEY);
  if (!existing?.[SETTINGS_KEY]) {
    await setSettings(DEFAULT_SETTINGS);
  }

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
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const latest = stored?.[STORAGE_KEY]?.[0];
  if (!latest) {
    chrome.notifications.create({
      type: "basic",
      iconUrl: ICON_PATH,
      title: "No links captured yet",
      message: "Open a page with streaming video first.",
    });
    return;
  }

  try {
    await sendToNative(latest);
  } catch (error) {
    console.error("Failed to send via context menu", error);
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id == null) return;
  chrome.action.openPopup().catch(() => {});
});

chrome.webRequest.onCompleted.addListener(
  async (details) => {
    if (!details.url) return;
    if (!details.url.toLowerCase().includes(".m3u8")) return;
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
      console.warn("M3U8 request error", details);
    }
  },
  {
    urls: ["<all_urls>"],
    types: ["media", "xmlhttprequest", "other"],
  }
);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "get-links") {
    chrome.storage.local.get(STORAGE_KEY).then((result) => {
      sendResponse(result?.[STORAGE_KEY] ?? []);
    });
    return true;
  }

  if (message?.type === "resend-link" && message.payload) {
    sendToNative(message.payload).catch((error) => {
      console.error("Resend failed", error);
    });
  }

  if (message?.type === "update-settings" && message.payload) {
    setSettings(message.payload).catch((error) => {
      console.error("Failed to store settings", error);
    });
  }

  if (message?.type === "get-settings") {
    getSettings().then((settings) => sendResponse(settings));
    return true;
  }

  if (message?.type === "clear-links") {
    chrome.storage.local
      .set({ [STORAGE_KEY]: [] })
      .then(() => {
        chrome.runtime
          .sendMessage({ type: "links-updated", payload: [] })
          .catch(() => {});
        sendResponse({ ok: true });
      })
      .catch((error) => {
        console.error("Failed to clear links", error);
        sendResponse({
          ok: false,
          error: error?.message ?? "Failed to clear captured links.",
        });
      });
    return true;
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

    processEntry(entry, tab).catch((error) => {
      console.error("Failed to record video capture", error);
    });
  }

  return false;
});
