# Svara — Kannada Audio Studio

A dependency-free browser interface for an ESP32 audio recorder with an SD card. Serve these files from a local development server on the same Wi-Fi network as the ESP32. Sign in and select **Sync device** to load recordings from its SD card. Recording and file operations require a connected ESP32.

## ESP32 firmware

The Arduino sketch is [esp32_audio_studio.ino](./esp32_audio_studio/esp32_audio_studio.ino). It combines the supplied classic-ESP32/two-I2S/four-INMP441 recorder wiring with the website API: Wi-Fi/mDNS (`esp32.local`), WAV recording from the hardware button or dashboard, SD-card listing, audio uploads (up to 32 MB), download, and delete. Open the `esp32_audio_studio` folder in Arduino IDE, select the original ESP32 board and port, copy `wifi_config.example.h` to `wifi_config.h`, set your Wi-Fi credentials there, and verify the pins at the top of the sketch, and upload. The SD-card SPI pins are VSPI defaults; each I2S microphone pair must share its bus clock, and one microphone must be strapped to the left channel and the other to the right channel. Open Serial Monitor at 115200 baud for initialization status.

The sketch writes four-channel, 16 kHz, 16-bit WAV files. Kannada transcription runs on the PC through the local Python server and Whisper. Direct transcription requests to the ESP32 still return HTTP 501. Beamforming/noise-reduced audio is not implemented. The sketch uses the legacy ESP32 I2S driver and the GPIO mapping from the provided old sketch; verify the wiring and installed ESP32 Arduino core for your exact board before uploading.

## Sign-in

The prototype login is `admin` / `admin`. This check runs entirely in browser JavaScript and is not authentication. Do not expose this page or the device API to an untrusted network without adding real server-side authentication and authorization.

## ESP32 API contract

The dashboard connects through mDNS at `http://esp32.local`. Upload the sketch, open Serial Monitor at 115200 baud, and confirm `mDNS ready: http://esp32.local`. Connect the computer and recorder to the same local network, then click **Sync device**. To check discovery independently of the page, open `http://esp32.local/api/status` in your browser. If the hostname cannot be found, check Wi-Fi connection and whether the network permits mDNS multicast between clients. The device must provide these endpoints. JSON endpoints must allow browser requests from the page's origin with CORS headers. The browser cannot bypass CORS or local-network restrictions; if the device cannot be reached, serve the UI locally and check the browser's local-network permissions and ESP32 mDNS configuration.

| Method | Path | Expected result |
| --- | --- | --- |
| `GET` | `/api/status` | JSON device information, e.g. `{"name":"ESP32 Recorder","storage":{"used":1000,"total":8000000}}` (storage values in bytes) |
| `GET` | `/api/files` | Array of files, or `{"files":[...]}`. Put the newest file first, or provide `createdAt`. Each file has `name` and may have `size` (bytes), `duration`, `createdAt`, `transcriptText`, `rawUrl`, `enhancedUrl`, and measured `snrGainDb`. |
| `POST` | `/api/files` | Accept `multipart/form-data` with an audio file field named `file`; store the uploaded audio on the SD card and return the saved file, e.g. `{"name":"upload.wav"}`. |
| `POST` | `/api/record/start` | Start recording; return a successful HTTP status after accepting the command. |
| `POST` | `/api/record/stop` | Stop the current recording. The UI immediately calls `/api/record/save` after this succeeds. |
| `POST` | `/api/record/save` | Save the stopped recording to the SD card. The UI then refreshes the list and automatically transcribes its newest file. |
| `GET` | `/api/files/{filename}/download` | Return the audio file bytes. |
| `GET` | `/api/files/{filename}/enhanced` | Return the beamformed/noise-reduced audio bytes for listening. Firmware must generate this audio from the four microphone channels; the webpage cannot remove noise from a recording by itself. |
| `DELETE` | `/api/files/{filename}` | Delete the named file from the SD card. |
| `POST` | `/api/files/{filename}/transcribe` | Transcribe the **entire** audio file and return `{"text":"..."}`, or enqueue a job and return `{"jobId":"..."}`. |
| `GET` | `/api/transcriptions/{jobId}` | For queued transcription, return `{"status":"processing"}`, `{"status":"completed","text":"..."}`, or `{"status":"failed","error":"..."}`. |

The overview automatically transcribes the newest file after a device sync or after saving a recording. A file with `transcriptText` already present is shown as converted without submitting it again. The latest-recording panel compares the original four-microphone audio with the enhanced audio and displays the full Kannada transcript, with copy and download actions. Files with no transcript can still be converted from the recordings list.

The local Python server implements the transcription endpoints with Whisper, processes the complete SD-card recording on this PC, and preserves the transcript. The browser itself does not perform speech recognition. The UI waits up to one hour for a queued job and displays the returned text without truncating it.

Use HTTPS or a trusted local origin where possible. Browsers may block HTTP device requests from an HTTPS-hosted page as mixed content. Do not put Wi-Fi passwords, speech-service API keys, or other secrets in these static files.

## Windows mDNS launcher

If Windows cannot resolve `esp32.local`, run `.\.venv\Scripts\python.exe studio_server.py --open` from this folder (Python 3.10 or newer). Open **http://localhost:8765**, sign in, and select **Sync device**. Keep the server running while using the studio.

The local server discovers `esp32.local` using mDNS queries requesting unicast replies on the computer's IPv4 interfaces. It caches the discovered address for at most 30 seconds and forwards the studio's API and audio requests to that recorder. No device IP is entered or hard-coded. This works around the observed Windows multicast-response failure; it does not repair Windows-wide `.local` name resolution. The server listens only on this computer and serves only the studio assets. The ESP32 and computer must remain on the same local network.

## Local Kannada text with Whisper and NLLB

Double-click `start_studio.cmd`, or run `.\.venv\Scripts\python.exe studio_server.py --open`. Use the local page at http://localhost:8765; direct ESP32 requests cannot run Whisper. For a new installation, run `python -m venv .venv` and `.\.venv\Scripts\python.exe -m pip install -r requirements.txt` first.

Convert downloads the complete selected audio through the mDNS-discovered ESP32 and runs multilingual Whisper locally. It automatically identifies and recognizes the spoken language, then renders the recognized words in Kannada script without changing their meaning. For example, “good morning” is rendered phonetically as Kannada-script speech, rather than translated as “ಶುಭೋದಯ”. There is no language selector in the webpage. Kannada speech remains Kannada; English is rendered phonetically; recognized Hindi, Tamil, Telugu, Malayalam and related Indic scripts are transliterated to Kannada. No audio or transcript is uploaded to a cloud service. Verify important text against the audio.

One conversion runs at a time, with up to four active/queued jobs. The page polls for progress. Recordings up to 512 MB can be converted. Temporary audio is deleted after conversion. Transcripts are cached in `.transcripts`, keyed by audio content and model, so later conversions can reuse results without mixing up files that share a filename. These folders are private local runtime data and excluded from Git. Failed jobs show a readable error and can be retried.

The default Whisper model is `medium`; it is more accurate than the earlier `small` model but slower on CPU. Do not select an English-only `.en` model. The Clear audio player uses a selected microphone channel and local noise reduction. It is not beamforming.

## WS2812 status LED

One WS2812 RGB LED is connected to GPIO 4. The firmware shows red when the SD card is unavailable or a recording write fails, blue when the recorder is ready, and green while it is recording.
