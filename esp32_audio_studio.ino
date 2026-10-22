#include <Arduino.h>
#include <ESPmDNS.h>
#include <FS.h>
#include <SD.h>
#include <SPI.h>
#include <WebServer.h>
#include <WiFi.h>
#include "driver/i2s.h"a

// Tested pin assumptions from the supplied sketch: original ESP32 DevKit,
// two I2S controllers, four INMP441 microphones, and an SPI SD-card module.
// On each I2S bus, strap one microphone L/R select low and the other high.
#include "wifi_config.h"
static constexpr char MDNS_HOST[] = "esp32";

static constexpr int SD_CS = 5;
static constexpr int SD_SCK = 18;
static constexpr int SD_MISO = 19;
static constexpr int SD_MOSI = 23;

static constexpr int BUTTON_PIN = 27;
static constexpr int STATUS_LED = 2;

static constexpr int I2S0_BCLK = 26;
static constexpr int I2S0_WS = 25;
static constexpr int I2S0_DATA = 34;
static constexpr int I2S1_BCLK = 32;
static constexpr int I2S1_WS = 33;
static constexpr int I2S1_DATA = 35;

static constexpr uint32_t SAMPLE_RATE = 16000;
static constexpr uint16_t CHANNELS = 4;
static constexpr uint16_t BITS_PER_SAMPLE = 16;
static constexpr size_t FRAMES_PER_READ = 256;
static constexpr size_t MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
static constexpr uint32_t MAX_WAV_DATA_BYTES = 0xFFFFFFFFUL - 36;

static int32_t mic12Buffer[FRAMES_PER_READ * 2];
static int32_t mic34Buffer[FRAMES_PER_READ * 2];
static int16_t outputBuffer[FRAMES_PER_READ * CHANNELS];

WebServer server(80);
SPIClass sdSPI(VSPI);
File wavFile;
File uploadFile;
String currentRecordingPath;
String lastFinishedFile;
String uploadPath;
String uploadError;
size_t uploadBytes = 0;
uint32_t audioBytesWritten = 0;
bool sdReady = false;
bool i2sReady = false;
bool recording = false;
bool mdnsStarted = false;

void sendCorsHeaders() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.sendHeader("Access-Control-Max-Age", "600");
}

void sendJson(int status, const String &body) {
  sendCorsHeaders();
  server.send(status, "application/json; charset=utf-8", body);
}

String jsonEscape(const String &value) {
  String result;
  result.reserve(value.length() + 8);
  for (size_t i = 0; i < value.length(); ++i) {
    const char c = value[i];
    if (c == '"' || c == '\\') {
      result += '\\';
      result += c;
    } else if (static_cast<uint8_t>(c) < 0x20) {
      result += ' ';
    } else {
      result += c;
    }
  }
  return result;
}

String decodePathSegment(const String &value) {
  String decoded;
  decoded.reserve(value.length());
  for (size_t i = 0; i < value.length(); ++i) {
    if (value[i] == '%' && i + 2 < value.length()) {
      char hex[3] = {value[i + 1], value[i + 2], '\0'};
      char *end = nullptr;
      const long byteValue = strtol(hex, &end, 16);
      if (end != hex && *end == '\0' && byteValue >= 0 && byteValue <= 255) {
        decoded += static_cast<char>(byteValue);
        i += 2;
        continue;
      }
    }
    decoded += value[i] == '+' ? ' ' : value[i];
  }
  return decoded;
}

String safeFileName(String name) {
  name.replace('\\', '/');
  const int slash = name.lastIndexOf('/');
  if (slash >= 0) name = name.substring(slash + 1);
  name.trim();
  if (name.isEmpty() || name == "." || name == "..") return "";
  for (size_t i = 0; i < name.length(); ++i) {
    const char c = name[i];
    if (c == ':' || c == '*' || c == '?' || c == '"' ||
        c == '<' || c == '>' || c == '|') {
      name.setCharAt(i, '_');
    }
  }
  return name;
}

String pathForName(const String &name) {
  const String safeName = safeFileName(name);
  return safeName.isEmpty() ? "" : "/" + safeName;
}

