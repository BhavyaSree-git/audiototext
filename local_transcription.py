"""Local Kannada Whisper jobs; audio never leaves this PC and the ESP32 LAN."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from urllib.parse import quote
import uuid
from audio_processing import prepare_audio, PIPELINE_VERSION
from kannada_script import render_in_kannada_script

ROOT = Path(__file__).resolve().parent
MODEL = os.environ.get("WHISPER_MODEL", "medium")


class TranscriptionJobs:
    def __init__(self, discovery):
        self.discovery = discovery
        self.executor = ThreadPoolExecutor(max_workers=1)
        self.lock = threading.Lock()
        self.jobs = {}
        self.active = {}
        self.model = None

    def submit(self, filename):
        key = filename
        if not filename or filename.startswith("._") or any(c in filename for c in ("/", "\\", "\x00")) or filename in (".", ".."):
            raise ValueError("Choose an audio recording, not a metadata file.")
        with self.lock:
            if key in self.active:
                return self.active[key]
            if len(self.active) >= 4:
                raise ValueError("The conversion queue is full. Wait for a recording to finish.")
            for expired_job_id in list(self.jobs):
                if self.jobs[expired_job_id]["updated"] < time.time() - 86400 and self.jobs[expired_job_id]["status"] in ("completed", "failed"):
                    del self.jobs[expired_job_id]
            job_id = uuid.uuid4().hex
            self.jobs[job_id] = {"status": "queued", "message": "Waiting for local Whisper", "updated": time.time()}
            self.active[key] = job_id
            self.executor.submit(self.run, job_id, filename)
            return job_id

    def get(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            return dict(job) if job else None

    def update(self, job_id, **values):
        with self.lock:
            self.jobs[job_id].update(values, updated=time.time())

    def recognize(self, job_id, audio):
        """Return only speech that passes Whisper's confidence checks."""
        if self.model is None:
            from faster_whisper import WhisperModel
            self.model = WhisperModel(MODEL, device="cpu", compute_type="int8",
                cpu_threads=min(4, os.cpu_count() or 1), download_root=str(ROOT / ".models"))
        segments, info = self.model.transcribe(audio, language=None, task="transcribe", multilingual=True,
            beam_size=5, temperature=0, vad_filter=True,
            vad_parameters={"threshold": .55, "min_silence_duration_ms": 400},
            condition_on_previous_text=False, word_timestamps=True, hallucination_silence_threshold=2,
            compression_ratio_threshold=2.2, log_prob_threshold=-.8, no_speech_threshold=.5)
        text_parts, uncertain, accepted = [], 0, 0
        for segment in segments:
            reliable = segment.avg_logprob >= -.8 and segment.no_speech_prob < .5 and segment.compression_ratio <= 2.2
            if reliable and segment.text.strip():
                text_parts.append(segment.text.strip())
                accepted += 1
            else:
                uncertain += 1
            self.update(job_id, message=f"Recognizing speech: {min(segment.end, info.duration):.0f} / {info.duration:.0f} seconds")
        return " ".join(text_parts).strip(), info, accepted, uncertain

    def run(self, job_id, filename):
        try:
            self.update(job_id, status="processing", message="Downloading recording from esp32.local")
            with tempfile.TemporaryDirectory(prefix="svara-audio-") as directory:
                audio_path = Path(directory) / "recording.audio"
                digest = hashlib.sha256()
                connection = http.client.HTTPConnection(self.discovery.resolve(), 80, timeout=120)
                try:
                    connection.request("GET", f"/api/files/{quote(filename, safe='')}/download", headers={"Host": "esp32.local"})
                    response = connection.getresponse()
                    if response.status != 200:
                        raise RuntimeError(f"Could not download recording (ESP32 HTTP {response.status}).")
                    total = 0
                    with audio_path.open("wb") as output:
                        while chunk := response.read(65536):
                            total += len(chunk)
                            if total > 512 * 1024 * 1024:
                                raise RuntimeError("Recording exceeds the 512 MB local conversion limit.")
                            output.write(chunk)
                            digest.update(chunk)
                    expected = response.getheader("Content-Length")
                    if not total or (expected and total != int(expected)):
                        raise RuntimeError("Recording download was incomplete. Try Convert again.")
                finally:
                    connection.close()
                cache_dir = ROOT / ".transcripts"
                cache_dir.mkdir(exist_ok=True)
                cache_key = hashlib.sha256((digest.hexdigest() + MODEL + "kannada-script-v2" + PIPELINE_VERSION).encode()).hexdigest()
                cache_path = cache_dir / f"{cache_key}.json"
                artifact_dir = ROOT / ".processed" / cache_key
                artifact_dir.mkdir(parents=True, exist_ok=True)
                raw_path, clear_path = artifact_dir / "raw.wav", artifact_dir / "clear.wav"
                if cache_path.exists() and raw_path.exists() and clear_path.exists():
                    result = json.loads(cache_path.read_text(encoding="utf-8"))
                else:
                    self.update(job_id, message="Checking microphone channels and preparing clear audio")
                    # First use the channel selected by VAD.  If that produces no
                    # credible speech, retry the physically loudest microphone.
                    # This avoids silently treating a distant microphone as the only
                    # source in a four-microphone recording.
                    recognition_audio, details = prepare_audio(audio_path, raw_path, clear_path)
                    if details["speechSeconds"] < .5:
                        raise RuntimeError("No clear speech was detected. Listen to the raw audio and check microphone wiring, volume, and distance.")
                    playback = {**details, "rawUrl": f"/api/audio/{cache_key}/raw.wav", "enhancedUrl": f"/api/audio/{cache_key}/clear.wav"}
                    self.update(job_id, audio=playback, message="Loading local Whisper model")
                    source_text, info, accepted, uncertain = self.recognize(job_id, recognition_audio)
                    loudest_channel = details.get("loudestChannel")
                    if not accepted and loudest_channel and details["selectedChannel"] != loudest_channel:
                        self.update(job_id, message="Trying the clearest available microphone")
                        recognition_audio, details = prepare_audio(audio_path, raw_path, clear_path,
                            preferred_channel=loudest_channel - 1)
                        playback = {**details, "rawUrl": f"/api/audio/{cache_key}/raw.wav", "enhancedUrl": f"/api/audio/{cache_key}/clear.wav"}
                        self.update(job_id, audio=playback, message="Recognizing speech from alternate microphone")
                        source_text, info, accepted, uncertain = self.recognize(job_id, recognition_audio)
                    if not accepted:
                        raise RuntimeError("Speech could not be recognized reliably from the available microphones. Listen to the raw audio and check microphone wiring, volume, and distance.")
                    self.update(job_id, message="Rendering the spoken words in Kannada script")
                    text = render_in_kannada_script(source_text, info.language)
                    result = {"text": text, "sourceLanguage": info.language, "model": MODEL, "duration": info.duration,
                              "audio": playback, "warning": (f"{uncertain} unclear section(s) were omitted. " if uncertain else "") + ("Language detection confidence is low; verify the Kannada text against the audio." if info.language_probability < .65 else "")}
                    temporary = cache_path.with_suffix(".tmp")
                    temporary.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
                    temporary.replace(cache_path)
                self.update(job_id, status="completed", message="Transcription complete", **result)
        except Exception as error:
            self.update(job_id, status="failed", error=f"Local Whisper conversion failed: {error}")
        finally:
            with self.lock:
                self.active.pop(filename, None)
