const form = document.getElementById("settingsForm");
const nativeHostInput = document.getElementById("nativeHost");
const showNotificationsInput = document.getElementById("showNotifications");
const retentionHoursInput = document.getElementById("retentionHours");
const statusBox = document.getElementById("status");

function showStatus(message, type = "success") {
  statusBox.textContent = message;
  statusBox.hidden = false;
  statusBox.style.background =
    type === "error" ? "rgba(239, 68, 68, 0.2)" : "rgba(34, 197, 94, 0.2)";
  statusBox.style.borderColor =
    type === "error" ? "rgba(239, 68, 68, 0.6)" : "rgba(34, 197, 94, 0.6)";
}

async function loadSettings() {
  const settings = await chrome.runtime.sendMessage({ type: "get-settings" });
  nativeHostInput.value = settings.nativeHost ?? "";
  showNotificationsInput.checked = Boolean(settings.showNotifications);
  retentionHoursInput.value = Math.max(
    1,
    Math.round(settings.retentionHours ?? 24)
  );
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    nativeHost: nativeHostInput.value.trim(),
    showNotifications: showNotificationsInput.checked,
    retentionHours: Math.max(1, Number(retentionHoursInput.value) || 1),
  };

  try {
    await chrome.runtime.sendMessage({ type: "update-settings", payload });
    showStatus("Settings saved successfully.");
  } catch (error) {
    console.error(error);
    showStatus(error?.message ?? "Failed to save settings.", "error");
  }
});

loadSettings().catch((error) => {
  console.error(error);
  showStatus(error?.message ?? "Failed to load settings.", "error");
});