bool isAudioFile(const String &filename) {
  String lower = filename;
  lower.toLowerCase();
  return lower.endsWith(".wav") || lower.endsWith(".mp3") ||
         lower.endsWith(".m4a") || lower.endsWith(".aac") ||
         lower.endsWith(".flac") || lower.endsWith(".ogg");
}

String contentTypeFor(const String &filename) {
  String lower = filename;
  lower.toLowerCase();
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".aac")) return "audio/aac";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".flac")) return "audio/flac";
  return "application/octet-stream";
}

String chooseUniquePath(const String &originalName) {
  const String baseName = safeFileName(originalName);
  if (baseName.isEmpty()) return "";

  String candidate = "/" + baseName;
  if (!SD.exists(candidate)) return candidate;

  const int dot = baseName.lastIndexOf('.');
  const String stem = dot > 0 ? baseName.substring(0, dot) : baseName;
  const String extension = dot > 0 ? baseName.substring(dot) : "";
  for (uint32_t suffix = 1; suffix < 10000; ++suffix) {
    candidate = "/" + stem + "_" + String(suffix) + extension;
    if (!SD.exists(candidate)) return candidate;
  }
  return "";
}

String nextRecordingPath() {
  File root = SD.open("/");
  if (!root || !root.isDirectory()) return "";

  uint32_t highest = 0;
  File entry = root.openNextFile();
  while (entry) {
    if (!entry.isDirectory()) {
      String name = String(entry.name());
      const int slash = name.lastIndexOf('/');
      if (slash >= 0) name = name.substring(slash + 1);
      if (name.startsWith("REC") && name.endsWith(".wav") && name.length() >= 8) {
        const uint32_t number = static_cast<uint32_t>(name.substring(3, name.length() - 4).toInt());
        if (number > highest) highest = number;
      }
    }
    entry.close();
    entry = root.openNextFile();
  }
  root.close();

  char filename[20];
  snprintf(filename, sizeof(filename), "/REC%04lu.wav",
           static_cast<unsigned long>(highest + 1));
  return String(filename);
}

String findLatestRecording() {
  if (!lastFinishedFile.isEmpty() && SD.exists(lastFinishedFile)) return lastFinishedFile;

  File root = SD.open("/");
  if (!root || !root.isDirectory()) return "";

  String latestPath;
  uint32_t highestRecordingNumber = 0;
  File entry = root.openNextFile();
  while (entry) {
    if (!entry.isDirectory()) {
      String name = String(entry.name());
      const int slash = name.lastIndexOf('/');
      if (slash >= 0) name = name.substring(slash + 1);
      if (name.startsWith("REC") && name.endsWith(".wav")) {
        const uint32_t number = static_cast<uint32_t>(name.substring(3, name.length() - 4).toInt());
        if (number >= highestRecordingNumber) {
          highestRecordingNumber = number;
          latestPath = "/" + name;
        }
      }
    }
    entry.close();
    entry = root.openNextFile();
  }
  root.close();
  return latestPath;
}

bool installI2S(i2s_port_t port, int bclkPin, int wsPin, int dataPin) {
  i2s_config_t config = {};
  config.mode = static_cast<i2s_mode_t>(I2S_MODE_MASTER | I2S_MODE_RX);
  config.sample_rate = SAMPLE_RATE;
  config.bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT;
  config.channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT;
  config.communication_format = I2S_COMM_FORMAT_I2S;
  config.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
  config.dma_buf_count = 8;
  config.dma_buf_len = FRAMES_PER_READ;
  config.use_apll = false;
  config.tx_desc_auto_clear = false;
  config.fixed_mclk = 0;

  if (i2s_driver_install(port, &config, 0, nullptr) != ESP_OK) return false;

  i2s_pin_config_t pins = {};
  pins.bck_io_num = bclkPin;
  pins.ws_io_num = wsPin;
  pins.data_out_num = I2S_PIN_NO_CHANGE;
  pins.data_in_num = dataPin;
  pins.mck_io_num = I2S_PIN_NO_CHANGE;
  if (i2s_set_pin(port, &pins) != ESP_OK) {
    i2s_driver_uninstall(port);
    return false;
  }
  i2s_zero_dma_buffer(port);
  return true;
}

