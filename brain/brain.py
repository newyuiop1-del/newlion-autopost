#!/usr/bin/env python3
"""Brain - สมองกลเชื่อมทุกไฟล์ในคอมคุณ และคอมเครื่องอื่นๆ

ใช้ Python มาตรฐานอย่างเดียว (ไม่ต้อง pip install อะไร)

    python brain.py serve                      # สแกนเครื่องนี้ + เปิดหน้าสมอง http://localhost:8765
    python brain.py serve --lan --token XYZ    # เปิดให้คอมเครื่องอื่นในบ้านส่งข้อมูลเข้ามาได้
    python brain.py push --hub http://192.168.1.10:8765 --token XYZ   # (รันบนคอมเครื่องอื่น)
    python brain.py scan ~/Documents -o graph.json                     # สแกนอย่างเดียว

ส่งเฉพาะ "ข้อมูลเกี่ยวกับไฟล์" (ชื่อ ขนาด เวลา ความเชื่อมโยง) ไม่ส่งเนื้อหาไฟล์
"""
from __future__ import annotations

import argparse
import hmac
import json
import os
import platform
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
DATA_DIR = HERE / "data"
VERSION = 1

# ---------------------------------------------------------------- categories
# หมวดตรงกับ legend บนหน้าจอ
CATS = {
    "media": "วิดีโอ/สไลด์/คลิป",
    "code": "แอป/โค้ด",
    "doc": "โพสต์/เอกสาร",
    "brand": "แบรนด์/CI",
    "rules": "กฎ/นโยบาย/สัญญา",
    "data": "ข้อมูล/ตาราง",
    "other": "อื่นๆ",
}
EXT_CAT = {}
for cat, exts in {
    "media": "mp4 mov mkv avi webm m4v mp3 wav m4a aac flac jpg jpeg png gif webp heic bmp tif tiff ppt pptx key gifv",
    "code": "py js ts tsx jsx mjs cjs html css scss json yml yaml toml sh bat ps1 go rs java kt swift c h cpp hpp cs php rb dart vue svelte sql ipynb",
    "doc": "md markdown txt rtf doc docx odt pdf pages epub html5",
    "brand": "psd ai fig sketch xd svg ttf otf woff woff2 eps indd afphoto afdesign",
    "data": "csv tsv xls xlsx ods numbers db sqlite parquet xml",
}.items():
    for e in exts.split():
        EXT_CAT[e] = cat
RULE_WORDS = re.compile(
    r"(terms|privacy|policy|license|licence|contract|agreement|nda|tos|rule|legal|"
    r"สัญญา|นโยบาย|กฎ|ข้อตกลง|เงื่อนไข)", re.I)
BRAND_WORDS = re.compile(r"(logo|brand|ci[-_ ]|guideline|font|โลโก้|แบรนด์)", re.I)

SKIP_DIRS = {
    ".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv", "env",
    ".cache", ".npm", ".yarn", ".gradle", ".idea", ".vscode", "dist", "build",
    ".next", ".nuxt", "target", "Library", "AppData", "$RECYCLE.BIN",
    "System Volume Information", ".Trash", "Windows", "Program Files",
    "Program Files (x86)", "ProgramData", ".android", ".docker", "site-packages",
}
TEXT_EXTS = {e for e, c in EXT_CAT.items() if c in ("code", "doc", "data")} - {
    "pdf", "doc", "docx", "odt", "pages", "epub", "rtf", "xls", "xlsx", "ods",
    "numbers", "db", "sqlite", "parquet"}
TEXT_EXTS |= {"txt", "md", "csv", "xml", "svg", "ini", "cfg", "env.example"}
TOKEN_RE = re.compile(r"[\w\-฀-๿]+(?:\.[A-Za-z0-9]{1,6})?")


def categorize(path: Path) -> str:
    name = path.name
    if RULE_WORDS.search(name):
        return "rules"
    ext = path.suffix.lower().lstrip(".")
    cat = EXT_CAT.get(ext, "other")
    if cat in ("media", "other", "doc") and BRAND_WORDS.search(name):
        return "brand"
    return cat


def default_roots() -> list[Path]:
    home = Path.home()
    picks = [home / d for d in ("Desktop", "Documents", "Downloads", "Pictures",
                                "Videos", "Movies", "Music", "Projects", "dev", "code")]
    roots = [p for p in picks if p.is_dir()]
    return roots or [Path.cwd()]


