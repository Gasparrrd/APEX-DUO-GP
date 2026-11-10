import http.server
import json
import socketserver
import threading
import time

PORT = 8765

# Stockage en mémoire du salon actif pour auto-découverte via tunnel (ex: localhost.run)
ACTIVE_ROOM_STATE = {
    "roomId": "",
    "hostName": "HÔTE",
    "updatedAt": 0.0,
}

# Relais P2P HTTP en mémoire par salon (fallback automatique multi-navigateurs / pare-feu strict)
P2P_LOCK = threading.Lock()
P2P_ROOMS = {}  # roomId -> {"seq": int, "events": list[dict], "fast": dict[senderId, dict], "updatedAt": float}


def _cleanup_old_rooms(now: float):
    expired = [rid for rid, r in P2P_ROOMS.items() if now - r.get("updatedAt", 0) > 600]
    for rid in expired:
        P2P_ROOMS.pop(rid, None)


class RacingHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        # Silence les logs d'API fréquents pour garder le terminal propre
        if len(args) > 0 and isinstance(args[0], str) and ("/api/room" in args[0] or "/api/p2p" in args[0]):
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
        parts = self.path.split("?", 1)
        clean_path = parts[0]
        query_str = parts[1] if len(parts) > 1 else ""

        if clean_path == "/api/room":
            payload = json.dumps(ACTIVE_ROOM_STATE).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        if clean_path == "/api/p2p":
            params = {}
            for kv in query_str.split("&"):
                if "=" in kv:
                    k, v = kv.split("=", 1)
                    params[k] = v
            room_id = str(params.get("room") or "").strip().upper()
            client_id = str(params.get("clientId") or "").strip()
            try:
                since_seq = int(params.get("since") or "0")
            except ValueError:
                since_seq = 0

            events_out = []
            fast_out = []
            last_seq = since_seq
            now = time.time()

            if room_id:
                with P2P_LOCK:
                    room = P2P_ROOMS.get(room_id)
                    if room:
                        room["updatedAt"] = now
                        last_seq = room["seq"]
                        events_out = [
                            ev["msg"]
                            for ev in room["events"]
                            if ev["seq"] > since_seq and ev.get("sender") != client_id
                        ]
                        for sender_id, pkt in room["fast"].items():
                            if sender_id != client_id and now - pkt.get("ts", 0) < 3.0:
                                fast_out.append(pkt["floats"])

            payload = json.dumps({
                "ok": True,
                "seq": last_seq,
                "events": events_out,
                "fast": fast_out,
            }).encode("utf-8")
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

        if clean_path == "/api/p2p":
            length = int(self.headers.get("Content-Length", "0") or "0")
            raw = self.rfile.read(length) if length > 0 else b"{}"
            now = time.time()
            try:
                data = json.loads(raw.decode("utf-8"))
                if isinstance(data, dict):
                    room_id = str(data.get("room") or "").strip().upper()
                    client_id = str(data.get("clientId") or "").strip()
                    if room_id:
                        with P2P_LOCK:
                            _cleanup_old_rooms(now)
                            room = P2P_ROOMS.setdefault(room_id, {
                                "seq": 0,
                                "events": [],
                                "fast": {},
                                "updatedAt": now,
                            })
                            room["updatedAt"] = now
                            ctrl_msg = data.get("msg")
                            if isinstance(ctrl_msg, dict):
                                room["seq"] += 1
                                room["events"].append({
                                    "seq": room["seq"],
                                    "sender": client_id,
                                    "msg": ctrl_msg,
                                    "ts": now,
                                })
                                if len(room["events"]) > 120:
                                    room["events"] = room["events"][-80:]
                            fast_floats = data.get("fast")
                            if isinstance(fast_floats, list) and client_id:
                                room["fast"][client_id] = {
                                    "floats": fast_floats,
                                    "ts": now,
                                }
            except Exception:
                pass

            payload = b'{"ok":true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        self.send_error(404, "Not Found")


if __name__ == "__main__":
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("0.0.0.0", PORT), RacingHTTPRequestHandler) as httpd:
        httpd.serve_forever()