void writeLE16(File &file, uint16_t value) {
  const uint8_t bytes[2] = {
    static_cast<uint8_t>(value & 0xFF),
    static_cast<uint8_t>((value >> 8) & 0xFF)
  };
  file.write(bytes, sizeof(bytes));
}

void writeLE32(File &file, uint32_t value) {
  const uint8_t bytes[4] = {
    static_cast<uint8_t>(value & 0xFF),
    static_cast<uint8_t>((value >> 8) & 0xFF),
    static_cast<uint8_t>((value >> 16) & 0xFF),
    static_cast<uint8_t>((value >> 24) & 0xFF)
  };
  file.write(bytes, sizeof(bytes));
}

bool writeWavHeader(File &file, uint32_t dataSize) {
  const uint32_t byteRate = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8);
  const uint16_t blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);
  if (!file.seek(0)) return false;

  bool ok = file.write(reinterpret_cast<const uint8_t *>("RIFF"), 4) == 4;
  writeLE32(file, 36 + dataSize);
  ok &= file.write(reinterpret_cast<const uint8_t *>("WAVE"), 4) == 4;
  ok &= file.write(reinterpret_cast<const uint8_t *>("fmt "), 4) == 4;
  writeLE32(file, 16);
  writeLE16(file, 1);
  writeLE16(file, CHANNELS);
  writeLE32(file, SAMPLE_RATE);
  writeLE32(file, byteRate);
  writeLE16(file, blockAlign);
  writeLE16(file, BITS_PER_SAMPLE);
  ok &= file.write(reinterpret_cast<const uint8_t *>("data"), 4) == 4;
  writeLE32(file, dataSize);
  return ok;
}

void captureAudio();

String formatDuration(uint32_t seconds) {
  char formatted[16];
  snprintf(formatted, sizeof(formatted), "%02lu:%02lu:%02lu",
           static_cast<unsigned long>(seconds / 3600),
           static_cast<unsigned long>((seconds / 60) % 60),
           static_cast<unsigned long>(seconds % 60));
  return String(formatted);
}

String wavDuration(File &file, const String &filename) {
  if (!filename.startsWith("REC") || !filename.endsWith(".wav") || file.size() <= 44) return "";
  const uint32_t seconds = static_cast<uint32_t>(
      (file.size() - 44) / (SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8)));
  return formatDuration(seconds);
}

bool startRecording() {
  if (!sdReady || !i2sReady || recording) return false;
  const String filename = nextRecordingPath();
  if (filename.isEmpty()) return false;

  wavFile = SD.open(filename, FILE_WRITE);
  if (!wavFile) return false;
  const uint8_t blankHeader[44] = {};
  if (wavFile.write(blankHeader, sizeof(blankHeader)) != sizeof(blankHeader)) {
    wavFile.close();
    SD.remove(filename);
    return false;
  }

  i2s_zero_dma_buffer(I2S_NUM_0);
  i2s_zero_dma_buffer(I2S_NUM_1);
  audioBytesWritten = 0;
  currentRecordingPath = filename;
  recording = true;
  digitalWrite(STATUS_LED, HIGH);
  Serial.println("[REC] Started: " + filename);
  return true;
}

void stopRecording(bool drainAudio = true) {
  if (!recording) return;
  if (drainAudio) {
    captureAudio();
    if (!recording) return;
  }
  recording = false;
  digitalWrite(STATUS_LED, LOW);

  if (wavFile) {
    wavFile.flush();
    if (!writeWavHeader(wavFile, audioBytesWritten)) {
      Serial.println("[REC] Warning: WAV header update failed.");
    }
    wavFile.flush();
    wavFile.close();
  }

  lastFinishedFile = currentRecordingPath;
  currentRecordingPath = "";
  const float duration = static_cast<float>(audioBytesWritten) /
      (SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8));
  Serial.printf("[REC] Saved %s (%.2f s, %lu bytes)\n",
                lastFinishedFile.c_str(), duration,
                static_cast<unsigned long>(audioBytesWritten));
}

