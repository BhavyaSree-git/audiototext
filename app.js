(() => {
  "use strict";

  const API_BASE = window.STUDIO_MDNS_PROXY === true ? window.location.origin : "http://esp32.local";
  const REQUEST_TIMEOUT = 8000;
  const $ = (selector, root = document) => root.querySelector(selector);
  const screens = {
    landing: $("#landing"),
    login: $("#login"),
    dashboard: $("#dashboard")
  };

  const state = {
    connected: false,
    recording: false,
    recordingPendingSave: false,
    recordingStartedAt: 0,
    elapsedBeforePause: 0,
    timer: null,
    files: [],
    transcriptions: new Map(),
    transcribing: new Map(),
    latestFile: null,
    page: "overview",
    deviceInfo: null
  };

  function showScreen(name) {
    Object.entries(screens).forEach(([key, screen]) => {
      screen.hidden = key !== name;
    });
    window.scrollTo(0, 0);
  }

  async function waitForTranscript(jobId) {
    const deadline = Date.now() + 60 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 3000));
      const result = await apiRequest(`/api/transcriptions/${encodeURIComponent(jobId)}`);
      if (result?.message) setLatestStatus(result.message, "working");
      if (result?.status === "completed") return result;
      if (result?.status === "failed") {
        throw new Error(result.error || "The transcription service could not process this recording.");
      }
      if (result?.status && result.status !== "processing" && result.status !== "queued") {
        throw new Error(`Unknown transcription job status: ${result.status}`);
      }
    }
    throw new Error("Transcription is taking longer than expected. Try again later.");
  }

  function toast(message, isError = false) {
    const item = document.createElement("div");
    item.className = `toast${isError ? " error" : ""}`;
    item.textContent = message;
    $("#toast-region").append(item);
    window.setTimeout(() => item.remove(), 4200);
  }

  function setConnected(connected, info = null) {
    if (!connected && state.recording) {
      state.recording = false;
      state.recordingPendingSave = false;
      window.clearInterval(state.timer);
      $("#recording-time").textContent = "00:00:00";
      $("#recording-tag").classList.remove("recording");
      $("#recording-tag").innerHTML = "<i></i> READY";
      $("#recording-help").textContent = "Device disconnected. Reconnect before recording.";
      $("#recording-visual").parentElement.classList.remove("is-recording");
      $("#sidebar-status-dot").classList.remove("recording");
    }
    state.connected = connected;
    state.deviceInfo = info;
    const dot = $("#connection-dot");
    dot.classList.toggle("connected", connected);
    $("#connection-label").textContent = connected ? "Connected" : "Offline";
    $("#sidebar-status-dot").classList.toggle("connected", connected);
    $("#sidebar-device-state").textContent = connected ? "Connected · esp32.local" : "Not connected";
    $("#stat-device").textContent = connected ? "Connected" : "Offline";
    $("#footer-device").textContent = `DEVICE · ${connected ? "CONNECTED" : "OFFLINE"}`;
    $("#banner-title").textContent = connected ? "Your recorder is connected" : "Your recorder is waiting";
    $("#banner-message").textContent = connected
      ? `Connected to ${info?.name || "ESP32 Recorder"} at esp32.local.`
      : `Connect to esp32.local to see your SD card and control your device.`;
    $("#stop-save-record").disabled = !connected || (!state.recording && !state.recordingPendingSave);
    $("#stop-save-record").querySelector("span").textContent = state.recordingPendingSave ? "Retry save" : "Stop & save";
    $("#start-record").disabled = !connected || state.recording || state.recordingPendingSave;
    $("#control-note").textContent = connected
      ? "Use the device controls to capture a new audio file."
      : "Connect your ESP32 to enable recording controls.";
  }

  function updateFiles(files) {
    state.files = Array.isArray(files) ? files.slice() : [];
    state.files.sort((left, right) => {
      const leftDate = Date.parse(left.createdAt || left.date || "");
      const rightDate = Date.parse(right.createdAt || right.date || "");
      return Number.isFinite(leftDate) && Number.isFinite(rightDate) ? rightDate - leftDate : 0;
    });
    $("#stat-recordings").textContent = String(state.files.length);
    $("#nav-count").textContent = String(state.files.length);
    $("#library-count").textContent = String(state.files.length);
    const recentFiles = $("#recent-files");
    const libraryFiles = $("#library-files");
    recentFiles.replaceChildren();
    libraryFiles.replaceChildren();
    $("#recent-empty").hidden = state.files.length > 0;
    $("#library-empty").hidden = state.files.length > 0;
    $("#stat-storage").textContent = formatStorage(state.deviceInfo);
    $("#storage-caption").textContent = state.deviceInfo?.storage
      ? `${formatBytes(state.deviceInfo.storage.used)} used of ${formatBytes(state.deviceInfo.storage.total)}`
      : "connect to see storage";

    state.files.forEach((file, index) => {
      const savedText = file.transcriptText || file.transcript || state.transcriptions.get(file.name);
      if (typeof savedText === "string" && savedText.trim()) state.transcriptions.set(file.name, savedText);
      const row = makeFileRow(file, index);
      libraryFiles.append(row);
      if (index < 3) recentFiles.append(makeFileRow(file, index, true));
    });
  }

  function formatStorage(info) {
    if (!info?.storage?.total) return "—";
    const used = Number(info.storage.used);
    const total = Number(info.storage.total);
    return Number.isFinite(used) && Number.isFinite(total) && total > 0
      ? `${Math.round((used / total) * 100)}%`
      : "—";
  }

  function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return "—";
    if (value < 1024) return `${value} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let size = value / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
  }

  function formatDate(date) {
    if (!date) return "—";
    const parsed = new Date(date);
    if (Number.isNaN(parsed.getTime())) return String(date);
    return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function deviceFileUrl(path) {
    const url = new URL(path, "http://esp32.local/");
    if (window.STUDIO_MDNS_PROXY === true && url.hostname === "esp32.local") {
      return `${API_BASE}${url.pathname}${url.search}`;
    }
    return url.href;
  }

  function makeFileRow(file, index, recent = false) {
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    const name = document.createElement("span");
    name.className = "file-name";
    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.innerHTML = '<svg aria-hidden="true"><use href="#i-file"></use></svg>';
    const textWrap = document.createElement("span");
    textWrap.append(document.createTextNode(file.name || "Recording"));
    const type = document.createElement("small");
    type.className = "file-type";
    type.textContent = `${file.name?.split(".").pop()?.toUpperCase() || "AUDIO"} · SD CARD`;
    textWrap.append(type);
    if (state.transcriptions.has(file.name) || file.transcriptText || file.transcript) {
      type.textContent += " · CONVERTED";
    }
    name.append(icon, textWrap);
    nameCell.append(name);
    row.append(nameCell, textCell(formatDate(file.createdAt || file.date)), textCell(file.duration || "—"), textCell(formatBytes(file.size)));
    const actionsCell = document.createElement("td");
    const actions = document.createElement("span");
    actions.className = "row-actions";
    const converted = state.transcriptions.has(file.name) || file.transcriptText || file.transcript;
    const transcribe = actionButton("i-text", converted ? "View text" : "Convert", "transcribe-action");
    transcribe.addEventListener("click", () => transcribeFile(file, index));
    const download = actionButton("i-download", "Download", "");
    download.addEventListener("click", () => downloadFile(file));
    const remove = actionButton("i-trash", "Delete", "delete");
    remove.addEventListener("click", () => deleteFile(file));
    actions.append(transcribe, download, remove);
    actionsCell.append(actions);
    row.append(actionsCell);
    return row;
  }

  function textCell(value) {
    const cell = document.createElement("td");
    cell.textContent = value || "—";
    return cell;
  }

  function actionButton(iconName, label, extraClass) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `row-action ${extraClass}`.trim();
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = `<svg aria-hidden="true"><use href="#${iconName}"></use></svg>${label}`;
    return button;
  }

  async function apiRequest(path, options = {}, timeoutMs = REQUEST_TIMEOUT) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          ...(options.body && !(options.body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
          ...options.headers
        }
      });
    } catch (error) {
      if (error.name === "AbortError") throw new Error("The ESP32 did not respond in time.");
      throw new Error(`Could not reach ${API_BASE}. Check Serial Monitor for "mDNS ready: http://esp32.local" and connect both devices to the same Wi-Fi. If the address works directly in your browser, check this page's local-network permission and whether an HTTPS page is blocking HTTP requests.`);
    } finally {
      window.clearTimeout(timeout);
    }
    if (!response.ok) {
      const contentType = response.headers.get("content-type") || "";
      let detail = "";
      if (contentType.includes("application/json")) {
        const payload = await response.json();
        detail = payload?.error || payload?.message || "";
      } else {
        detail = await response.text();
      }
      throw new Error(detail || `ESP32 request failed (${response.status}).`);
    }
    if (response.status === 204) return null;
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) return response.json();
    return response.text();
  }

  async function syncDevice() {
    if (state.recording || state.recordingPendingSave) {
      toast("Stop and save your recording before reconnecting.", true);
      return;
    }
    const connectionError = $("#connection-error");
    connectionError.hidden = true;
    const button = $("#sync-button");
    const label = button.querySelector("span");
    button.disabled = true;
    label.textContent = "Connecting…";
    let reachedDevice = false;
    try {
      const info = await apiRequest("/api/status");
      if (!info || typeof info !== "object" || !("storage" in info || "name" in info)) {
        throw new Error("esp32.local did not return valid device status. Check that esp32_audio_studio.ino is running on the recorder.");
      }
      reachedDevice = true;
      setConnected(true, info);
      const data = await apiRequest("/api/files");
      updateFiles(Array.isArray(data) ? data : data?.files);
      await autoTranscribeLatest();
      toast("Device connected and SD card synced.");
    } catch (error) {
      if (!reachedDevice) setConnected(false);
      updateFiles([]);
      connectionError.textContent = reachedDevice ? `Device connected, but SD card sync failed: ${error.message}` : error.message;
      connectionError.hidden = false;
      toast(connectionError.textContent, true);
    } finally {
      button.disabled = false;
      label.textContent = "Sync device";
    }
  }

  async function deviceCommand(path, successMessage) {
    if (!state.connected) {
      toast("Connect your ESP32 before using device controls.", true);
      return false;
    }
    try {
      await apiRequest(path, { method: "POST" });
      toast(successMessage);
      return true;
    } catch (error) {
      toast(error.message, true);
      return false;
    }
  }

  async function startRecording() {
    if (state.recordingPendingSave) {
      toast("Save the stopped recording before starting another one.", true);
      return;
    }
    if (!(await deviceCommand("/api/record/start", "Recording started."))) return;
    state.recording = true;
    state.recordingPendingSave = false;
    state.recordingStartedAt = Date.now();
    $("#recording-tag").classList.add("recording");
    $("#recording-tag").innerHTML = "<i></i> RECORDING";
    $("#recording-help").textContent = "Take your time. Every word is being captured.";
    $("#sidebar-status-dot").classList.add("recording");
    $("#start-record").disabled = true;
    $("#stop-save-record").disabled = false;
    $("#stop-save-record").querySelector("span").textContent = "Stop & save";
    $("#recording-visual").parentElement.classList.add("is-recording");
    state.timer = window.setInterval(updateRecordingTimer, 1000);
    updateRecordingTimer();
  }

  function updateRecordingTimer() {
    const seconds = Math.floor((Date.now() - state.recordingStartedAt + state.elapsedBeforePause) / 1000);
    const hours = String(Math.floor(seconds / 3600)).padStart(2, "0");
    const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
    const remainder = String(seconds % 60).padStart(2, "0");
    $("#recording-time").textContent = `${hours}:${minutes}:${remainder}`;
  }

  async function stopAndSaveRecording() {
    const button = $("#stop-save-record");
    button.disabled = true;
    if (state.recording) {
      try {
        await apiRequest("/api/record/stop", { method: "POST" });
      } catch (error) {
        button.disabled = false;
        toast(`Could not stop recording: ${error.message}`, true);
        return;
      }
      state.recording = false;
      state.recordingPendingSave = true;
      window.clearInterval(state.timer);
      $("#recording-visual").parentElement.classList.remove("is-recording");
      $("#sidebar-status-dot").classList.remove("recording");
    }
    try {
      await apiRequest("/api/record/save", { method: "POST" });
    } catch (error) {
      button.disabled = false;
      button.querySelector("span").textContent = "Retry save";
      $("#recording-tag").classList.remove("recording");
      $("#recording-tag").innerHTML = "<i></i> SAVE FAILED";
      $("#recording-help").textContent = "Recording stopped but could not be saved. Retry to save it.";
      $("#start-record").disabled = true;
      toast(`Recording stopped but could not be saved: ${error.message}`, true);
      return;
    }
    state.recordingPendingSave = false;
    $("#recording-tag").classList.remove("recording");
    $("#recording-tag").innerHTML = "<i></i> READY";
    $("#recording-help").textContent = "Saved. Converting your latest recording to Kannada.";
    $("#recording-time").textContent = "00:00:00";
    $("#recording-visual").parentElement.classList.remove("is-recording");
    $("#sidebar-status-dot").classList.remove("recording");
    setConnected(state.connected, state.deviceInfo);
    button.querySelector("span").textContent = "Stop & save";
    try {
      const data = await apiRequest("/api/files");
      updateFiles(Array.isArray(data) ? data : data?.files);
      toast("Recording saved. Converting the latest audio to Kannada.");
      await autoTranscribeLatest();
    } catch (error) {
      $("#recording-help").textContent = "Saved, but the latest recording could not be loaded.";
      toast(`Recording saved, but the file list could not be refreshed: ${error.message}`, true);
    } finally {
      button.disabled = !state.connected;
    }
  }

  function latestFile() {
    return state.files[0] || null;
  }

  async function autoTranscribeLatest() {
    const file = latestFile();
    if (!file) return;
    const transcript = file.transcriptText || file.transcript || state.transcriptions.get(file.name);
    if (typeof transcript === "string" && transcript.trim()) {
      state.transcriptions.set(file.name, transcript);
      await showLatestRecording(file, transcript);
      return;
    }
    await transcribeFile(file, 0);
  }

  async function showLatestRecording(file, transcript = "") {
    if (!file) return;
    state.latestFile = file;
    $("#latest-result").hidden = false;
    $("#latest-title").textContent = "Raw and enhanced audio";
    $("#latest-filename").textContent = file.name || "Latest recording";
    $("#raw-audio-label").textContent = `${file.channels || 4}-microphone array · Original audio`;
    $("#enhanced-audio-label").textContent = file.enhancement || "Beamformed · Noise reduced";
    $("#enhancement-tag").textContent = Number.isFinite(Number(file.snrGainDb))
      ? `+${Number(file.snrGainDb).toFixed(1)} dB SNR`
      : "ENHANCED";
    $("#latest-duration").textContent = file.duration || "—";
    const rawAudio = $("#raw-audio");
    const enhancedAudio = $("#enhanced-audio");
    rawAudio.hidden = false;
    enhancedAudio.hidden = false;
    rawAudio.src = deviceFileUrl(file.rawUrl || `/api/files/${encodeURIComponent(file.name)}/download`);
    enhancedAudio.src = deviceFileUrl(file.enhancedUrl || `/api/files/${encodeURIComponent(file.name)}/enhanced`);
    rawAudio.load();
    enhancedAudio.load();
    if (transcript) {
      $("#latest-transcript-text").textContent = transcript;
      setLatestStatus("Converted successfully to Kannada", "success");
      $("#latest-title").textContent = "Converted successfully";
    } else {
      $("#latest-transcript-text").textContent = "Your complete Kannada transcript will appear here after conversion.";
      setLatestStatus("Waiting for conversion", "waiting");
    }
  }

  function setLatestStatus(message, status) {
    $("#latest-status-text").textContent = message;
    const badge = $("#conversion-badge");
    badge.querySelector("span").textContent = status === "working" ? "Converting…" : status === "success" ? "CONVERTED" : status === "failed" ? "FAILED" : "Waiting";
    badge.classList.toggle("success", status === "success");
    badge.classList.toggle("working", status === "working");
    badge.classList.toggle("failed", status === "failed");
  }

  async function downloadFile(file) {
    if (!state.connected) {
      toast("Connect your ESP32 before downloading a file.", true);
      return;
    }
    const link = document.createElement("a");
    link.href = `${API_BASE}/api/files/${encodeURIComponent(file.name)}/download`;
    link.download = file.name;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
  }

  async function deleteFile(file) {
    if (!window.confirm(`Delete "${file.name}" from the SD card? This cannot be undone.`)) return;
    try {
      await apiRequest(`/api/files/${encodeURIComponent(file.name)}`, { method: "DELETE" });
      updateFiles(state.files.filter((item) => item.name !== file.name));
      state.transcriptions.delete(file.name);
      if (state.latestFile?.name === file.name) {
        state.latestFile = null;
        $("#latest-result").hidden = true;
      }
      toast("Recording deleted from the SD card.");
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function uploadAudio(file) {
    if (!file) return;
    if (!file.type.startsWith("audio/") && !/\.(wav|mp3|m4a|aac|flac|ogg)$/i.test(file.name)) {
      toast("Choose a supported audio file (WAV, MP3, M4A, AAC, FLAC, or OGG).", true);
      return;
    }
    if (!state.connected) {
      toast("Connect and sync your ESP32 before uploading audio.", true);
      return;
    }
    const button = $("#upload-audio-button");
    button.disabled = true;
    button.querySelector("span")?.remove();
    button.lastChild.textContent = "Uploading…";
    try {
      const formData = new FormData();
      formData.append("file", file, file.name);
      const result = await apiRequest("/api/files", { method: "POST", body: formData }, 120000);
      const data = await apiRequest("/api/files");
      updateFiles(Array.isArray(data) ? data : data?.files);
      const uploadedName = result?.name || result?.file?.name || file.name;
      const uploadedIndex = state.files.findIndex((item) => item.name === uploadedName);
      if (uploadedIndex === -1) {
        throw new Error("The upload was accepted, but the file is missing from the SD card list.");
      }
      toast("Audio uploaded to the SD card. Starting Kannada conversion.");
      await transcribeFile(state.files[uploadedIndex], uploadedIndex);
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.disabled = false;
      button.innerHTML = '<svg><use href="#i-arrow"></use></svg>Upload audio';
      $("#audio-upload-input").value = "";
    }
  }

  async function transcribeFile(file, index) {
    const cachedText = file.transcriptText || file.transcript || state.transcriptions.get(file.name);
    if (typeof cachedText === "string" && cachedText.trim()) {
      state.transcriptions.set(file.name, cachedText);
      setPage("overview");
      await showLatestRecording(file, cachedText);
      return;
    }
    if (!state.connected) {
      toast("Connect your ESP32 before transcribing a recording.", true);
      return;
    }
    const button = $("#library-files").rows[index]?.querySelector(".transcribe-action");
    setPage("overview");
    await showLatestRecording(file);
    setLatestStatus("Converting the complete audio to Kannada…", "working");
    $("#latest-transcript-text").textContent = "Listening to the complete recording. Your Kannada transcript will appear here when conversion is finished.";
    $("#latest-title").textContent = "Converting latest audio";
    if (button) {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
    }
    try {
      const result = await apiRequest(`/api/files/${encodeURIComponent(file.name)}/transcribe`, { method: "POST" }, 30000);
      let transcript = result;
      if (result && typeof result === "object" && result.jobId) {
        transcript = await waitForTranscript(result.jobId);
      }
      const text = typeof transcript === "string" ? transcript : transcript?.text;
      if (typeof text !== "string" || !text.trim()) {
        throw new Error("The transcription service returned no text.");
      }
      state.transcriptions.set(file.name, text);
      await showLatestRecording(file, text);
      updateFiles(state.files);
    } catch (error) {
      setLatestStatus("Conversion failed", "failed");
      $("#latest-transcript-text").textContent = error.message;
      $("#latest-title").textContent = "Conversion could not be completed";
      toast(error.message, true);
    } finally {
      if (button) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
    }
  }

  function showTranscript(filename, text) {
    $("#transcript-filename").textContent = filename;
    $("#transcript-content").textContent = text;
    $("#transcript-backdrop").hidden = false;
    $("#close-transcript").focus();
  }

  function setPage(page) {
    state.page = page;
    $("#overview-view").hidden = page !== "overview";
    $("#recordings-view").hidden = page !== "recordings";
    $("#breadcrumb-page").textContent = page === "overview" ? "Overview" : "Recordings";
    document.querySelectorAll(".side-link").forEach((link) => {
      link.classList.toggle("active", link.dataset.nav === page);
    });
    $("#sidebar").classList.remove("open");
  }

  function openDashboard() {
    state.recording = false;
    state.recordingPendingSave = false;
    state.transcriptions.clear();
    setConnected(false);
    updateFiles([]);
    showScreen("dashboard");
    setPage("overview");
    $("#latest-result").hidden = true;
    $("#language-status").textContent = "READY";
  }

  document.querySelectorAll("[data-go-login]").forEach((button) => {
    button.addEventListener("click", () => showScreen("login"));
  });
  document.querySelectorAll("[data-go-home]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      showScreen("landing");
    });
  });
  document.querySelectorAll("[data-nav]").forEach((button) => {
    button.addEventListener("click", () => setPage(button.dataset.nav));
  });
  $("#login-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const error = $("#login-error");
    if (formData.get("username") === "admin" && formData.get("password") === "admin") {
      error.hidden = true;
      event.currentTarget.reset();
      openDashboard();
      return;
    }
    error.textContent = "That username or password doesn't match. Please try again.";
    error.hidden = false;
  });
  $("#logout-button").addEventListener("click", () => {
    state.connected = false;
    state.recording = false;
    state.recordingPendingSave = false;
    window.clearInterval(state.timer);
    showScreen("landing");
  });
  $("#sync-button").addEventListener("click", syncDevice);
  $("#sidebar-connect").addEventListener("click", syncDevice);
  $("#library-sync").addEventListener("click", syncDevice);
  $("#upload-audio-button").addEventListener("click", () => $("#audio-upload-input").click());
  $("#audio-upload-input").addEventListener("change", (event) => {
    uploadAudio(event.currentTarget.files?.[0]);
  });
  $("#start-record").addEventListener("click", startRecording);
  $("#stop-save-record").addEventListener("click", stopAndSaveRecording);
  $("#mobile-menu").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
  $("#close-transcript").addEventListener("click", () => { $("#transcript-backdrop").hidden = true; });
  $("#transcript-backdrop").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) event.currentTarget.hidden = true;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") $("#transcript-backdrop").hidden = true;
  });
  $("#copy-transcript").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("#transcript-content").textContent);
      toast("Transcript copied to clipboard.");
    } catch {
      toast("Could not copy the transcript. Select and copy the text instead.", true);
    }
  });
  $("#copy-latest-transcript").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("#latest-transcript-text").textContent);
      toast("Kannada transcript copied.");
    } catch {
      toast("Could not copy the transcript. Select and copy the text instead.", true);
    }
  });
  $("#download-latest-transcript").addEventListener("click", () => {
    if (!state.latestFile) return;
    const blob = new Blob([$("#latest-transcript-text").textContent], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${state.latestFile.name.replace(/\.[^.]+$/, "")}.kn.txt`;
    link.click();
    URL.revokeObjectURL(url);
  });

  $("#header-date").textContent = new Date().toLocaleDateString(undefined, {
    weekday: "short", month: "short", day: "numeric"
  });
  const visual = $("#recording-visual");
  for (let index = 0; index < 51; index += 1) {
    const bar = document.createElement("span");
    bar.style.setProperty("--h", `${8 + ((index * 17) % 29)}px`);
    visual.append(bar);
  }
})();
