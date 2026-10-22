import io
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from local_transcription import TranscriptionJobs


class LocalTranscriptionTests(unittest.TestCase):
    def run_job(self, segments, cache_dir, download_status=200):
        jobs = TranscriptionJobs(SimpleNamespace(resolve=lambda: "192.168.1.2"))
        jobs.jobs["test"] = {"status": "queued"}
        jobs.active["recording.wav"] = "test"
        jobs.model = SimpleNamespace(transcribe=lambda *a, **k: (iter(segments), SimpleNamespace(duration=60)))
        audio = b"test audio bytes"
        response = io.BytesIO(audio)
        response.status = download_status
        response.getheader = lambda key: str(len(audio))
        connection = SimpleNamespace(request=lambda *a, **k: None, getresponse=lambda: response, close=lambda: None)
        with patch("local_transcription.ROOT", Path(cache_dir)), patch("local_transcription.http.client.HTTPConnection", return_value=connection):
            jobs.run("test", "recording.wav")
        jobs.executor.shutdown()
        self.assertFalse(jobs.active)
        return jobs.get("test")

    def test_complete_audio_and_persistent_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            segments = [SimpleNamespace(text="first", end=30), SimpleNamespace(text="last", end=60)]
            result = self.run_job(segments, directory)
            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["text"], "first last")
            cached = self.run_job([], directory)
            self.assertEqual(cached["text"], "first last")

    def test_no_speech_is_not_fake_success(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.run_job([], directory)
            self.assertEqual(result["status"], "failed")
            self.assertIn("no speech", result["error"])

    def test_download_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.run_job([], directory, 404)
            self.assertEqual(result["status"], "failed")
            self.assertIn("404", result["error"])

    def test_invalid_filenames(self):
        jobs = TranscriptionJobs(None)
        for filename in ("../x.wav", "._recording.wav", "", "a\\b.wav"):
            with self.assertRaises(ValueError):
                jobs.submit(filename)
        jobs.executor.shutdown()

    def test_duplicate_requests_share_job_and_queue_is_bounded(self):
        jobs = TranscriptionJobs(None)
        with patch.object(jobs.executor, "submit") as submit:
            first = jobs.submit("one.wav")
            self.assertEqual(first, jobs.submit("one.wav"))
            self.assertEqual(submit.call_count, 1)
            for name in ("two.wav", "three.wav", "four.wav"):
                jobs.submit(name)
            with self.assertRaises(ValueError):
                jobs.submit("five.wav")
        jobs.executor.shutdown()


if __name__ == "__main__":
    unittest.main()