void captureAudio() {
  if (!recording || !wavFile) return;
  if (audioBytesWritten >= MAX_WAV_DATA_BYTES) {
    Serial.println("[REC] WAV size limit reached; stopping recording.");
    stopRecording(false);
    return;
  }

  size_t bytes0 = 0;
  size_t bytes1 = 0;
  const esp_err_t result0 = i2s_read(I2S_NUM_0, mic12Buffer, sizeof(mic12Buffer),
                                     &bytes0, pdMS_TO_TICKS(20));
  const esp_err_t result1 = i2s_read(I2S_NUM_1, mic34Buffer, sizeof(mic34Buffer),
                                     &bytes1, pdMS_TO_TICKS(20));
  if (result0 != ESP_OK || result1 != ESP_OK) return;

  const size_t frames0 = bytes0 / (sizeof(int32_t) * 2);
  const size_t frames1 = bytes1 / (sizeof(int32_t) * 2);
  const size_t frames = min(frames0, frames1);
  if (frames == 0) return;

  for (size_t i = 0; i < frames; ++i) {
    outputBuffer[4 * i] = static_cast<int16_t>(mic12Buffer[2 * i] >> 16);
    outputBuffer[4 * i + 1] = static_cast<int16_t>(mic12Buffer[2 * i + 1] >> 16);
    outputBuffer[4 * i + 2] = static_cast<int16_t>(mic34Buffer[2 * i] >> 16);
    outputBuffer[4 * i + 3] = static_cast<int16_t>(mic34Buffer[2 * i + 1] >> 16);
  }

  const size_t requested = frames * CHANNELS * sizeof(int16_t);
  const size_t written = wavFile.write(reinterpret_cast<const uint8_t *>(outputBuffer), requested);
  audioBytesWritten += written;
  if (written != requested) {
    Serial.println("[REC] SD write failed; stopping recording.");
    stopRecording(false);
  }
}

void handleStatus() {
  // Network status remains available even when the SD card fails.
  const String body = "{\"name\":\"ESP32 4-Mic Recorder\",\"recording\":" +
      String(recording ? "true" : "false") + ",\"storage\":{\"used\":" +
      String(sdReady ? SD.usedBytes() : 0) + ",\"total\":" + String(sdReady ? SD.totalBytes() : 0) +
      "},\"sdReady\":" + String(sdReady ? "true" : "false") + ",\"sampleRate\":" + String(SAMPLE_RATE) + ",\"channels\":" +
      String(CHANNELS) + ",\"mdns\":\"http://esp32.local\"}";
  sendJson(200, body);
}

void handleFiles() {
  if (!sdReady) {
    sendJson(503, "{\"error\":\"SD card is not available.\"}");
    return;
  }
  if (recording) {
    sendJson(409, "{\"error\":\"Stop and save the active recording before syncing.\"}");
    return;
  }

  File root = SD.open("/");
  if (!root || !root.isDirectory()) {
    if (root) root.close();
    sendJson(500, "{\"error\":\"Could not open the SD-card root directory.\"}");
    return;
  }

  String body = "{\"files\":[";
  bool first = true;
  const String newest = findLatestRecording();
  if (!newest.isEmpty() && SD.exists(newest)) {
    File latestFile = SD.open(newest, FILE_READ);
    if (latestFile && !latestFile.isDirectory()) {
      const String name = newest.substring(1);
      const size_t size = latestFile.size();
      const String duration = wavDuration(latestFile, name);
      body += "{\"name\":\"" + jsonEscape(name) + "\",\"size\":" +
              String(size) + ",\"duration\":\"" + duration + "\"}";
      first = false;
    }
    if (latestFile) latestFile.close();
  }

  File entry = root.openNextFile();
  while (entry) {
    if (!entry.isDirectory()) {
      String path = String(entry.name());
      String name = path.substring(path.lastIndexOf('/') + 1);
      if (isAudioFile(name) && ("/" + name) != newest) {
        if (!first) body += ',';
        first = false;
        const size_t size = entry.size();
        const String duration = wavDuration(entry, name);
        body += "{\"name\":\"" + jsonEscape(name) + "\",\"size\":" +
                String(size) + ",\"duration\":\"" + duration + "\"}";
      }
    }
    entry.close();
    entry = root.openNextFile();
  }
  root.close();
  body += "]}";
  sendJson(200, body);
}