# ---------------------------------------------------------------- scanning
def scan(roots: list[Path], machine: str, max_files: int = 4000,
         max_depth: int = 8, read_limit: int = 512_000) -> dict:
    """สร้างกราฟของเครื่องหนึ่งเครื่อง: เครื่อง -> โฟลเดอร์ -> ไฟล์ + เส้นอ้างอิงระหว่างไฟล์"""
    t0 = time.time()
    mid = f"pc:{machine}"
    nodes = {mid: {"id": mid, "name": machine, "kind": "machine", "machine": machine,
                   "cat": "machine", "os": f"{platform.system()} {platform.release()}"}}
    links: list[dict] = []
    files: list[tuple[str, Path]] = []

    def add_dir(path: Path, parent: str) -> str:
        nid = f"{machine}:{path.as_posix()}"
        if nid not in nodes:
            nodes[nid] = {"id": nid, "name": path.name or str(path), "kind": "dir",
                          "machine": machine, "cat": "dir", "path": str(path)}
            links.append({"source": parent, "target": nid, "type": "contains"})
        return nid

    for root in roots:
        root = root.expanduser().resolve()
        if not root.exists():
            print(f"  ข้าม (ไม่พบ): {root}", file=sys.stderr)
            continue
        rid = add_dir(root, mid)
        for dirpath, dirnames, filenames in os.walk(root):
            dp = Path(dirpath)
            depth = len(dp.relative_to(root).parts)
            dirnames[:] = sorted(d for d in dirnames
                                 if d not in SKIP_DIRS and not d.startswith(".")
                                 and depth < max_depth)
            pid = rid if dp == root else add_dir(dp, f"{machine}:{dp.parent.as_posix()}")
            for fn in sorted(filenames):
                if fn.startswith(".") or len(files) >= max_files:
                    continue
                fp = dp / fn
                try:
                    st = fp.stat()
                except OSError:
                    continue
                nid = f"{machine}:{fp.as_posix()}"
                nodes[nid] = {"id": nid, "name": fn, "kind": "file", "machine": machine,
                              "cat": categorize(fp), "path": str(fp), "size": st.st_size,
                              "mtime": int(st.st_mtime)}
                links.append({"source": pid, "target": nid, "type": "contains"})
                files.append((nid, fp))
            if len(files) >= max_files:
                print(f"  ถึงขีดจำกัด {max_files} ไฟล์แล้ว (ปรับได้ด้วย --max-files)",
                      file=sys.stderr)
                break

    # ---- เส้นอ้างอิง: ไฟล์ข้อความที่พูดถึงชื่อไฟล์อื่น / import โมดูลอื่น
    by_name: dict[str, list[str]] = {}
    by_stem: dict[str, list[str]] = {}
    for nid, fp in files:
        by_name.setdefault(fp.name.lower(), []).append(nid)
        if nodes[nid]["cat"] == "code" and len(fp.stem) >= 3:
            by_stem.setdefault(fp.stem.lower(), []).append(nid)
    seen = set()
    for nid, fp in files:
        ext = fp.suffix.lower().lstrip(".")
        if ext not in TEXT_EXTS or nodes[nid]["size"] > read_limit:
            continue
        try:
            text = fp.read_text("utf-8", errors="ignore")
        except OSError:
            continue
        is_code = nodes[nid]["cat"] == "code"
        for tok in set(TOKEN_RE.findall(text)):
            t = tok.lower()
            targets = by_name.get(t, [])
            if is_code and not targets:
                targets = by_stem.get(t, [])
            if len(targets) > 6:      # ชื่อทั่วไปเกินไป เช่น index.html
                continue
            for tgt in targets:
                key = (nid, tgt)
                if tgt != nid and key not in seen:
                    seen.add(key)
                    links.append({"source": nid, "target": tgt, "type": "ref"})

    print(f"  {machine}: {len(files)} ไฟล์, {len(nodes) - len(files) - 1} โฟลเดอร์, "
          f"{len(seen)} เส้นอ้างอิง ({time.time() - t0:.1f}s)", file=sys.stderr)
    return {"version": VERSION, "machine": machine, "scanned_at": int(time.time()),
            "roots": [str(r) for r in roots], "nodes": list(nodes.values()), "links": links}


