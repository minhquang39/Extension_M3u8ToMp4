(() => {
  const reported = new Set();
  const MAX_TRACKED = 200;

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
      pageUrl: window.location.href
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
      video.getAttribute("data-url")
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
    chrome.runtime.sendMessage({ type: "video-detected", payload }).catch(() => {});
  };

  const bindVideo = (video) => {
    if (!(video instanceof HTMLVideoElement)) return;
    if (video.__m3u8WatcherBound) return;
    video.__m3u8WatcherBound = true;

    const handler = () => reportVideo(video);
    ["loadeddata", "loadedmetadata", "play", "playing", "canplay"].forEach((event) => {
      video.addEventListener(event, handler, { passive: true });
    });

    const attrObserver = new MutationObserver(() => reportVideo(video));
    attrObserver.observe(video, { attributes: true, attributeFilter: ["src", "data-src", "poster"] });
    video.__m3u8AttributeObserver = attrObserver;

    const sourcesObserver = new MutationObserver(() => reportVideo(video));
    sourcesObserver.observe(video, { childList: true, subtree: true });
    video.__m3u8SourcesObserver = sourcesObserver;

    // Attempt immediately in case the src is already set
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
    subtree: true
  });

  document.addEventListener("readystatechange", scanExistingVideos, { passive: true });
  window.addEventListener("load", scanExistingVideos, { passive: true });
  document.addEventListener("play", (event) => {
    if (event.target instanceof HTMLVideoElement) {
      bindVideo(event.target);
      reportVideo(event.target);
    }
  }, { capture: true, passive: true });

  scanExistingVideos();
})();