void handleFileDownload(const String &filename, bool enhanced) {
  if (!sdReady) {
    sendJson(503, "{\"error\":\"SD card is not available.\"}");
    return;
  }
  if (recording) {
    sendJson(409, "{\"error\":\"Stop the recording before downloading audio.\"}");
    return;
  }
  if (enhanced) {
    sendJson(501, "{\"error\":\"Noise-reduced audio is not implemented. This sketch records raw four-channel audio.\"}");
    return;
  }
  const String path = pathForName(filename);
  if (path.isEmpty() || !SD.exists(path)) {
    sendJson(404, "{\"error\":\"Audio file was not found on the SD card.\"}");
    return;
  }
  File file = SD.open(path, FILE_READ);
  if (!file || file.isDirectory()) {
    if (file) file.close();
    sendJson(500, "{\"error\":\"Could not open the audio file.\"}");
    return;
  }

  sendCorsHeaders();
  server.sendHeader("Content-Disposition", "attachment; filename=\"" + safeFileName(filename) + "\"");
  server.streamFile(file, contentTypeFor(filename));
  file.close();
}

void handleFileDelete(const String &filename) {
  if (!sdReady) {
    sendJson(503, "{\"error\":\"SD card is not available.\"}");
    return;
  }
  if (recording) {
    sendJson(409, "{\"error\":\"Stop the recording before deleting files.\"}");
    return;
  }
  const String path = pathForName(filename);
  if (path.isEmpty() || !SD.exists(path)) {
    sendJson(404, "{\"error\":\"Audio file was not found on the SD card.\"}");
    return;
  }
  if (!SD.remove(path)) {
    sendJson(500, "{\"error\":\"Could not delete the audio file.\"}");
    return;
  }
  if (lastFinishedFile == path) lastFinishedFile = "";
  sendJson(200, "{\"deleted\":true}");
}

void handleUploadData() {
  if (!sdReady) {
    uploadError = "SD card is not available.";
    return;
  }
  if (recording) {
    uploadError = "Stop the active recording before uploading.";
    return;
  }

  HTTPUpload &upload = server.upload();
  switch (upload.status) {
    case UPLOAD_FILE_START:
      uploadError = "";
      uploadBytes = 0;
      uploadPath = "";
      if (!isAudioFile(upload.filename)) {
        uploadError = "Unsupported file type. Upload WAV, MP3, M4A, AAC, FLAC, or OGG.";
        return;
      }
      uploadPath = chooseUniquePath(upload.filename);
      if (uploadPath.isEmpty()) {
        uploadError = "The uploaded filename is invalid.";
        return;
      }
      uploadFile = SD.open(uploadPath, FILE_WRITE);
      if (!uploadFile) uploadError = "Could not create the uploaded file on the SD card.";
      break;

    case UPLOAD_FILE_WRITE:
      if (!uploadError.isEmpty()) return;
      uploadBytes += upload.currentSize;
      if (uploadBytes > MAX_UPLOAD_BYTES) {
        uploadError = "Upload exceeds the 32 MB limit.";
        uploadFile.close();
        SD.remove(uploadPath);
        return;
      }
      if (!uploadFile ||
          uploadFile.write(upload.buf, upload.currentSize) != upload.currentSize) {
        uploadError = "Could not write the complete upload to the SD card.";
        if (uploadFile) uploadFile.close();
        SD.remove(uploadPath);
      }
      break;

    case UPLOAD_FILE_END:
      if (uploadFile) {
        uploadFile.flush();
        uploadFile.close();
      }
      if (uploadBytes == 0) uploadError = "The uploaded audio file is empty.";
      break;

    case UPLOAD_FILE_ABORTED:
      if (uploadFile) uploadFile.close();
      if (!uploadPath.isEmpty()) SD.remove(uploadPath);
      uploadPath = "";
      uploadError = "Upload was cancelled.";
      break;

    default:
      break;
  }
}

