#!/usr/bin/env python3
"""Agent City collector.

Tails agent-harness transcripts (Claude Code, Codex, Hermes, Copilot, pi, plus a
process scan for other CLIs) and serves a live JSON snapshot at /state, along
with the static wallpaper page from ./web.

Stdlib only. Run: python3 collector.py [--port 8777]
"""
import argparse
import datetime as dt
import glob
import json
import os
import re
import sqlite3
import subprocess
import threading
import time
from collections import deque
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HOME = os.path.expanduser("~")
WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

WORKING_STALE = 8 * 60   # a "working" session with no writes for this long is treated as idle
IDLE_KEEP = 30 * 60      # idle sessions stay on the skyline this long after their last activity
POLL = 2.0


def midnight_ts():
    now = dt.datetime.now()
    return dt.datetime(now.year, now.month, now.day).timestamp()


def iso_ts(s):
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def project_name(cwd):
    if not cwd:
        return "unknown"
    cwd = cwd.rstrip("/")
    if cwd == HOME:
        return "~"
    parts = cwd.split("/")
    # .codex/worktrees/<id>/<repo>  -> repo
    if "worktrees" in parts:
        i = parts.index("worktrees")
        if i > 0 and parts[i - 1] in (".codex",):
            return parts[-1]
        if i > 0 and not parts[i - 1].startswith("."):
            return parts[i - 1]
        return parts[-1]
    return parts[-1]


class Session:
    __slots__ = ("id", "harness", "cwd", "project", "parent", "title", "state",
                 "last", "tokens", "sub", "started")

    def __init__(self, sid, harness):
        self.id = sid
        self.harness = harness
        self.cwd = None
        self.project = "unknown"
        self.parent = None
        self.title = None
        self.state = "idle"
        self.last = 0.0
        self.tokens = 0
        self.sub = False
        self.started = time.time()


class Tail:
    """Incremental line reader that survives truncation/rotation."""

    def __init__(self, path):
        self.path = path
        self.pos = 0
        self.ino = None
        self.buf = b""

    def read(self):
        try:
            st = os.stat(self.path)
        except FileNotFoundError:
            return []
        if self.ino != st.st_ino or st.st_size < self.pos:
            self.ino, self.pos, self.buf = st.st_ino, 0, b""
        if st.st_size == self.pos:
            return []
        with open(self.path, "rb") as f:
            f.seek(self.pos)
            chunk = f.read()
            self.pos = f.tell()
        data = self.buf + chunk
        lines = data.split(b"\n")
        self.buf = lines.pop()
        return lines


