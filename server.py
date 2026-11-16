import datetime
import http.server
import json
import os
import socketserver
import threading
import time
import urllib.parse
import uuid

PORT = 8765
ROOT = os.path.dirname(os.path.abspath(__file__))
RECORDS_FILE = os.path.join(ROOT, "records_data.json")
RECORDS_LOCK = threading.Lock()

VALID_CIRCUITS = ("flat", "mountain", "valley", "lake", "grotto")
VALID_LAPS = ("2", "3", "5")
MAX_RECORDS_BODY_BYTES = 1_500_000


def _default_records_store():
    return {
        "devicePseudos": {},
        "leaderboards": {
            cid: {
                "bestLap": [],
                "race": {laps: [] for laps in VALID_LAPS},
            }
            for cid in VALID_CIRCUITS
        },
        "ghosts": {},
    }


def _sanitize_device_id(raw):
    clean = "".join(ch for ch in str(raw or "").strip() if ch.isalnum() or ch in "-_")
    return clean[:64]


def _apply_device_pseudo(store, device_id, pseudo):
    if not device_id or len(pseudo) < 2:
        return
    device_pseudos = store.setdefault("devicePseudos", {})
    device_pseudos[device_id] = pseudo
    leaderboards = store.get("leaderboards", {})
    for cid in VALID_CIRCUITS:
        c_board = leaderboards.get(cid)
        if not isinstance(c_board, dict):
            continue
        for e in c_board.get("bestLap", []):
            if isinstance(e, dict) and e.get("deviceId") == device_id:
                e["pseudo"] = pseudo
        race_map = c_board.get("race", {})
        if isinstance(race_map, dict):
            for laps in VALID_LAPS:
                for e in race_map.get(laps, []):
                    if isinstance(e, dict) and e.get("deviceId") == device_id:
                        e["pseudo"] = pseudo
    for g in store.get("ghosts", {}).values():
        if isinstance(g, dict) and g.get("deviceId") == device_id:
            g["pseudo"] = pseudo


def _dedup_and_sort_top3(entries, device_pseudos):
    if not isinstance(entries, list):
        return []
    valid = [dict(e) for e in entries if isinstance(e, dict) and isinstance(e.get("time"), (int, float))]
    valid.sort(key=lambda e: float(e["time"]))
    seen_devices = set()
    out = []
    for e in valid:
        did = _sanitize_device_id(e.get("deviceId"))
        if did:
            e["deviceId"] = did
            if did in device_pseudos:
                e["pseudo"] = device_pseudos[did]
            if did in seen_devices:
                continue
            seen_devices.add(did)
        out.append(e)
        if len(out) >= 3:
            break
    return out


def _normalize_records_store(data):
    store = _default_records_store()
    if not isinstance(data, dict):
        return store

    raw_dp = data.get("devicePseudos")
    if isinstance(raw_dp, dict):
        for k, v in raw_dp.items():
            did = _sanitize_device_id(k)
            pseudo = _sanitize_pseudo(v)
            if did and len(pseudo) >= 2:
                store["devicePseudos"][did] = pseudo

    device_pseudos = store["devicePseudos"]

    raw_lb = data.get("leaderboards")
    if isinstance(raw_lb, dict):
        for cid in VALID_CIRCUITS:
            c_raw = raw_lb.get(cid)
            if not isinstance(c_raw, dict):
                continue
            best_lap = c_raw.get("bestLap")
            if isinstance(best_lap, list):
                store["leaderboards"][cid]["bestLap"] = _dedup_and_sort_top3(best_lap, device_pseudos)

            raw_race = c_raw.get("race")
            if isinstance(raw_race, dict):
                for laps in VALID_LAPS:
                    r_list = raw_race.get(laps)
                    if isinstance(r_list, list):
                        store["leaderboards"][cid]["race"][laps] = _dedup_and_sort_top3(r_list, device_pseudos)

    raw_ghosts = data.get("ghosts")
    if isinstance(raw_ghosts, dict):
        for key, g_val in raw_ghosts.items():
            if isinstance(key, str) and isinstance(g_val, dict) and isinstance(g_val.get("samples"), list):
                g_copy = dict(g_val)
                did = _sanitize_device_id(g_copy.get("deviceId"))
                if did:
                    g_copy["deviceId"] = did
                    if did in device_pseudos:
                        g_copy["pseudo"] = device_pseudos[did]
                store["ghosts"][key] = g_copy

    # Synchronise le marqueur hasGhost dans les classements #1
    for cid in VALID_CIRCUITS:
        for laps in VALID_LAPS:
            r_list = store["leaderboards"][cid]["race"][laps]
            ghost_exists = f"{cid}_{laps}" in store["ghosts"]
            for idx, entry in enumerate(r_list):
                entry["hasGhost"] = bool(idx == 0 and ghost_exists)

    return store


