from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import wave

import numpy as np
from audio_processing import prepare_audio


class AudioProcessingTests(unittest.TestCase):
    def test_opposite_polarity_channels_do_not_cancel(self):
        t = np.arange(32000) / 16000
        tone = (.1 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
        channels = np.stack([tone, -tone])
        with tempfile.TemporaryDirectory() as folder:
            raw, clear = Path(folder) / "raw.wav", Path(folder) / "clear.wav"
            with patch("audio_processing.decode_channels", return_value=channels), patch("audio_processing.get_speech_timestamps", return_value=[{"start": 0, "end": 32000}]):
                audio, info = prepare_audio("test", raw, clear)
            self.assertGreater(float(np.std(audio)), .01)
            self.assertEqual(info["selectedChannel"], 1)
            for path in (raw, clear):
                with wave.open(str(path)) as w:
                    self.assertEqual(w.getnchannels(), 1)
                    self.assertEqual(w.getnframes(), len(t))
                    self.assertEqual(w.getframerate(), 16000)

    def test_silence_reports_no_speech_but_keeps_playback(self):
        with tempfile.TemporaryDirectory() as folder:
            raw, clear = Path(folder) / "raw.wav", Path(folder) / "clear.wav"
            with patch("audio_processing.decode_channels", return_value=np.zeros((4, 16000), dtype=np.float32)), patch("audio_processing.get_speech_timestamps", return_value=[]):
                _, info = prepare_audio("test", raw, clear)
            self.assertEqual(info["speechSeconds"], 0)
            self.assertTrue(raw.exists() and clear.exists())


if __name__ == "__main__":
    unittest.main()