class Collector:
    def __init__(self):
        self.lock = threading.Lock()
        self.sessions = {}          # key -> Session
        self.tails = {}             # path -> Tail
        self.day = midnight_ts()
        self.tokens_today = {}      # harness -> int
        self.events = deque()       # (ts, harness, tokens) for rate calc
        self.claude_msgs = {}       # message id -> counted tokens (dedupe streaming rows)
        self.hermes_base = {}       # session id -> tokens counted at first sight today
        self.snapshot = {}

    # ---------------------------------------------------------------- helpers
    def add_tokens(self, harness, n, ts, sess=None, rate=True):
        if n <= 0 or ts is None or ts < self.day:
            return
        self.tokens_today[harness] = self.tokens_today.get(harness, 0) + n
        if rate:
            self.events.append((ts, harness, n))
        if sess is not None:
            sess.tokens += n

    def sess(self, key, harness):
        s = self.sessions.get(key)
        if s is None:
            s = self.sessions[key] = Session(key, harness)
        return s

    def tail(self, path):
        t = self.tails.get(path)
        if t is None:
            t = self.tails[path] = Tail(path)
        return t

    # ------------------------------------------------------------ Claude Code
    def scan_claude(self):
        root = os.path.join(HOME, ".claude", "projects")
        paths = glob.glob(os.path.join(root, "*", "*.jsonl")) + \
            glob.glob(os.path.join(root, "*", "*", "subagents", "*.jsonl"))
        for p in paths:
            try:
                mt = os.path.getmtime(p)
            except OSError:
                continue
            if mt < self.day and p not in self.tails:
                continue
            sub = "/subagents/" in p
            sid = os.path.basename(p)[:-6]
            key = "claude:" + sid
            s = self.sess(key, "claude")
            if sub:
                s.sub = True
                s.parent = "claude:" + os.path.basename(os.path.dirname(os.path.dirname(p)))
                if not s.title:
                    try:
                        with open(p[:-6] + ".meta.json") as mf:
                            s.title = (json.load(mf).get("description") or "")[:60] or None
                    except (OSError, ValueError):
                        pass
            for raw in self.tail(p).read():
                try:
                    d = json.loads(raw)
                except Exception:
                    continue
                ts = iso_ts(d.get("timestamp", "")) or mt
                if d.get("cwd") and not s.cwd:
                    s.cwd = d["cwd"]
                    s.project = project_name(s.cwd)
                t = d.get("type")
                if t == "custom-title" and d.get("customTitle"):
                    s.title = d["customTitle"][:60]
                elif t == "agent-name" and d.get("agentName") and not s.title:
                    s.title = d["agentName"][:60]
                elif t == "summary" and d.get("summary") and not s.title:
                    s.title = d["summary"][:60]
                if t not in ("assistant", "user"):
                    continue
                s.last = max(s.last, ts)
                msg = d.get("message") or {}
                if t == "assistant":
                    u = msg.get("usage") or {}
                    tot = (u.get("input_tokens", 0) + u.get("output_tokens", 0) +
                           u.get("cache_creation_input_tokens", 0) + u.get("cache_read_input_tokens", 0))
                    mid = msg.get("id")
                    if mid:
                        prev = self.claude_msgs.get(mid, 0)
                        if tot > prev:
                            self.claude_msgs[mid] = tot
                            self.add_tokens("claude", tot - prev, ts, s)
                    stop = msg.get("stop_reason")
                    content = msg.get("content") or []
                    has_tool = any(isinstance(c, dict) and c.get("type") == "tool_use" for c in content)
                    if stop == "end_turn" and not has_tool:
                        s.state = "idle"
                    else:
                        s.state = "working"
                else:
                    s.state = "working"
                    if not s.title and not d.get("isMeta"):
                        c = msg.get("content")
                        if isinstance(c, list):
                            c = next((b.get("text") for b in c if isinstance(b, dict) and b.get("type") == "text"), None)
                        if isinstance(c, str) and c.strip() and not c.lstrip().startswith("<"):
                            s.title = " ".join(c.split())[:48]

    # ------------------------------------------------------------------ Codex
    def scan_codex(self):
        now = dt.datetime.now()
        dirs = set()
        for back in range(0, 3):
            day = now - dt.timedelta(days=back)
            dirs.add(os.path.join(HOME, ".codex", "sessions", f"{day:%Y}", f"{day:%m}", f"{day:%d}"))
        for d_ in dirs:
            for p in glob.glob(os.path.join(d_, "*.jsonl")):
                try:
                    mt = os.path.getmtime(p)
                except OSError:
                    continue
                if mt < self.day and p not in self.tails:
                    continue
                key = "codex:" + os.path.basename(p)[:-6]
                s = self.sess(key, "codex")
                for raw in self.tail(p).read():
                    try:
                        d = json.loads(raw)
                    except Exception:
                        continue
                    ts = iso_ts(d.get("timestamp", "")) or mt
                    t = d.get("type")
                    pl = d.get("payload") or {}
                    if t == "session_meta":
                        s.cwd = pl.get("cwd")
                        s.project = project_name(s.cwd)
                        if pl.get("thread_source") == "subagent":
                            s.sub = True
                            s.title = pl.get("agent_nickname")
                            par = pl.get("parent_thread_id")
                            if par:
                                s.parent = "codex-thread:" + par
                        s.id = "codex-thread:" + (pl.get("id") or s.id)
                        continue
                    s.last = max(s.last, ts)
                    pt = pl.get("type")
                    if t == "event_msg" and pt == "token_count":
                        info = pl.get("info") or {}
                        last = info.get("last_token_usage") or {}
                        self.add_tokens("codex", last.get("total_tokens", 0), ts, s)
                        s.state = "working"
                    elif t == "event_msg" and pt in ("task_complete", "turn_aborted"):
                        s.state = "idle"
                    elif t == "event_msg" and pt == "task_started":
                        s.state = "working"
                    elif t == "response_item":
                        s.state = "working"

    # ----------------------------------------------------------------- Hermes
    def scan_hermes(self):
        db = os.path.join(HOME, ".hermes", "state.db")
        if not os.path.exists(db):
            return
        try:
            con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1)
            rows = con.execute(
                "select id, cwd, title, parent_session_id, ended_at, "
                "coalesce(last_activity_at, started_at), started_at, "
                "input_tokens+output_tokens+cache_read_tokens+cache_write_tokens, source "
                "from sessions where coalesce(last_activity_at, started_at) >= ?",
                (self.day - 3600,)).fetchall()
            con.close()
        except Exception:
            return
        for sid, cwd, title, parent, ended, last, started, tok, source in rows:
            key = "hermes:" + sid
            s = self.sess(key, "hermes")
            s.cwd = cwd
            s.project = project_name(cwd) if cwd else (source or "hermes")
            s.title = title
            s.last = last or started
            if parent:
                s.sub, s.parent = True, "hermes:" + parent
            tok = tok or 0
            first = sid not in self.hermes_base
            if first:
                # Sessions that started before midnight only count growth since first sight.
                self.hermes_base[sid] = 0 if (started or 0) >= self.day else tok
            prev = self.hermes_base[sid]
            if tok > prev:
                # backfill on first sight shouldn't register as a burst of traffic
                self.add_tokens("hermes", tok - prev, time.time(), s, rate=not first)
                self.hermes_base[sid] = tok
            s.state = "idle" if ended else ("working" if time.time() - s.last < 90 else "idle")

    # ------------------------------------------- mtime-only transcript harnesses
    MTIME_SOURCES = {
        "copilot": (".copilot/session-state/*/events.jsonl", lambda p: p.split("/")[-2]),
        "pi": (".pi/agent/sessions/**/*.jsonl", lambda p: os.path.basename(p)[:-6]),
        "gemini": (".gemini/tmp/*/chats/*.json", lambda p: os.path.basename(p)),
        "opencode": (".local/share/opencode/storage/session/**/*.json", lambda p: os.path.basename(p)),
    }

    def scan_mtime(self):
        now = time.time()
        for harness, (pattern, idf) in self.MTIME_SOURCES.items():
            for p in glob.glob(os.path.join(HOME, pattern), recursive=True):
                try:
                    mt = os.path.getmtime(p)
                except OSError:
                    continue
                if now - mt > IDLE_KEEP:
                    continue
                s = self.sess(f"{harness}:{idf(p)}", harness)
                s.last = mt
                s.state = "working" if now - mt < 45 else "idle"
                if harness == "copilot" and not s.cwd:
                    ws = os.path.join(os.path.dirname(p), "workspace.yaml")
                    try:
                        m = re.search(r"^cwd:\s*(.+)$", open(ws).read(), re.M)
                        if m:
                            s.cwd = m.group(1).strip().strip("'\"")
                            s.project = project_name(s.cwd)
                    except OSError:
                        pass

    # --------------------------------------------------- process-only harnesses
    PROC_PATTERNS = [
        ("gemini", re.compile(r"(^|/)gemini(\s|$)")),
        ("opencode", re.compile(r"(^|/)opencode(\s|$)")),
        ("aider", re.compile(r"(^|/)aider(\s|$)")),
        ("amp", re.compile(r"(^|/)amp(\s|$)")),
        ("droid", re.compile(r"(^|/)droid(\s|$)")),
        ("cursor", re.compile(r"(^|/)cursor-agent(\s|$)")),
        ("goose", re.compile(r"(^|/)goose(\s|$)")),
        ("crush", re.compile(r"(^|/)crush(\s|$)")),
    ]

    def scan_procs(self):
        try:
            out = subprocess.run(["ps", "-axo", "pid=,pcpu=,args="], capture_output=True,
                                 text=True, timeout=5).stdout
        except Exception:
            return
        now = time.time()
        for line in out.splitlines():
            parts = line.split(None, 2)
            if len(parts) < 3:
                continue
            pid, cpu, args = parts
            exe = args.split()[0]
            for harness, rx in self.PROC_PATTERNS:
                if rx.search(os.path.basename(exe) + " ") or rx.search(exe):
                    s = self.sess(f"{harness}:pid{pid}", harness)
                    s.last = now
                    s.state = "working" if float(cpu) > 4 else "idle"
                    if not s.cwd:
                        s.cwd = self.proc_cwd(pid)
                        s.project = project_name(s.cwd)
                    break

    @staticmethod
    def proc_cwd(pid):
        try:
            out = subprocess.run(["/usr/sbin/lsof", "-a", "-p", pid, "-d", "cwd", "-Fn"],
                                 capture_output=True, text=True, timeout=3).stdout
            for l in out.splitlines():
                if l.startswith("n"):
                    return l[1:]
        except Exception:
            pass
        return None

    # --------------------------------------------------------------- snapshot
    def tick(self):
        md = midnight_ts()
        if md != self.day:
            self.day = md
            self.tokens_today.clear()
            self.claude_msgs.clear()
            self.hermes_base.clear()
            for s in self.sessions.values():
                s.tokens = 0
        for fn in (self.scan_claude, self.scan_codex, self.scan_hermes, self.scan_mtime, self.scan_procs):
            try:
                fn()
            except Exception as e:  # never let one harness take down the city
                print(f"[collector] {fn.__name__}: {e}", flush=True)
        self.build()

    def build(self):
        now = time.time()
        while self.events and now - self.events[0][0] > 300:
            self.events.popleft()
        rate = {}
        for ts, h, n in self.events:
            if now - ts <= 60:
                rate[h] = rate.get(h, 0) + n

        # alias codex sessions by thread id so subagent parents resolve
        alias = {s.id: k for k, s in self.sessions.items() if s.harness == "codex"}
        agents = []
        dead = []
        for key, s in self.sessions.items():
            age = now - s.last if s.last else 1e9
            if age > IDLE_KEEP:
                if age > 6 * 3600:
                    dead.append(key)
                continue
            state = s.state
            if state == "working" and age > WORKING_STALE:
                state = "idle"
            parent = alias.get(s.parent, s.parent) if s.parent else None
            agents.append({
                "id": key, "harness": s.harness, "project": s.project, "cwd": s.cwd,
                "title": s.title, "state": state, "sub": s.sub, "parent": parent,
                "tokens": s.tokens, "age": round(age, 1),
            })
        for k in dead:
            self.sessions.pop(k, None)

        # subagents whose parent is gone become top-level
        ids = {a["id"] for a in agents}
        for a in agents:
            if a["parent"] and a["parent"] not in ids:
                a["parent"] = None
        agents.sort(key=lambda a: a["id"])
        working = [a for a in agents if a["state"] == "working"]
        harnesses = {}
        for h in set(list(self.tokens_today) + [a["harness"] for a in agents]):
            ha = [a for a in agents if a["harness"] == h]
            harnesses[h] = {
                "working": sum(1 for a in ha if a["state"] == "working"),
                "idle": sum(1 for a in ha if a["state"] == "idle"),
                "subagents": sum(1 for a in ha if a["sub"] and a["state"] == "working"),
                "tokensToday": self.tokens_today.get(h, 0),
                "tpm": rate.get(h, 0),
            }
        snap = {
            "t": now,
            "agents": agents,
            "harnesses": harnesses,
            "projects": sorted({a["project"] for a in working}),
            "working": len(working),
            "idle": len(agents) - len(working),
            "subagents": sum(1 for a in working if a["sub"]),
            "tokensToday": sum(self.tokens_today.values()),
            "tpm": sum(rate.values()),
        }
        with self.lock:
            self.snapshot = snap

    def run(self):
        while True:
            t0 = time.time()
            self.tick()
            time.sleep(max(0.2, POLL - (time.time() - t0)))


COL = Collector()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=WEB, **kw)

    def do_GET(self):
        if self.path.startswith("/state"):
            with COL.lock:
                body = json.dumps(COL.snapshot).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8777)
    ap.add_argument("--once", action="store_true", help="print one snapshot and exit")
    args = ap.parse_args()
    if args.once:
        COL.tick()
        print(json.dumps(COL.snapshot, indent=1))
        return
    COL.tick()
    threading.Thread(target=COL.run, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[collector] serving http://127.0.0.1:{args.port}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
