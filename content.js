(() => {
  const reported = new Set();
  const MAX_TRACKED = 200;
  const payload = null;
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
    console.log(payload);
    const old = document.getElementById("idm-popup");

    if (old) old.remove();

    const popup = document.createElement("div");
    popup.id = "idm-popup";
    popup.innerHTML = `
      <div class="idm-body">
        <button class="idm-download">Download this video</button>
        <button class="idm-close">&times;</button>
      </div>
    `;
    document.body.appendChild(popup);

    const rect = video.getBoundingClientRect();
    const offset = 10;

    popup.style.top = `${rect.top + window.scrollY + offset}px`;
    popup.style.left = `${rect.right + window.scrollX - 180 - offset}px`;

    // if (video) {
    //   const rect = video.getBoundingClientRect();
    //   const offset = 10;

    //   if (rect.width > 0 && rect.height > 0) {
    //     popup.style.top = `${rect.top + window.scrollY + offset}px`;
    //     popup.style.left = `${rect.right + window.scrollX - 180 - offset}px`;
    //   } else {
    //     popup.style.top = "20px";
    //     popup.style.right = "20px";
    //   }
    // } else {
    //   // Không có video element, hiển thị góc phải trên
    //   popup.style.top = "20px";
    //   popup.style.right = "20px";
    // }

    popup.querySelector(".idm-download").onclick = async () => {
      console.log("📥 Download button clicked, payload:", payload);

      try {
        // Gửi message về background để gọi sendToNative
        const response = await chrome.runtime.sendMessage({
          type: "download-video",
          payload: payload,
        });

        console.log("✅ Download initiated:", response);

        const btn = popup.querySelector(".idm-download");
        const originalText = btn.textContent;
        btn.textContent = "✓ Downloading...";
        btn.disabled = true;

        // setTimeout(() => popup.remove(), 2000);
      } catch (error) {
        console.error("❌ Download failed:", error);

        // Hiển thị lỗi
        const btn = popup.querySelector(".idm-download");
        btn.textContent = "✗ Failed";
        btn.style.background = "#dc3545";

        setTimeout(() => {
          btn.textContent = "Download this video";
          btn.style.background = "#0078d7";
        }, 2000);
      }
    };

    popup.querySelector(".idm-close").onclick = () => popup.remove();
  };

  const bindVideo = (video) => {
    if (!(video instanceof HTMLVideoElement)) return;

    if (video.__m3u8WatcherBound) return;
    video.__m3u8WatcherBound = true;

    const rect = video.getBoundingClientRect();
    console.log(rect);

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
    // Attempt immediately in case the src is already set
    reportVideo(video);
    // createPopup(video);
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
    console.log("📨 Message received:", message);

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
