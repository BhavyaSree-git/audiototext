import tempfile
import threading
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from http.server import ThreadingHTTPServer
import studio_server


class PlaybackTests(unittest.TestCase):
    def test_audio_ranges_and_path_validation(self):
        with tempfile.TemporaryDirectory() as folder:
            key = "a" * 64
            directory = Path(folder) / ".processed" / key
            directory.mkdir(parents=True)
            (directory / "clear.wav").write_bytes(b"0123456789")
            with patch.object(studio_server, "ROOT", Path(folder)):
                server = ThreadingHTTPServer(("127.0.0.1", 0), studio_server.StudioHandler)
                worker = threading.Thread(target=server.serve_forever, daemon=True)
                worker.start()
                base = f"http://127.0.0.1:{server.server_port}/api/audio/"
                try:
                    with urlopen(Request(base + key + "/clear.wav", headers={"Range": "bytes=2-5"})) as response:
                        self.assertEqual(response.status, 206)
                        self.assertEqual(response.headers["Content-Range"], "bytes 2-5/10")
                        self.assertEqual(response.read(), b"2345")
                    for path, status in ((key + "/missing.wav", 404), ("../wifi_config.h", 404)):
                        with self.assertRaises(HTTPError) as error:
                            urlopen(base + path)
                        self.assertEqual(error.exception.code, status)
                finally:
                    server.shutdown()
                    server.server_close()
                    worker.join()


if __name__ == "__main__":
    unittest.main()
