"""Local studio server. Discovers the recorder using mDNS, without a fixed IP."""
import argparse
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
from pathlib import Path
import select
import socket
import struct
import threading
import time
from urllib.parse import urlsplit, unquote
import webbrowser
from local_transcription import TranscriptionJobs

ROOT = Path(__file__).resolve().parent
HOSTNAME = "esp32.local"


def read_name(packet, offset):
    labels, visited, end = [], set(), None
    while True:
        if offset in visited or offset >= len(packet):
            raise ValueError("Invalid DNS name")
        visited.add(offset)
        length = packet[offset]
        if length & 0xC0 == 0xC0:
            if offset + 1 >= len(packet):
                raise ValueError("Truncated DNS pointer")
            if end is None:
                end = offset + 2
            offset = ((length & 0x3F) << 8) | packet[offset + 1]
            continue
        if length & 0xC0 or offset + 1 + length > len(packet):
            raise ValueError("Invalid DNS label")
        offset += 1
        if not length:
            return ".".join(labels).lower(), end if end is not None else offset
        labels.append(packet[offset:offset + length].decode("ascii"))
        offset += length


def find_address(packet):
    if len(packet) < 12:
        return None
    _, flags, questions, answers, authority, additional = struct.unpack("!6H", packet[:12])
    if not flags & 0x8000 or flags & 15:
        return None
    offset = 12
    for _ in range(questions):
        _, offset = read_name(packet, offset)
        offset += 4
    for _ in range(answers + authority + additional):
        name, offset = read_name(packet, offset)
        kind, klass, ttl, length = struct.unpack_from("!HHIH", packet, offset)
        offset += 10
        if offset + length > len(packet):
            raise ValueError("Truncated DNS record")
        if name == HOSTNAME and kind == 1 and klass & 0x7FFF == 1 and length == 4 and ttl:
            address = ipaddress.IPv4Address(packet[offset:offset + 4])
            if address.is_private and not address.is_loopback and not address.is_unspecified and not address.is_multicast:
                return str(address), min(ttl, 30)
        offset += length
    return None


class Discovery:
    def __init__(self):
        self.lock = threading.Lock()
        self.address = None
        self.expires = 0

    def invalidate(self):
        with self.lock:
            self.expires = 0

    def resolve(self):
        with self.lock:
            if self.address and time.monotonic() < self.expires:
                return self.address
            # QU requests a unicast response to this mDNS query. Query each local
            # IPv4 interface so Hyper-V adapters cannot steal the multicast route.
            interfaces = {"0.0.0.0"}
            try:
                interfaces.update(item[4][0] for item in socket.getaddrinfo(socket.gethostname(), 0, socket.AF_INET))
            except OSError:
                pass
            packet = struct.pack("!6H", 0, 0, 1, 0, 0, 0) + b"\x05esp32\x05local\x00" + struct.pack("!HH", 1, 0x8001)
            sockets = []
            try:
                for interface in interfaces:
                    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
                    try:
                        sock.bind((interface, 0))
                        sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(interface))
                        sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 255)
                        sock.setblocking(False)
                        sockets.append(sock)
                    except OSError:
                        sock.close()
                for _ in range(3):
                    for sock in sockets:
                        try:
                            sock.sendto(packet, ("224.0.0.251", 5353))
                        except OSError:
                            pass
                    deadline = time.monotonic() + 1
                    while sockets and time.monotonic() < deadline:
                        ready, _, _ = select.select(sockets, [], [], max(0, deadline - time.monotonic()))
                        for sock in ready:
                            try:
                                response, sender = sock.recvfrom(9000)
                                result = find_address(response) if sender[1] == 5353 else None
                                if result:
                                    self.address, ttl = result
                                    self.expires = time.monotonic() + ttl
                                    return self.address
                            except (OSError, ValueError, struct.error, UnicodeError):
                                pass
            finally:
                for sock in sockets:
                    sock.close()
            raise OSError("No mDNS reply from esp32.local. Check ESP32 power, Wi-Fi, and the Serial Monitor mDNS message.")


discovery = Discovery()
transcriptions = TranscriptionJobs(discovery)


class StudioHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def dispatch(self):
        expected = f"127.0.0.1:{self.server.server_port}"
        if self.headers.get("Host") not in (expected, f"localhost:{self.server.server_port}"):
            self.reply(403, b"Local access only", "text/plain")
            return
        origin = self.headers.get("Origin")
        if origin and origin not in (f"http://{expected}", f"http://localhost:{self.server.server_port}"):
            self.reply(403, b"Open the local studio to control the recorder", "text/plain")
            return
        path = urlsplit(self.path).path
        if path.startswith("/api/transcriptions/") and self.command == "GET":
            job = transcriptions.get(path.rsplit("/", 1)[-1])
            self.reply(200 if job else 404, json.dumps(job or {"error": "Conversion job not found. Click Convert again."}).encode(), "application/json")
            return
        if path.startswith("/api/files/") and path.endswith("/transcribe") and self.command == "POST":
            try:
                filename = unquote(path[len("/api/files/"):-len("/transcribe")])
                job_id = transcriptions.submit(filename)
                self.reply(202, json.dumps({"jobId": job_id}).encode(), "application/json")
            except ValueError as error:
                self.reply(400, json.dumps({"error": str(error)}).encode(), "application/json")
            return
        if path.startswith("/api/"):
            self.proxy()
            return
        files = {"/": ("index.html", "text/html; charset=utf-8"), "/index.html": ("index.html", "text/html; charset=utf-8"), "/app.js": ("app.js", "text/javascript; charset=utf-8"), "/styles.css": ("styles.css", "text/css; charset=utf-8")}
        if self.command != "GET" or path not in files:
            self.reply(404, b"Not found", "text/plain")
            return
        name, content_type = files[path]
        body = (ROOT / name).read_bytes()
        if name == "index.html":
            body = body.replace(b"<head>", b"<head><script>window.STUDIO_MDNS_PROXY = true;</script>", 1)
        self.reply(200, body, content_type)

    def proxy(self):
        connection = None
        started = False
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > 33 * 1024 * 1024 or self.headers.get("Transfer-Encoding"):
                self.reply(413, b"Request too large or unsupported encoding", "text/plain")
                return
            address = discovery.resolve()
            body = self.rfile.read(length) if length else None
            headers = {key: self.headers[key] for key in ("Content-Type", "Range", "If-Range") if key in self.headers}
            headers["Host"] = HOSTNAME
            connection = http.client.HTTPConnection(address, 80, timeout=120)
            # Do not retry writes: recording/upload commands may already have run.
            connection.request(self.command, self.path, body=body, headers=headers)
            response = connection.getresponse()
            self.send_response(response.status)
            for key in ("Content-Type", "Content-Length", "Content-Disposition", "Content-Range", "Accept-Ranges"):
                if response.getheader(key) is not None:
                    self.send_header(key, response.getheader(key))
            self.send_header("Connection", "close")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            started = True
            self.close_connection = True
            while chunk := response.read(65536):
                self.wfile.write(chunk)
        except (OSError, ValueError, http.client.HTTPException) as error:
            discovery.invalidate()
            if not started:
                self.reply(502, json.dumps({"error": f"mDNS connection to esp32.local failed: {error}"}).encode(), "application/json")
        finally:
            if connection:
                connection.close()

    do_GET = dispatch
    do_POST = dispatch
    do_DELETE = dispatch


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--open", action="store_true")
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), StudioHandler)
    if args.open:
        webbrowser.open(f"http://localhost:{args.port}")
    server.serve_forever()
