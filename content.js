(() => {
  const reported = new Set();
  const MAX_TRACKED = 200;
  const videoPositionCache = new WeakMap(); // ✅ Cache vị trí video

  const absolutify = (url) => {
    if (!url) return null;
    try {
      return new URL(url, document.baseURI).href;
    } catch (_error) {
      return url;
    }
  };

  const remember = (url) => {
    reported.add(url);
    if (reported.size > MAX_TRACKED) {
      const first = reported.values().next().value;
      if (first) reported.delete(first);
    }
  };

  const shouldReport = (url) => {
    if (!url) return false;
    const lowered = url.toLowerCase();
    if (!lowered.includes(".m3u8")) return false;
    if (reported.has(url)) return false;
    return true;
  };

  const buildPayload = (video, url) => {
    const payload = {
      url,
      tabTitle: document.title,
      pageUrl: window.location.href,
    };

    const poster = video.poster || video.getAttribute("data-poster");
    const absolutePoster = absolutify(poster);
    if (absolutePoster) {
      payload.previewImage = absolutePoster;
    }

    return payload;
  };

  const extractCandidate = (video) => {
    const candidates = new Set([
      video.currentSrc,
      video.src,
      video.getAttribute("data-src"),
      video.getAttribute("data-hls"),
      video.getAttribute("data-url"),
    ]);

    video.querySelectorAll("source").forEach((source) => {
      candidates.add(source.src);
      candidates.add(source.getAttribute("data-src"));
      candidates.add(source.getAttribute("src"));
      if (source.type && source.type.includes("mpegurl")) {
        candidates.add(source.src || source.getAttribute("src"));
      }
    });

    for (const candidate of candidates) {
      const absolute = absolutify(candidate);
      if (absolute && absolute.toLowerCase().includes(".m3u8")) {
        return absolute;
      }
    }

    return null;
  };

  const reportVideo = (video) => {
    const candidate = extractCandidate(video);
    if (!candidate || !shouldReport(candidate)) {
      return;
    }
    const payload = buildPayload(video, candidate);
    remember(candidate);

    chrome.runtime
      .sendMessage({ type: "video-detected", payload })
      .catch(() => {});
  };

  const createPopup = (video, payload) => {
    const old = document.getElementById("idm-popup");
    if (old) old.remove();

    const popup = document.createElement("div");
    popup.id = "idm-popup";

    // ✅ Pre-position off-screen để tránh flash
    popup.style.cssText = `
      position: fixed !important;
      opacity: 0;
      top: -9999px;
      transition: opacity 0.15s ease-out;
    `;

    popup.innerHTML = `
      <div class="idm-body">
        <button class="idm-download">Download this video</button>
        <button class="idm-close">&times;</button>
      </div>
    `;

    document.body.appendChild(popup);

    // ✅ Dùng requestAnimationFrame để đồng bộ với browser rendering
    requestAnimationFrame(() => {
      if (video) {
        // ✅ Kiểm tra cache trước
        let rect = videoPositionCache.get(video);

        if (!rect || rect.width === 0) {
          rect = video.getBoundingClientRect();

          // Lưu vào cache
          if (rect.width > 0 && rect.height > 0) {
            videoPositionCache.set(video, rect);

            // Clear cache khi video thay đổi
            const clearCache = () => videoPositionCache.delete(video);
            video.addEventListener("fullscreenchange", clearCache, {
              once: true,
              passive: true,
            });
            window.addEventListener("resize", clearCache, {
              once: true,
              passive: true,
            });
          }
        }

        const offset = 10;

        if (rect.width > 0 && rect.height > 0) {
          // ✅ Đặt popup Ở TRONG video, góc phải trên (như IDM)
          popup.style.top = `${rect.top + window.scrollY + offset}px`;
          popup.style.left = `${rect.right + window.scrollX - 200}px`; // 200 = popup width + offset
        } else {
          // Video hidden hoặc 0x0, hiển thị góc phải trên màn hình
          popup.style.top = "20px";
          popup.style.right = "20px";
          popup.style.left = "auto";
        }
      } else {
        // Fallback: góc phải trên màn hình
        popup.style.top = "20px";
        popup.style.right = "20px";
        popup.style.left = "auto";
      }

      // ✅ Fade in smooth
      popup.style.opacity = "1";
    });

    popup.querySelector(".idm-download").onclick = async () => {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "download-video",
          payload: payload,
        });

        const btn = popup.querySelector(".idm-download");
        btn.textContent = "✓ Downloading...";
        btn.disabled = true;

        setTimeout(() => {
          popup.style.opacity = "0";
          setTimeout(() => popup.remove(), 150);
        }, 2000);
      } catch (error) {
        console.error("❌ Download failed:", error);

        const btn = popup.querySelector(".idm-download");
        btn.textContent = "✗ Failed";
        btn.style.background = "#dc3545";

        setTimeout(() => {
          btn.textContent = "Download this video";
          btn.style.background = "#0078d7";
          btn.disabled = false;
        }, 2000);
      }
    };

    popup.querySelector(".idm-close").onclick = () => {
      popup.style.opacity = "0";
      setTimeout(() => popup.remove(), 150);
    };
  };

  const bindVideo = (video) => {
    if (!(video instanceof HTMLVideoElement)) return;

    if (video.__m3u8WatcherBound) return;
    video.__m3u8WatcherBound = true;

    const handler = () => reportVideo(video);
    ["loadeddata", "loadedmetadata", "play", "playing", "canplay"].forEach(
      (event) => {
        video.addEventListener(event, handler, { passive: true });
      }
    );

    const attrObserver = new MutationObserver(() => reportVideo(video));
    attrObserver.observe(video, {
      attributes: true,
      attributeFilter: ["src", "data-src", "poster"],
    });
    video.__m3u8AttributeObserver = attrObserver;

    const sourcesObserver = new MutationObserver(() => reportVideo(video));
    sourcesObserver.observe(video, { childList: true, subtree: true });
    video.__m3u8SourcesObserver = sourcesObserver;

    reportVideo(video);
  };

  const scanExistingVideos = () => {
    document.querySelectorAll("video").forEach(bindVideo);
  };

  const globalObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof HTMLVideoElement) {
          bindVideo(node);
        } else if (node instanceof HTMLElement) {
          node.querySelectorAll?.("video").forEach(bindVideo);
        }
      });
    }
  });

  globalObserver.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
  });

  document.addEventListener("readystatechange", scanExistingVideos, {
    passive: true,
  });
  window.addEventListener("load", scanExistingVideos, { passive: true });
  document.addEventListener(
    "play",
    (event) => {
      if (event.target instanceof HTMLVideoElement) {
        bindVideo(event.target);
        reportVideo(event.target);
      }
    },
    { capture: true, passive: true }
  );

  scanExistingVideos();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "show-popup") {
      // Tìm video đang phát (nếu có)
      const videos = document.querySelectorAll("video");
      let activeVideo = null;

      for (const video of videos) {
        if (!video.paused || video.readyState >= 2) {
          activeVideo = video;
          break;
        }
      }

      createPopup(activeVideo, message.payload);
      sendResponse({ success: true });
    }

    return true;
  });
})();