void handleUploadComplete() {
  if (!uploadError.isEmpty()) {
    if (!uploadPath.isEmpty()) SD.remove(uploadPath);
    sendJson(400, "{\"error\":\"" + jsonEscape(uploadError) + "\"}");
    uploadPath = "";
    uploadError = "";
    return;
  }
  if (uploadPath.isEmpty() || !SD.exists(uploadPath)) {
    sendJson(400, "{\"error\":\"No complete file was uploaded.\"}");
    return;
  }
  const String name = uploadPath.substring(1);
  lastFinishedFile = uploadPath;
  sendJson(201, "{\"name\":\"" + jsonEscape(name) + "\"}");
  uploadPath = "";
}

void handleStartRecord() {
  if (!sdReady) {
    sendJson(503, "{\"error\":\"SD card is not available.\"}");
    return;
  }
  if (!i2sReady) {
    sendJson(503, "{\"error\":\"Microphone I2S initialization failed. Check board and microphone pins.\"}");
    return;
  }
  if (recording) {
    sendJson(200, "{\"recording\":true,\"message\":\"Already recording.\"}");
    return;
  }
  if (!startRecording()) {
    sendJson(500, "{\"error\":\"Could not start recording. Check SD card and available storage.\"}");
    return;
  }
  sendJson(200, "{\"recording\":true,\"file\":\"" +
           jsonEscape(currentRecordingPath.substring(1)) + "\"}");
}

void handleStopRecord() {
  if (!recording) {
    sendJson(200, "{\"recording\":false,\"message\":\"No active recording.\"}");
    return;
  }
  stopRecording();
  sendJson(200, "{\"recording\":false,\"saved\":true,\"file\":\"" +
           jsonEscape(lastFinishedFile.substring(1)) + "\",\"bytes\":" +
           String(audioBytesWritten) + "}");
}

void handleSaveRecord() {
  if (!sdReady) {
    sendJson(503, "{\"error\":\"SD card is not available.\"}");
    return;
  }
  if (recording) {
    sendJson(409, "{\"error\":\"Stop the recording before saving it.\"}");
    return;
  }
  if (lastFinishedFile.isEmpty() || !SD.exists(lastFinishedFile)) {
    sendJson(404, "{\"error\":\"There is no stopped recording to save.\"}");
    return;
  }
  sendJson(200, "{\"saved\":true,\"file\":\"" +
           jsonEscape(lastFinishedFile.substring(1)) + "\"}");
}

void handleNotFound() {
  const String uri = server.uri();
  if (server.method() == HTTP_OPTIONS) {
    sendCorsHeaders();
    server.send(204, "text/plain", "");
    return;
  }

  if (uri.startsWith("/api/files/")) {
    const String rest = uri.substring(String("/api/files/").length());
    if (rest.endsWith("/download") && server.method() == HTTP_GET) {
      handleFileDownload(
          decodePathSegment(rest.substring(0, rest.length() - String("/download").length())),
          false);
      return;
    }
    if (rest.endsWith("/enhanced") && server.method() == HTTP_GET) {
      handleFileDownload(
          decodePathSegment(rest.substring(0, rest.length() - String("/enhanced").length())),
          true);
      return;
    }
    if (rest.endsWith("/transcribe") && server.method() == HTTP_POST) {
      sendJson(501, "{\"error\":\"Kannada transcription is not configured. Connect a full-audio Kannada speech-to-text service.\"}");
      return;
    }
    if (server.method() == HTTP_DELETE) {
      handleFileDelete(decodePathSegment(rest));
      return;
    }
  }
  sendJson(404, "{\"error\":\"Endpoint not found.\"}");
}