# ---------------------------------------------------------------- merging
def merge(graphs: list[dict]) -> dict:
    """รวมกราฟหลายเครื่อง + เชื่อมไฟล์ที่เหมือนกันข้ามเครื่อง (ชื่อ+ขนาดเดียวกัน)"""
    nodes, links, machines = [], [], []
    brain = {"id": "brain", "name": "BRAIN", "kind": "brain", "cat": "brain", "machine": "*"}
    nodes.append(brain)
    twins: dict[tuple, list[str]] = {}
    for g in graphs:
        machines.append({"name": g["machine"], "scanned_at": g.get("scanned_at"),
                         "files": sum(1 for n in g["nodes"] if n["kind"] == "file")})
        nodes.extend(g["nodes"])
        links.extend(g["links"])
        links.append({"source": "brain", "target": f"pc:{g['machine']}", "type": "network"})
        for n in g["nodes"]:
            if n["kind"] == "file" and n.get("size", 0) > 0:
                twins.setdefault((n["name"].lower(), n["size"]), []).append(n["id"])
    for ids in twins.values():
        if 1 < len(ids) <= 8:
            for a, b in zip(ids, ids[1:]):
                if a.split(":", 1)[0] != b.split(":", 1)[0]:
                    links.append({"source": a, "target": b, "type": "twin"})
    return {"nodes": nodes, "links": links, "machines": machines, "cats": CATS}


# ---------------------------------------------------------------- storage
def safe_name(s: str) -> str:
    return re.sub(r"[^\w\-.฀-๿]", "_", s)[:64] or "pc"


def save_graph(g: dict) -> None:
    DATA_DIR.mkdir(exist_ok=True)
    (DATA_DIR / f"{safe_name(g['machine'])}.json").write_text(
        json.dumps(g, ensure_ascii=False), "utf-8")


def load_graphs() -> list[dict]:
    if not DATA_DIR.is_dir():
        return []
    out = []
    for p in sorted(DATA_DIR.glob("*.json")):
        try:
            out.append(json.loads(p.read_text("utf-8")))
        except (OSError, ValueError):
            pass
    return out


# ---------------------------------------------------------------- server
def open_local(path: str) -> None:
    if sys.platform.startswith("win"):
        os.startfile(path)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", path])
    else:
        subprocess.Popen(["xdg-open", str(Path(path).parent)])


def make_handler(cfg):
    class H(BaseHTTPRequestHandler):
        server_version = "Brain/1"

        def log_message(self, fmt, *a):
            if cfg.verbose:
                super().log_message(fmt, *a)

        def _send(self, code, body, ctype="application/json; charset=utf-8"):
            if isinstance(body, (dict, list)):
                body = json.dumps(body, ensure_ascii=False).encode()
            elif isinstance(body, str):
                body = body.encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _authed(self) -> bool:
            if not cfg.token:
                return self.client_address[0] in ("127.0.0.1", "::1")
            got = self.headers.get("X-Brain-Token", "")
            if not got:
                got = parse_qs(urlparse(self.path).query).get("token", [""])[0]
            return hmac.compare_digest(got, cfg.token)

        def do_GET(self):
            u = urlparse(self.path)
            if u.path in ("/", "/index.html"):
                return self._send(200, (HERE / "viewer.html").read_bytes(),
                                  "text/html; charset=utf-8")
            if u.path == "/viewer.bundle.js":
                return self._send(200, (HERE / "viewer.bundle.js").read_bytes(),
                                  "text/javascript; charset=utf-8")
            if not self._authed():
                return self._send(401, {"error": "ต้องใช้ token"})
            if u.path == "/api/graph":
                return self._send(200, merge(load_graphs()))
            return self._send(404, {"error": "not found"})

        def do_POST(self):
            u = urlparse(self.path)
            if not self._authed():
                return self._send(401, {"error": "token ไม่ถูกต้อง"})
            n = int(self.headers.get("Content-Length", 0))
            if n > 200_000_000:
                return self._send(413, {"error": "ใหญ่เกินไป"})
            raw = self.rfile.read(n) if n else b"{}"
            try:
                body = json.loads(raw or b"{}")
            except ValueError:
                return self._send(400, {"error": "JSON ไม่ถูกต้อง"})
            if u.path == "/api/push":
                if not isinstance(body, dict) or "machine" not in body or "nodes" not in body:
                    return self._send(400, {"error": "รูปแบบกราฟไม่ถูกต้อง"})
                save_graph(body)
                print(f"  รับข้อมูลจาก {body['machine']} ({len(body['nodes'])} โหนด)")
                return self._send(200, {"ok": True})
            if u.path == "/api/rescan":
                save_graph(scan(cfg.roots, cfg.machine, cfg.max_files))
                return self._send(200, {"ok": True})
            if u.path == "/api/open":
                node_id = str(body.get("id", ""))
                mach, _, path = node_id.partition(":")
                if mach != cfg.machine or not Path(path).exists():
                    return self._send(400, {"error": "เปิดได้เฉพาะไฟล์บนเครื่องนี้"})
                open_local(path)
                return self._send(200, {"ok": True})
            return self._send(404, {"error": "not found"})

    return H


def lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


def cmd_serve(a):
    a.roots = [Path(r) for r in a.paths] or default_roots()
    if a.lan and not a.token:
        sys.exit("เปิด --lan ต้องตั้ง --token ด้วย เช่น --token " + os.urandom(6).hex())
    if not a.no_scan:
        print(f"กำลังสแกน {a.machine}: {', '.join(map(str, a.roots))}")
        save_graph(scan(a.roots, a.machine, a.max_files))
    host = "0.0.0.0" if a.lan else "127.0.0.1"
    srv = ThreadingHTTPServer((host, a.port), make_handler(a))
    q = f"?token={a.token}" if a.token else ""
    print(f"\n🧠 สมองพร้อมแล้ว → http://localhost:{a.port}/{q}")
    if a.lan:
        print(f"   คอมเครื่องอื่นส่งข้อมูลเข้ามาด้วย:\n"
              f"   python brain.py push --hub http://{lan_ip()}:{a.port} --token {a.token}")
    if a.every:
        def loop():
            while True:
                time.sleep(a.every)
                save_graph(scan(a.roots, a.machine, a.max_files))
        threading.Thread(target=loop, daemon=True).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


def cmd_push(a):
    roots = [Path(r) for r in a.paths] or default_roots()
    while True:
        g = scan(roots, a.machine, a.max_files)
        req = urllib.request.Request(
            a.hub.rstrip("/") + "/api/push", data=json.dumps(g, ensure_ascii=False).encode(),
            headers={"Content-Type": "application/json", "X-Brain-Token": a.token or ""})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                print(f"ส่งเข้าสมองที่ {a.hub} แล้ว: {r.read().decode()}")
        except Exception as e:  # noqa: BLE001
            print(f"ส่งไม่สำเร็จ: {e}", file=sys.stderr)
        if not a.every:
            break
        time.sleep(a.every)


def cmd_scan(a):
    g = scan([Path(r) for r in a.paths] or default_roots(), a.machine, a.max_files)
    if a.output:
        Path(a.output).write_text(json.dumps(g, ensure_ascii=False, indent=1), "utf-8")
        print(f"บันทึกที่ {a.output}")
    else:
        save_graph(g)
        print(f"บันทึกที่ {DATA_DIR}")


def main(argv=None):
    p = argparse.ArgumentParser(description="Brain - สมองกลเชื่อมทุกอย่างในคอม")
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp):
        sp.add_argument("paths", nargs="*", help="โฟลเดอร์ที่จะสแกน (ค่าเริ่มต้น: Desktop/Documents/...)")
        sp.add_argument("--machine", default=socket.gethostname(), help="ชื่อเครื่อง")
        sp.add_argument("--max-files", type=int, default=4000)
        sp.add_argument("--every", type=int, default=0, help="สแกนซ้ำทุกกี่วินาที (0 = ครั้งเดียว)")

    s = sub.add_parser("serve", help="สแกนเครื่องนี้ + เปิดหน้าสมอง")
    common(s)
    s.add_argument("--port", type=int, default=8765)
    s.add_argument("--lan", action="store_true", help="ให้เครื่องอื่นในวงแลนเชื่อมเข้ามาได้")
    s.add_argument("--token", default=os.environ.get("BRAIN_TOKEN", ""))
    s.add_argument("--no-scan", action="store_true")
    s.add_argument("-v", "--verbose", action="store_true")
    s.set_defaults(fn=cmd_serve)

    s = sub.add_parser("push", help="สแกนเครื่องนี้แล้วส่งเข้าสมองกลาง")
    common(s)
    s.add_argument("--hub", required=True, help="เช่น http://192.168.1.10:8765")
    s.add_argument("--token", default=os.environ.get("BRAIN_TOKEN", ""))
    s.set_defaults(fn=cmd_push)

    s = sub.add_parser("scan", help="สแกนอย่างเดียว")
    common(s)
    s.add_argument("-o", "--output")
    s.set_defaults(fn=cmd_scan)

    a = p.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    main()
