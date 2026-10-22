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

ROOT = Path(__file__).resolve().parent
MODEL = os.environ.get("WHISPER_MODEL", "small")


class TranscriptionJobs:
    def __init__(self, discovery):
        self.discovery = discovery
        self.executor = ThreadPoolExecutor(max_workers=1)
        self.lock = threading.Lock()
        self.jobs = {}
        self.active = {}
        self.model = None

    def submit(self, filename):
        if not filename or filename.startswith("._") or any(c in filename for c in ("/", "\\", "\x00")) or filename in (".", ".."):
            raise ValueError("Choose an audio recording, not a metadata file.")
        with self.lock:
            if filename in self.active:
                return self.active[filename]
            if len(self.active) >= 4:
                raise ValueError("The conversion queue is full. Wait for a recording to finish.")
            for key in list(self.jobs):
                if self.jobs[key]["updated"] < time.time() - 86400 and self.jobs[key]["status"] in ("completed", "failed"):
                    del self.jobs[key]
            job_id = uuid.uuid4().hex
            self.jobs[job_id] = {"status": "queued", "message": "Waiting for local Whisper", "updated": time.time()}
            self.active[filename] = job_id
            self.executor.submit(self.run, job_id, filename)
            return job_id

    def get(self, job_id):
        with self.lock:
            job = self.jobs.get(job_id)
            return dict(job) if job else None

    def update(self, job_id, **values):
        with self.lock:
            self.jobs[job_id].update(values, updated=time.time())

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
                cache_key = hashlib.sha256((digest.hexdigest() + MODEL + ':kn:transcribe:v1').encode()).hexdigest()
                cache_path = cache_dir / f"{cache_key}.json"
                if cache_path.exists():
                    result = json.loads(cache_path.read_text(encoding="utf-8"))
                else:
                    self.update(job_id, message="Loading local Whisper model (first use may download the model)")
                    if self.model is None:
                        from faster_whisper import WhisperModel
                        self.model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=min(4, os.cpu_count() or 1), download_root=str(ROOT / ".models"))
                    self.update(job_id, message="Transcribing the complete recording to Kannada on this PC")
                    segments, info = self.model.transcribe(str(audio_path), language="kn", task="transcribe", beam_size=5, vad_filter=True, condition_on_previous_text=False)
                    text_parts = []
                    for segment in segments:
                        text_parts.append(segment.text.strip())
                        self.update(job_id, message=f"Transcribing Kannada: {min(segment.end, info.duration):.0f} / {info.duration:.0f} seconds")
                    text = " ".join(part for part in text_parts if part).strip()
                    if not text:
                        raise RuntimeError("Whisper detected no speech. Check the microphone recording by playing the original audio.")
                    result = {"text": text, "language": "kn", "model": MODEL, "duration": info.duration}
                    temporary = cache_path.with_suffix(".tmp")
                    temporary.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
                    temporary.replace(cache_path)
                self.update(job_id, status="completed", message="Kannada transcription complete", **result)
        except Exception as error:
            self.update(job_id, status="failed", error=f"Local Whisper conversion failed: {error}")
        finally:
            with self.lock:
                self.active.pop(filename, None)
