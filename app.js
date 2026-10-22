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
    selection: 0,
    controlBusy: false,
    page: "overview",
    deviceInfo: null
  };

  function showScreen(name) {
    Object.entries(screens).forEach(([key, screen]) => {
      screen.hidden = key !== name;
    });
    window.scrollTo(0, 0);
  }

  async function waitForTranscript(jobId, onProgress = () => {}) {
    const deadline = Date.now() + 60 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 3000));
      const result = await apiRequest(`/api/transcriptions/${encodeURIComponent(jobId)}`);
      onProgress(result);
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
    window.setTimeout(() => item.remove(), isError ? 12000 : 6500);
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
    $("#start-record").disabled = !connected || state.recording || state.recordingPendingSave || info?.sdReady === false || info?.i2sReady === false;
    $("#control-note").textContent = connected
      ? "Use the device controls to capture a new audio file."
      : "Connect your ESP32 to enable recording controls.";
  }

  function updateFiles(files) {
    state.files = Array.isArray(files) ? files.filter(file => !file.name.startsWith("._")) : [];
    /* The device supplies newest first, including its last saved/uploaded file. */
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
    if (state.transcriptions.has(`${file.name}:${file.size}`)) {
      type.textContent += " · CONVERTED";
    }
    name.append(icon, textWrap);
    nameCell.append(name);
    row.append(nameCell, textCell(formatDate(file.createdAt || file.date)), textCell(file.duration || "—"), textCell(formatBytes(file.size)));
    const actionsCell = document.createElement("td");
    const actions = document.createElement("span");
    actions.className = "row-actions";
    const transcribe = actionButton("i-text", "Convert", "transcribe-action");
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
      if (info.recording) {
        beginRecordingDisplay();
        toast("ESP32 is already recording. Use Stop & save to finish.");
        return;
      }
      const data = await apiRequest("/api/files");
      updateFiles(Array.isArray(data) ? data : data?.files);
      toast(`Connected to esp32.local. ${state.files.length} audio file(s) loaded from the SD card.`);
      void autoTranscribeLatest();
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

  function beginRecordingDisplay() {
    state.recording = true;
    state.recordingPendingSave = false;
    state.recordingStartedAt = Date.now() - (state.deviceInfo?.recordingMs || 0);
    state.elapsedBeforePause = 0;
    window.clearInterval(state.timer);
    $("#recording-tag").classList.add("recording");
    $("#recording-tag").innerHTML = "<i></i> RECORDING";
    $("#recording-help").textContent = "ESP32 is recording to the SD card. LED: green.";
    $("#sidebar-status-dot").classList.add("recording");
    $("#start-record").disabled = true;
    $("#stop-save-record").disabled = false;
    $("#stop-save-record").querySelector("span").textContent = "Stop & save";
    $("#recording-visual").parentElement.classList.add("is-recording");
    state.timer = window.setInterval(updateRecordingTimer, 1000);
    updateRecordingTimer();
  }

  async function startRecording() {
    if (state.controlBusy || state.recording) return;
    if (!state.connected || state.recordingPendingSave) {
      toast(state.recordingPendingSave ? "Save the stopped recording first." : "Connect the ESP32 first.", true);
      return;
    }
    state.controlBusy = true;
    $("#start-record").disabled = true;
    try {
      const result = await apiRequest("/api/record/start", { method: "POST" });
      if (!result?.recording) throw new Error("ESP32 did not confirm that recording started.");
      beginRecordingDisplay();
      toast(`Recording started on ESP32${result.file ? `: ${result.file}` : ""}.`);
    } catch (error) {
      toast(`Recording did not start: ${error.message}`, true);
      $("#start-record").disabled = !state.connected;
    } finally {
      state.controlBusy = false;
    }
  }

  function updateRecordingTimer() {
    const seconds = Math.floor((Date.now() - state.recordingStartedAt + state.elapsedBeforePause) / 1000);
    const hours = String(Math.floor(seconds / 3600)).padStart(2, "0");
    const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
    const remainder = String(seconds % 60).padStart(2, "0");
    $("#recording-time").textContent = `${hours}:${minutes}:${remainder}`;
  }

  async function stopAndSaveRecording() {
    if (state.controlBusy || (!state.recording && !state.recordingPendingSave)) return;
    state.controlBusy = true;
    let savedFileName = null;
    const button = $("#stop-save-record");
    button.disabled = true;
    if (state.recording) {
      try {
        const stopped = await apiRequest("/api/record/stop", { method: "POST" });
        if (stopped?.recording !== false) throw new Error("ESP32 did not confirm that recording stopped.");
      } catch (error) {
        button.disabled = false;
        state.controlBusy = false;
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
      const saved = await apiRequest("/api/record/save", { method: "POST" });
      if (!saved?.saved || !saved.file) throw new Error("ESP32 did not confirm a saved filename.");
      savedFileName = saved.file;
    } catch (error) {
      button.disabled = false;
      button.querySelector("span").textContent = "Retry save";
      $("#recording-tag").classList.remove("recording");
      $("#recording-tag").innerHTML = "<i></i> SAVE FAILED";
      $("#recording-help").textContent = "Recording stopped but could not be saved. Retry to save it.";
      $("#start-record").disabled = true;
      state.controlBusy = false;
      toast(`Recording stopped but could not be saved: ${error.message}`, true);
      return;
    }
    state.recordingPendingSave = false;
    $("#recording-tag").classList.remove("recording");
    $("#recording-tag").innerHTML = "<i></i> READY";
    $("#recording-help").textContent = "Saved to the SD card. Preparing playback and transcription.";
    $("#recording-time").textContent = "00:00:00";
    $("#recording-visual").parentElement.classList.remove("is-recording");
    $("#sidebar-status-dot").classList.remove("recording");
    setConnected(state.connected, state.deviceInfo);
    button.querySelector("span").textContent = "Stop & save";
    try {
      const data = await apiRequest("/api/files");
      updateFiles(Array.isArray(data) ? data : data?.files);
      const savedFile = state.files.find(file => file.name === savedFileName);
      if (!savedFile) throw new Error("The saved recording is missing from the refreshed SD-card list.");
      toast(`${savedFileName} saved to the SD card. Conversion is starting.`);
      void transcribeFile(savedFile);
    } catch (error) {
      $("#recording-help").textContent = "Saved, but the latest recording could not be loaded.";
      toast(`Recording saved, but the file list could not be refreshed: ${error.message}`, true);
    } finally {
      state.controlBusy = false;
      setConnected(state.connected, state.deviceInfo);
    }
  }

  function latestFile() {
    return state.files[0] || null;
  }

  async function autoTranscribeLatest() {
    const file = latestFile();
    if (!file) return;
    await transcribeFile(file);
  }

  function applyPlayback(file) {
    const raw = $("#raw-audio"), clear = $("#enhanced-audio");
    const rawUrl = deviceFileUrl(file.rawUrl || `/api/files/${encodeURIComponent(file.name)}/download`);
    if (raw.src !== rawUrl) { raw.src = rawUrl; raw.load(); }
    $("#raw-audio-label").textContent = file.selectedChannel
      ? `Original microphone ${file.selectedChannel} of ${file.channels} ? No noise reduction`
      : "Original SD-card audio";
    $("#raw-channel-tag").textContent = file.channels ? `${file.channels} CH` : "RAW";
    if (file.enhancedUrl) {
      const clearUrl = deviceFileUrl(file.enhancedUrl);
      if (clear.src !== clearUrl) { clear.src = clearUrl; clear.load(); }
      clear.hidden = false;
      $("#clear-audio-status").textContent = "Noise-reduced playback is ready. Compare it with the original.";
    } else {
      clear.pause(); clear.removeAttribute("src"); clear.load(); clear.hidden = true;
      $("#clear-audio-status").textContent = "Clear audio will be available after audio processing.";
    }
    $("#enhanced-audio-label").textContent = file.enhancement || "Noise reduction pending";
    $("#enhancement-tag").textContent = file.enhancedUrl ? "PROCESSED" : "WAITING";
    $("#latest-duration").textContent = file.durationSeconds ? `${file.durationSeconds.toFixed(1)} seconds` : file.duration || "?";
  }

  async function showLatestRecording(file, transcript = "") {
    if (!file) return;
    state.latestFile = file;
    $("#latest-result").hidden = false;
    $("#latest-title").textContent = "Recording and transcript";
    $("#latest-filename").textContent = file.name;
    applyPlayback(file);
    $("#latest-transcript-text").textContent = transcript || "Preparing this recording. Recognized speech will appear here.";
    $("#copy-latest-transcript").disabled = !transcript;
    $("#download-latest-transcript").disabled = !transcript;
    setLatestStatus(transcript ? "Transcription ready ? review against the audio" : "Preparing recording", transcript ? "success" : "working");
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
    if (!state.connected || state.recording) {
      toast("Connect the ESP32 and stop recording before downloading a file.", true);
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
    if (state.recording) { toast("Stop and save the active recording before deleting files.", true); return; }
    if (!window.confirm(`Delete "${file.name}" from the SD card? This cannot be undone.`)) return;
    try {
      await apiRequest(`/api/files/${encodeURIComponent(file.name)}`, { method: "DELETE" });
      updateFiles(state.files.filter((item) => item.name !== file.name));
      for (const key of state.transcriptions.keys()) { if (key.startsWith(`${file.name}:`)) state.transcriptions.delete(key); }
      if (state.latestFile?.name === file.name) {
        state.selection += 1;
        state.latestFile = null;
        $("#latest-result").hidden = true;
      }
      toast(`${file.name} deleted from the SD card.`);
      const data = await apiRequest("/api/files");
      updateFiles(Array.isArray(data) ? data : data?.files);
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
      toast("Audio uploaded to the SD card. Starting speech recognition.");
      await transcribeFile(state.files[uploadedIndex], uploadedIndex);
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.disabled = false;
      button.innerHTML = '<svg><use href="#i-arrow"></use></svg>Upload audio';
      $("#audio-upload-input").value = "";
    }
  }

  async function transcribeFile(file) {
    if (!state.connected || state.recording || state.recordingPendingSave) {
      toast("Connect the ESP32 and stop/save any active recording before converting.", true);
      return;
    }
    const selection = ++state.selection;
    const key = `${file.name}:${file.size}`;
    const selected = () => state.selection === selection && state.latestFile?.name === file.name && state.files.some(item => item.name === file.name);
    setPage("overview");
    await showLatestRecording(file);
    const showProgress = result => {
      if (!selected()) return;
      if (result.audio) { Object.assign(file, result.audio); applyPlayback(file); }
      if (result.message) setLatestStatus(result.message, "working");
    };
    try {
      let result = state.transcriptions.get(key);
      if (!result) {
        let task = state.transcribing.get(key);
        if (!task) {
          task = (async () => {
            const started = await apiRequest(`/api/files/${encodeURIComponent(file.name)}/transcribe`, { method: "POST" }, 30000);
            return started.jobId ? waitForTranscript(started.jobId, progress => {
              const active = state.transcribing.get(key);
              active?.progress?.(progress);
            }) : started;
          })();
          state.transcribing.set(key, task);
          task.finally(() => state.transcribing.delete(key)).catch(() => {});
        }
        task.progress = showProgress;
        result = await task;
        if (!result?.text?.trim()) throw new Error("No reliable speech was recognized in this recording.");
        if (!state.files.some(item => item.name === file.name)) return;
        state.transcriptions.set(key, result);
      }
      if (!selected()) return;
      Object.assign(file, result.audio || {});
      await showLatestRecording(file, result.text);
      $("#transcript-language").textContent = "Kannada text";
      $("#latest-transcript-text").lang = "kn";
      setLatestStatus(result.warning || "Kannada text is ready. Compare it with the recording.", result.warning ? "waiting" : "success");
      toast(result.warning ? `${file.name}: ${result.warning}` : `${file.name}: Kannada text and audio comparison ready.`, Boolean(result.warning));
    } catch (error) {
      if (selected()) {
        setLatestStatus("Conversion could not produce reliable text", "failed");
        $("#latest-transcript-text").textContent = error.message;
        $("#latest-title").textContent = "Review this recording";
        toast(`${file.name}: ${error.message}`, true);
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
    state.selection += 1;
    window.clearInterval(state.timer);
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
    state.selection += 1;
    state.connected = false;
    state.recording = false;
    state.recordingPendingSave = false;
    window.clearInterval(state.timer);
    showScreen("landing");
  });
  let pollingDevice = false;
  window.setInterval(async () => {
    if (!state.connected || state.controlBusy || pollingDevice || screens.dashboard.hidden) return;
    pollingDevice = true;
    try {
      const info = await apiRequest("/api/status");
      const wasRecording = state.recording;
      state.deviceInfo = info;
      if (info.recording && !wasRecording) {
        beginRecordingDisplay();
        toast("Recording started on the hardware. LED: green.");
      } else if (!info.recording && wasRecording) {
        state.recording = false;
        state.recordingPendingSave = false;
        window.clearInterval(state.timer);
        $("#recording-tag").classList.remove("recording");
        $("#recording-tag").innerHTML = "<i></i> READY";
        $("#recording-visual").parentElement.classList.remove("is-recording");
        $("#sidebar-status-dot").classList.remove("recording");
        if (info.recordingError || info.sdReady === false) {
          $("#recording-help").textContent = "Recording stopped with an SD-card error. Check the red LED.";
          toast("ESP32 stopped recording because of an SD-card error. The recording may be incomplete.", true);
        } else {
          const data = await apiRequest("/api/files");
          updateFiles(Array.isArray(data) ? data : data?.files);
          toast("Hardware recording stopped and saved. Loading the latest audio.");
          void autoTranscribeLatest();
        }
      }
      setConnected(true, info);
      if (info.sdReady === false) {
        $("#banner-message").textContent = "ESP32 connected, but the SD card is unavailable. Check the red LED and card.";
      }
    } catch { /* A streaming download can temporarily occupy the ESP32 HTTP server. */ }
    finally { pollingDevice = false; }
  }, 5000);

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
      toast("Transcript copied.");
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
    link.download = `${state.latestFile.name.replace(/\.[^.]+$/, "")}.txt`;
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