void handleButton() {
  static bool previousState = HIGH;
  static uint32_t lastPressMs = 0;
  const bool currentState = digitalRead(BUTTON_PIN);
  if (previousState == HIGH && currentState == LOW) {
    const uint32_t now = millis();
    if (now - lastPressMs >= 250) {
      lastPressMs = now;
      if (recording) {
        stopRecording();
      } else if (!startRecording()) {
        Serial.println("[REC] Button start failed. Check SD and I2S.");
      }
    }
  }
  previousState = currentState;
}

void connectWifi() {
  WiFi.setHostname(MDNS_HOST);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to Wi-Fi");
  const uint32_t deadline = millis() + 20000;
  while (WiFi.status() != WL_CONNECTED && millis() < deadline) {
    delay(300);
    Serial.print('.');
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("Connected: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("Wi-Fi connection failed; retrying in loop.");
  }
}

void startMdns() {
  if (WiFi.status() != WL_CONNECTED || mdnsStarted) return;
  MDNS.end();  // Clear any responder left behind after a reconnect or failed start.
  mdnsStarted = MDNS.begin(MDNS_HOST);
  if (mdnsStarted) {
    MDNS.addService("http", "tcp", 80);
    Serial.println("mDNS ready: http://esp32.local");
    Serial.println("Connection check: http://esp32.local/api/status");
  } else {
    Serial.println("mDNS startup failed; will retry.");
  }
}

void setupRoutes() {
  server.on("/api/status", HTTP_GET, handleStatus);
  server.on("/api/files", HTTP_GET, handleFiles);
  server.on("/api/files", HTTP_POST, handleUploadComplete, handleUploadData);
  server.on("/api/record/start", HTTP_POST, handleStartRecord);
  server.on("/api/record/stop", HTTP_POST, handleStopRecord);
  server.on("/api/record/save", HTTP_POST, handleSaveRecord);
  server.onNotFound(handleNotFound);
  server.begin();
  Serial.println("HTTP API listening on port 80.");
}

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(STATUS_LED, OUTPUT);
  digitalWrite(STATUS_LED, LOW);
  Serial.println("\nESP32 four-microphone audio studio");

  sdSPI.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS);
  sdReady = SD.begin(SD_CS, sdSPI, 10000000);
  Serial.println(sdReady ? "SD card ready." : "SD card initialization failed.");

  const bool i2s0Ready = installI2S(I2S_NUM_0, I2S0_BCLK, I2S0_WS, I2S0_DATA);
  const bool i2s1Ready = installI2S(I2S_NUM_1, I2S1_BCLK, I2S1_WS, I2S1_DATA);
  i2sReady = i2s0Ready && i2s1Ready;
  if (!i2s0Ready && i2s1Ready) i2s_driver_uninstall(I2S_NUM_1);
  if (i2s0Ready && !i2s1Ready) i2s_driver_uninstall(I2S_NUM_0);
  Serial.println(i2sReady ? "Both I2S microphone buses ready."
                          : "I2S initialization failed; check board core and microphone wiring.");

  if (sdReady) lastFinishedFile = findLatestRecording();

  connectWifi();
  startMdns();
  setupRoutes();
}

void loop() {
  server.handleClient();
  handleButton();
  if (recording) captureAudio();

  static uint32_t lastWifiCheckMs = 0;
  static bool wasConnected = WiFi.status() == WL_CONNECTED;
  if (millis() - lastWifiCheckMs >= 4000) {
    lastWifiCheckMs = millis();
    const bool connected = WiFi.status() == WL_CONNECTED;
    if (connected && !wasConnected) {
      Serial.print("[Wi-Fi] Reconnected: ");
      Serial.println(WiFi.localIP());
      mdnsStarted = false;
      startMdns();
    } else if (!connected && wasConnected) {
      MDNS.end();
      mdnsStarted = false;
      Serial.println("[Wi-Fi] Connection lost.");
    }
    wasConnected = connected;
    if (!connected) {
      WiFi.reconnect();
    } else if (!mdnsStarted) {
      startMdns();
    }
  }
  delay(1);
}
