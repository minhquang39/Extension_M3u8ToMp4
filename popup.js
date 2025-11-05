const clearAllBtn = document.getElementById("clearAll");
async function getLinks() {
  return chrome.runtime.sendMessage({ type: "get-links" });
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

function getThumbnailText(entry) {
  const source = (entry.tabTitle || getHostname(entry.pageUrl) || "HLS").trim();
  return source.slice(0, 2).toUpperCase();
}

function formatDetectedAgo(timestamp) {
  if (!timestamp) return "Just now";
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  if (hours >= 1) {
    return `${hours}h ago`;
  }
  if (minutes >= 1) {
    return `${minutes}m ago`;
  }
  return "Just now";
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDateTime(timestamp) {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function render() {
  const links = await getLinks();
  const linksList = document.getElementById("links");
  const errorBox = document.getElementById("error");

  linksList.innerHTML = "";
  errorBox.hidden = true;
  errorBox.textContent = "";

  if (!links.length) {
    linksList.innerHTML = `
      <li class="empty-placeholder">
        <div class="empty-placeholder__title">No captures yet</div>
        <div class="empty-placeholder__caption">Start an HLS stream and the link will appear here automatically.</div>
      </li>
    `;
    return;
  }

  for (const entry of links) {
    const li = document.createElement("li");
    li.className = "link-item";

    const tabTitle = escapeHtml(entry.tabTitle ?? "Unknown stream");
    const pageUrl = escapeHtml(entry.pageUrl ?? "");
    const hostname = escapeHtml(getHostname(entry.pageUrl ?? entry.url));
    const detectedAgo = escapeHtml(formatDetectedAgo(entry.detectedAt));
    const detectedTime = escapeHtml(formatTime(entry.detectedAt));
    const detectedDisplay = escapeHtml(formatDateTime(entry.detectedAt));
    const methodRaw = (entry.method ?? "GET").toUpperCase();
    const methodLabel = escapeHtml(methodRaw);
    const url = escapeHtml(entry.url);
    const thumbText = escapeHtml(getThumbnailText(entry));
    const previewUrl = escapeHtml(entry.previewImage ?? "");
    const isM3u8 = entry.url?.toLowerCase().includes(".m3u8");
    const primaryBadge = escapeHtml(isM3u8 ? "M3U8" : methodRaw);
    const thumbnailMarkup = previewUrl
      ? `<div class="thumbnail has-image"><img src="${previewUrl}" alt="Preview" /></div>`
      : `<div class="thumbnail">${thumbText}</div>`;

    li.innerHTML = `
      <div class="link-top">
        ${thumbnailMarkup}
        <div class="meta">
          <div class="badge-row">
            <span class="badge badge-primary">${primaryBadge}</span>
            <span class="badge badge-muted">${methodLabel}</span>
            <span class="badge badge-muted" title="${detectedTime}">${detectedAgo}</span>
          </div>
          <h3 title="${tabTitle}">${tabTitle}</h3>
          <div class="page-url" title="${pageUrl}">${hostname}</div>
          <div class="capture-time">Captured ${detectedDisplay}</div>
        </div>
      </div>
      <div class="link-actions">
      <button class="primary send">Download</button>
      <button class="ghost copy" title="Copy link">Copy</button>
      </div>
      `;
    //   <div class="link-url" title="${url}">${url}</div>

    const [sendBtn, copyBtn] = li.querySelectorAll("button");
    sendBtn.addEventListener("click", async () => {
      console.log("Download..." + entry.url);
      try {
        await chrome.runtime.sendMessage({
          type: "resend-link",
          payload: entry,
        });
      } catch (error) {
        errorBox.textContent = error?.message ?? String(error);
        errorBox.hidden = false;
      }
    });

    copyBtn.dataset.originalLabel = copyBtn.textContent;
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(entry.url);
        errorBox.hidden = true;
        errorBox.textContent = "";
        showCopyFeedback(copyBtn);
      } catch (error) {
        errorBox.textContent =
          "Failed to copy URL. Check clipboard permissions.";
        errorBox.hidden = false;
        resetCopyFeedback(copyBtn);
      }
    });

    linksList.appendChild(li);
  }

  if (clearAllBtn && !clearAllBtn.dataset.bound) {
    clearAllBtn.dataset.bound = "true";
    clearAllBtn.addEventListener("click", handleClearAll);
  }
}

document.getElementById("refresh").addEventListener("click", render);

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "links-updated") {
    render().catch(console.error);
  }
  if (message?.type === "native-error") {
    const errorBox = document.getElementById("error");
    errorBox.textContent = message.payload;
    errorBox.hidden = false;
  }
});

render().catch((error) => {
  const errorBox = document.getElementById("error");
  errorBox.textContent = error?.message ?? String(error);
  errorBox.hidden = false;
});

async function handleClearAll() {
  const errorBox = document.getElementById("error");
  errorBox.hidden = true;

  if (!clearAllBtn) {
    return;
  }

  // if (!confirm("Delete all captured links? This action cannot be undone.")) {
  //   return;
  // }

  try {
    clearAllBtn.disabled = true;
    const response = await chrome.runtime.sendMessage({ type: "clear-links" });
    if (!response?.ok) {
      throw new Error(response?.error ?? "Failed to delete captured links.");
    }
    await render();
  } catch (error) {
    console.error(error);
    errorBox.textContent = error?.message ?? "Failed to delete captured links.";
    errorBox.hidden = false;
  } finally {
    clearAllBtn.disabled = false;
  }
}

function showCopyFeedback(button) {
  if (!button) return;
  const originalLabel = button.dataset.originalLabel || "Copy";
  button.textContent = "Copied";
  button.classList.add("copied", "show-tooltip");
  button.setAttribute("data-tooltip", "Copied!");

  if (button.__copyResetTimeout) {
    clearTimeout(button.__copyResetTimeout);
  }

  button.__copyResetTimeout = setTimeout(() => {
    resetCopyFeedback(button, originalLabel);
  }, 1200);
}

function resetCopyFeedback(button, label = "Copy") {
  if (!button) return;
  button.textContent = label;
  button.classList.remove("copied", "show-tooltip");
  button.removeAttribute("data-tooltip");
  if (button.__copyResetTimeout) {
    clearTimeout(button.__copyResetTimeout);
    button.__copyResetTimeout = null;
  }
}
