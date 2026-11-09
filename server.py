import http.server
import json
import socketserver
import time

PORT = 8765

# Stockage en mémoire du salon actif pour auto-découverte via tunnel (ex: localhost.run)
ACTIVE_ROOM_STATE = {
    "roomId": "",
    "hostName": "HÔTE",
    "updatedAt": 0.0,
}


class RacingHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        # Silence les logs d'API fréquents pour garder le terminal propre
        if len(args) > 0 and isinstance(args[0], str) and "/api/room" in args[0]:
            return
        super().log_message(format, *args)

    def end_headers(self):
        path = self.path.split("?", 1)[0].lower()
        # Cache long pour l'audio (.mp3) et les librairies tierces (vendor/) afin d'alléger le tunnel SSH
        if path.endswith(".mp3") or "/vendor/" in path or path.endswith(".woff2") or path.endswith(".png"):
            self.send_header("Cache-Control", "public, max-age=86400")
        else:
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_GET(self):
        clean_path = self.path.split("?", 1)[0]
        if clean_path == "/api/room":
            payload = json.dumps(ACTIVE_ROOM_STATE).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        super().do_GET()

    def do_POST(self):
        clean_path = self.path.split("?", 1)[0]
        if clean_path == "/api/room":
            length = int(self.headers.get("Content-Length", "0") or "0")
            raw = self.rfile.read(length) if length > 0 else b"{}"
            try:
                data = json.loads(raw.decode("utf-8"))
                if isinstance(data, dict):
                    ACTIVE_ROOM_STATE["roomId"] = str(data.get("roomId") or "").strip()
                    ACTIVE_ROOM_STATE["hostName"] = str(data.get("hostName") or "HÔTE").strip()
                    ACTIVE_ROOM_STATE["updatedAt"] = time.time()
            except Exception:
                pass
            payload = json.dumps({"ok": True, **ACTIVE_ROOM_STATE}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_error(404, "Not Found")


if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), RacingHTTPRequestHandler) as httpd:
        httpd.serve_forever()