def _load_records_store():
    if not os.path.exists(RECORDS_FILE):
        return _default_records_store()
    try:
        with open(RECORDS_FILE, "r", encoding="utf-8") as f:
            return _normalize_records_store(json.load(f))
    except Exception:
        return _default_records_store()


def _save_records_store(store):
    normalized = _normalize_records_store(store)
    tmp_path = f"{RECORDS_FILE}.tmp.{os.getpid()}.{threading.get_ident()}"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(normalized, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp_path, RECORDS_FILE)
    return normalized


def _sanitize_pseudo(raw):
    clean = " ".join(str(raw or "").strip().split())
    return clean[:16]


def _sanitize_car_config(raw):
    if not isinstance(raw, dict):
        return {}
    allowed = ("name", "bodyType", "color", "rims", "rimFinish", "spoiler", "neonColor")
    out = {}
    for k in allowed:
        if k in raw and isinstance(raw[k], (str, int, float, bool)):
            out[k] = raw[k]
    return out


def _insert_into_top3(board_list, new_entry):
    """Insère un enregistrement dans un Top 3 trié par temps croissant (1 place max par deviceId) et retourne (nouvelle_liste, rang_1_3_ou_None)."""
    entry_id = new_entry["entryId"]
    device_id = _sanitize_device_id(new_entry.get("deviceId"))
    if device_id:
        for existing in board_list:
            if isinstance(existing, dict) and existing.get("deviceId") == device_id:
                existing["pseudo"] = new_entry.get("pseudo", existing.get("pseudo"))
                if float(existing.get("time", 999999.0)) <= float(new_entry.get("time", 999999.0)):
                    sorted_list = sorted(
                        [e for e in board_list if isinstance(e, dict)],
                        key=lambda e: float(e.get("time", 999999.0)),
                    )[:3]
                    return sorted_list, None
        combined = [
            e for e in board_list
            if isinstance(e, dict) and e.get("entryId") != entry_id and e.get("deviceId") != device_id
        ]
    else:
        combined = [e for e in board_list if isinstance(e, dict) and e.get("entryId") != entry_id]

    combined.append(new_entry)
    combined.sort(key=lambda e: float(e.get("time", 999999.0)))
    top3 = combined[:3]
    rank = None
    for idx, e in enumerate(top3):
        if e.get("entryId") == entry_id:
            rank = idx + 1
            break
    return top3, rank

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
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        super().end_headers()

    def _send_json(self, obj, status=200):
        payload = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        parts = self.path.split("?", 1)
        clean_path = parts[0]
        query_str = parts[1] if len(parts) > 1 else ""

        if clean_path == "/api/records":
            with RECORDS_LOCK:
                store = _load_records_store()
            self._send_json({
                "ok": True,
                "leaderboards": store["leaderboards"],
                "devicePseudos": store.get("devicePseudos", {}),
            })
            return

        if clean_path == "/api/ghost":
            params = urllib.parse.parse_qs(query_str)
            circuit = str((params.get("circuit") or [""])[0]).strip()
            laps = str((params.get("laps") or [""])[0]).strip()
            if circuit not in VALID_CIRCUITS or laps not in VALID_LAPS:
                self._send_json({"ok": False, "error": "Invalid circuit or laps", "ghost": None}, status=400)
                return
            with RECORDS_LOCK:
                store = _load_records_store()
                ghost = store["ghosts"].get(f"{circuit}_{laps}")
            self._send_json({"ok": True, "ghost": ghost})
            return

        if clean_path == "/api/room":
            self._send_json(ACTIVE_ROOM_STATE)
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
        if clean_path in ("/api/records", "/api/records/pseudo"):
            length = int(self.headers.get("Content-Length", "0") or "0")
            if length <= 0 or length > MAX_RECORDS_BODY_BYTES:
                self._send_json({"ok": False, "error": "Invalid payload size"}, status=400)
                return
            raw = self.rfile.read(length)
            try:
                data = json.loads(raw.decode("utf-8"))
            except Exception:
                self._send_json({"ok": False, "error": "Invalid JSON"}, status=400)
                return

            if not isinstance(data, dict):
                self._send_json({"ok": False, "error": "Expected JSON object"}, status=400)
                return

            device_id = _sanitize_device_id(data.get("deviceId"))
            pseudo = _sanitize_pseudo(data.get("pseudo"))

            if clean_path == "/api/records/pseudo" or data.get("action") == "update_pseudo":
                if not device_id or len(pseudo) < 2:
                    self._send_json({"ok": False, "error": "Invalid deviceId or pseudo"}, status=400)
                    return
                with RECORDS_LOCK:
                    store = _load_records_store()
                    _apply_device_pseudo(store, device_id, pseudo)
                    store = _save_records_store(store)
                self._send_json({
                    "ok": True,
                    "deviceId": device_id,
                    "pseudo": pseudo,
                    "leaderboards": store["leaderboards"],
                    "devicePseudos": store.get("devicePseudos", {}),
                })
                return

            circuit = str(data.get("circuit") or "").strip()
            laps = str(data.get("laps") or "").strip()
            if circuit not in VALID_CIRCUITS or laps not in VALID_LAPS or len(pseudo) < 2:
                self._send_json({"ok": False, "error": "Invalid circuit, laps or pseudo"}, status=400)
                return

            entry_id = str(data.get("entryId") or uuid.uuid4().hex[:12])[:32]
            car_config = _sanitize_car_config(data.get("carConfig"))
            now_iso = datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"

            best_lap_time = data.get("bestLapTime")
            total_race_time = data.get("totalRaceTime")
            ghost_raw = data.get("ghost")

            best_lap_rank = None
            race_rank = None

            with RECORDS_LOCK:
                store = _load_records_store()
                if device_id:
                    _apply_device_pseudo(store, device_id, pseudo)
                c_board = store["leaderboards"][circuit]

                if isinstance(best_lap_time, (int, float)) and 2.0 < float(best_lap_time) < 3600.0:
                    bl_entry = {
                        "entryId": entry_id,
                        "deviceId": device_id,
                        "pseudo": pseudo,
                        "time": round(float(best_lap_time), 4),
                        "carConfig": car_config,
                        "date": now_iso,
                    }
                    c_board["bestLap"], best_lap_rank = _insert_into_top3(c_board["bestLap"], bl_entry)

                if isinstance(total_race_time, (int, float)) and 4.0 < float(total_race_time) < 7200.0:
                    race_entry = {
                        "entryId": entry_id,
                        "deviceId": device_id,
                        "pseudo": pseudo,
                        "time": round(float(total_race_time), 4),
                        "carConfig": car_config,
                        "date": now_iso,
                        "hasGhost": False,
                    }
                    c_board["race"][laps], race_rank = _insert_into_top3(c_board["race"][laps], race_entry)

                    if race_rank == 1 and isinstance(ghost_raw, dict) and isinstance(ghost_raw.get("samples"), list) and len(ghost_raw["samples"]) >= 9:
                        clean_samples = []
                        for val in ghost_raw["samples"][:45000]:
                            if isinstance(val, (int, float)):
                                clean_samples.append(round(float(val), 4))
                            else:
                                clean_samples.append(0)
                        try:
                            sample_interval = float(ghost_raw.get("sampleInterval") or (1.0 / 15.0))
                        except (TypeError, ValueError):
                            sample_interval = 1.0 / 15.0
                        if sample_interval <= 0.005 or sample_interval > 1.0:
                            sample_interval = 1.0 / 15.0

                        store["ghosts"][f"{circuit}_{laps}"] = {
                            "entryId": entry_id,
                            "deviceId": device_id,
                            "pseudo": pseudo,
                            "time": round(float(total_race_time), 4),
                            "carConfig": car_config,
                            "sampleInterval": round(sample_interval, 6),
                            "samples": clean_samples,
                            "date": now_iso,
                        }

                store = _save_records_store(store)

            self._send_json({
                "ok": True,
                "entryId": entry_id,
                "deviceId": device_id,
                "bestLapRank": best_lap_rank,
                "raceRank": race_rank,
                "isNewBestLapWR": best_lap_rank == 1,
                "isNewRaceWR": race_rank == 1,
                "circuitRecords": store["leaderboards"][circuit],
                "leaderboards": store["leaderboards"],
                "devicePseudos": store.get("devicePseudos", {}),
            })
            return

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
