#!/usr/bin/env python3
import argparse
import hmac
import json
import os
import re
import secrets
import shutil
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

VAULT_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")


def utc_id():
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + secrets.token_hex(3)


def safe_vault_name(value):
    if not VAULT_RE.fullmatch(value):
        raise ValueError("invalid vault id")
    return value


def safe_rel_path(value):
    value = unquote(value).replace("\\\\", "/")
    if value.startswith("/") or any(part in ("", ".", "..") for part in value.split("/")):
        raise ValueError("invalid relative path")
    return value


def atomic_json_write(path, value):
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temp, path)


class SyncHandler(BaseHTTPRequestHandler):
    server_version = "ObsidianSnapshotRelay/0.1"

    def _json(self, status, value):
        raw = json.dumps(value, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _error(self, status, message):
        self._json(status, {"error": message})

    def _auth(self):
        expected = self.server.sync_token
        actual = self.headers.get("Authorization", "")
        return bool(expected) and hmac.compare_digest(actual, "Bearer " + expected)

    def _body(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length > self.server.max_body:
            raise ValueError("request body too large")
        return self.rfile.read(length)

    def _parts(self):
        parsed = urlparse(self.path)
        parts = [unquote(item) for item in parsed.path.split("/") if item]
        return parts

    def _vault_root(self, vault):
        return self.server.data_root / safe_vault_name(vault)

    def _snapshot_root(self, vault, snapshot):
        if not re.fullmatch(r"^[A-Za-z0-9TZ-]+$", snapshot):
            raise ValueError("invalid snapshot id")
        return self._vault_root(vault) / "snapshots" / snapshot

    def _require_api(self, parts):
        if len(parts) < 4 or parts[0] != "v1" or parts[1] != "vaults":
            self._error(404, "not found")
            return None
        if not self._auth():
            self._error(401, "unauthorized")
            return None
        return parts[2]

    def do_GET(self):
        try:
            parts = self._parts()
            if parts == ["v1", "health"]:
                self._json(200, {"ok": True, "service": self.server_version})
                return
            vault = self._require_api(parts)
            if vault is None:
                return
            root = self._vault_root(vault)
            if parts[3] == "manifest" and len(parts) == 4:
                pointer = root / "latest.json"
                if not pointer.exists():
                    self._error(404, "no snapshot")
                    return
                snapshot = json.loads(pointer.read_text(encoding="utf-8"))["snapshotId"]
                manifest = self._snapshot_root(vault, snapshot) / "manifest.json"
                if not manifest.exists():
                    self._error(500, "latest manifest missing")
                    return
                self._json(200, json.loads(manifest.read_text(encoding="utf-8")))
                return
            if parts[3] == "snapshots" and len(parts) >= 6:
                snapshot = parts[4]
                snap_root = self._snapshot_root(vault, snapshot)
                if parts[5] == "manifest" and len(parts) == 6:
                    manifest = snap_root / "manifest.json"
                    if not manifest.exists():
                        self._error(404, "snapshot not found")
                        return
                    self._json(200, json.loads(manifest.read_text(encoding="utf-8")))
                    return
                if parts[5] == "files" and len(parts) >= 7:
                    rel = safe_rel_path("/".join(parts[6:]))
                    target = (snap_root / "files" / rel).resolve()
                    if not str(target).startswith(str((snap_root / "files").resolve()) + os.sep) or not target.is_file():
                        self._error(404, "file not found")
                        return
                    data = target.read_bytes()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/octet-stream")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
            self._error(404, "not found")
        except (ValueError, KeyError, json.JSONDecodeError) as error:
            self._error(400, str(error))
        except Exception as error:
            self._error(500, str(error))

    def do_POST(self):
        try:
            parts = self._parts()
            vault = self._require_api(parts)
            if vault is None:
                return
            root = self._vault_root(vault)
            if parts[3] == "snapshots" and len(parts) == 4:
                snapshot = utc_id()
                temp = root / ".tmp" / snapshot
                (temp / "files").mkdir(parents=True, exist_ok=False)
                self._json(201, {"snapshotId": snapshot})
                return
            if parts[3] == "snapshots" and len(parts) == 6 and parts[5] == "complete":
                snapshot = parts[4]
                temp = root / ".tmp" / snapshot
                if not temp.is_dir():
                    self._error(404, "snapshot upload not found")
                    return
                manifest = json.loads(self._body().decode("utf-8"))
                if manifest.get("schema") != 1 or manifest.get("snapshotId") != snapshot:
                    raise ValueError("invalid manifest")
                for record in manifest.get("files", []):
                    rel = safe_rel_path(record["path"])
                    target = temp / "files" / rel
                    if not target.is_file():
                        raise ValueError("missing uploaded file: " + rel)
                (temp / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
                final = root / "snapshots" / snapshot
                final.parent.mkdir(parents=True, exist_ok=True)
                os.replace(temp, final)
                atomic_json_write(root / "latest.json", {"snapshotId": snapshot, "updatedAt": datetime.now(timezone.utc).isoformat()})
                self._json(200, {"ok": True, "snapshotId": snapshot})
                return
            self._error(404, "not found")
        except (ValueError, KeyError, json.JSONDecodeError) as error:
            self._error(400, str(error))
        except Exception as error:
            self._error(500, str(error))

    def do_PUT(self):
        try:
            parts = self._parts()
            vault = self._require_api(parts)
            if vault is None:
                return
            if len(parts) < 7 or parts[3] != "snapshots" or parts[5] != "files":
                self._error(404, "not found")
                return
            snapshot = parts[4]
            rel = safe_rel_path("/".join(parts[6:]))
            temp_root = self._vault_root(vault) / ".tmp" / snapshot / "files"
            target = (temp_root / rel).resolve()
            if not str(target).startswith(str(temp_root.resolve()) + os.sep):
                raise ValueError("invalid file path")
            target.parent.mkdir(parents=True, exist_ok=True)
            data = self._body()
            target.write_bytes(data)
            self._json(201, {"ok": True, "path": rel, "size": len(data)})
        except (ValueError, KeyError) as error:
            self._error(400, str(error))
        except Exception as error:
            self._error(500, str(error))

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("OBSIDIAN_RELAY_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("OBSIDIAN_RELAY_PORT", "8787")))
    parser.add_argument("--root", default=os.environ.get("OBSIDIAN_RELAY_ROOT", "./data"))
    parser.add_argument("--token", default=os.environ.get("OBSIDIAN_RELAY_TOKEN", ""))
    args = parser.parse_args()
    if not args.token:
        raise SystemExit("OBSIDIAN_RELAY_TOKEN is required")
    data_root = Path(args.root).expanduser().resolve()
    data_root.mkdir(parents=True, exist_ok=True)
    httpd = ThreadingHTTPServer((args.host, args.port), SyncHandler)
    httpd.data_root = data_root
    httpd.sync_token = args.token
    httpd.max_body = 256 * 1024 * 1024
    print("Obsidian Snapshot Relay listening on %s:%d, data=%s" % (args.host, args.port, data_root))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
