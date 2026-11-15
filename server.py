"""Same-origin Discord sign-in and independent diary API."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from hashlib import sha256
from http.cookies import SimpleCookie
from pathlib import Path
from threading import RLock
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen
import json
import os
import re
import secrets

from storage import Store, SHOP_PRICES, diary_day

HERE = Path(__file__).resolve().parent
DISCORD_API = "https://discord.com/api/v10"
EMOJIS = {"❤️", "👏", "🔥", "👍", "🎉", "💯"}
ASSETS = {"/": ("index.html", "text/html"), "/app.js": ("app.js", "text/javascript"),
          "/style.css": ("style.css", "text/css"), "/config.js": ("config.js", "text/javascript")}
GUILD = 1  # A local ledger namespace, with no corresponding Discord server.
SESSION_TTL = timedelta(hours=12)


class Problem(Exception):
    def __init__(self, status, message):
        self.status = status
        super().__init__(message)


def hashed(value):
    return sha256(value.encode()).hexdigest()


def discord_json(url, data=None, token=None):
    headers = {"User-Agent": "DiaryWeb/1.0", "Accept": "application/json"}
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    with urlopen(Request(url, data=urlencode(data).encode() if data is not None else None,
                         headers=headers), timeout=10) as response:
        return json.load(response)


class DiaryWeb:
    def __init__(self, config, clock=None, discord=discord_json):
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self.discord = discord
        self.origin = config.get("PUBLIC_ORIGIN", "http://localhost:8000").rstrip("/")
        parsed = urlsplit(self.origin)
        if (parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1"})) or not parsed.hostname or parsed.path or parsed.query or parsed.fragment or parsed.username:
            raise ValueError("PUBLIC_ORIGIN must be an HTTPS origin or local development URL")
        self.secure = parsed.scheme == "https"
        self.client_id = config.get("DISCORD_CLIENT_ID")
        self.client_secret = config.get("DISCORD_CLIENT_SECRET")
        if self.client_id and not re.fullmatch(r"[0-9]{17,20}", self.client_id):
            raise ValueError("Discord client ID must be numeric")
        self.oauth_ready = bool(self.client_id and self.client_secret)
        self.lock = RLock()
        db_path = config.get("DATABASE_PATH", str(HERE / "data" / "diary.sqlite3"))
        if db_path != ":memory:":
            Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self.store = Store(db_path)
        self.db = self.store.db
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS web_accounts (
                user INTEGER PRIMARY KEY, name TEXT NOT NULL, avatar TEXT
            );
            CREATE TABLE IF NOT EXISTS web_sessions (
                token TEXT PRIMARY KEY, user INTEGER NOT NULL, expires TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS web_oauth (
                state TEXT PRIMARY KEY, expires TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS web_posts (
                id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
                body TEXT NOT NULL, updated TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS web_emojis (
                user INTEGER NOT NULL, thread INTEGER NOT NULL, emoji TEXT NOT NULL,
                PRIMARY KEY(user,thread)
            );
        """)
        with self.db:
            if "shared" not in {row[1] for row in self.db.execute("PRAGMA table_info(web_posts)")}:
                self.db.execute("ALTER TABLE web_posts ADD COLUMN shared INTEGER NOT NULL DEFAULT 0")
            if "community" not in {row[1] for row in self.db.execute("PRAGMA table_info(web_accounts)")}:
                self.db.execute("ALTER TABLE web_accounts ADD COLUMN community INTEGER NOT NULL DEFAULT 0")

    def create_book(self, user, now):
        if self.store.forum(user):
            return
        self.db.execute("""INSERT INTO forums(guild,channel,since,owner) VALUES (?,?,?,?)
            ON CONFLICT(channel) DO UPDATE SET enabled=1""", (GUILD, user, now.isoformat(), user))
        self.db.execute("INSERT OR IGNORE INTO forum_timezone_changes VALUES (?,?,?)",
                        (user, now.isoformat(), self.store.default_timezone))

    def cookie(self, name, value, age):
        secure = "; Secure" if self.secure else ""
        return ("Set-Cookie", f"{name}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={age}{secure}")

    @staticmethod
    def cookies(env):
        return SimpleCookie(env.get("HTTP_COOKIE", ""))

    def user(self, env, now):
        if not self.oauth_ready:
            raise Problem("401 Unauthorized", "Discord 로그인 설정이 필요합니다.")
        session = self.cookies(env).get("diary_session")
        if session:
            account = self.db.execute("""SELECT a.* FROM web_sessions s JOIN web_accounts a USING(user)
                WHERE s.token=? AND s.expires>?""", (hashed(session.value), now.isoformat())).fetchone()
            if account:
                return account
        raise Problem("401 Unauthorized", "Discord로 먼저 로그인해 주세요.")

    def start_oauth(self, now):
        if not self.oauth_ready:
            raise Problem("503 Service Unavailable", "운영자가 Discord 로그인 설정을 완료해야 합니다.")
        state = secrets.token_urlsafe(32)
        with self.lock, self.db:
            self.db.execute("DELETE FROM web_oauth WHERE expires<=?", (now.isoformat(),))
            self.db.execute("INSERT INTO web_oauth VALUES (?,?)",
                            (hashed(state), (now + timedelta(minutes=10)).isoformat()))
        query = urlencode(dict(client_id=self.client_id, response_type="code",
                               redirect_uri=f"{self.origin}/auth/callback",
                               scope="identify", state=state))
        return "302 Found", b"", [("Location", f"https://discord.com/oauth2/authorize?{query}"),
                                  self.cookie("diary_oauth", state, 600)]

    def finish_oauth(self, env, now):
        query = parse_qs(env.get("QUERY_STRING", ""))
        state = query.get("state", [""])[0]
        code = query.get("code", [""])[0]
        browser_state = self.cookies(env).get("diary_oauth")
        if not self.oauth_ready or not code or not browser_state or not secrets.compare_digest(state.encode(), browser_state.value.encode()):
            raise Problem("400 Bad Request", "Discord 로그인 요청이 만료되었거나 취소되었습니다.")
        with self.lock, self.db:
            consumed = self.db.execute("DELETE FROM web_oauth WHERE state=? AND expires>?",
                                       (hashed(state), now.isoformat())).rowcount
        if not consumed:
            raise Problem("400 Bad Request", "이미 사용했거나 만료된 로그인 요청입니다.")
        try:
            payload = self.discord(f"{DISCORD_API}/oauth2/token", data=dict(
                client_id=self.client_id, client_secret=self.client_secret, grant_type="authorization_code",
                code=code, redirect_uri=f"{self.origin}/auth/callback"))
            token = payload["access_token"]
            account = self.discord(f"{DISCORD_API}/users/@me", token=token)
            user = int(account["id"])
            if not 0 < user < 2**63:
                raise ValueError("Reserved account identifier")
        except (OSError, ValueError, KeyError) as exc:
            raise Problem("502 Bad Gateway", "Discord 로그인에 실패했습니다. 다시 시도해 주세요.") from None
        session = secrets.token_urlsafe(32)
        old_session = self.cookies(env).get("diary_session")
        with self.lock, self.db:
            self.db.execute("DELETE FROM web_sessions WHERE expires<=?", (now.isoformat(),))
            if old_session:
                self.db.execute("DELETE FROM web_sessions WHERE token=?", (hashed(old_session.value),))
            self.db.execute("""INSERT INTO web_accounts(user,name,avatar) VALUES (?,?,?) ON CONFLICT(user)
                DO UPDATE SET name=excluded.name, avatar=excluded.avatar""",
                            (user, account.get("global_name") or account["username"], account.get("avatar")))
            self.create_book(user, now)
            self.db.execute("INSERT INTO web_sessions VALUES (?,?,?)",
                            (hashed(session), user, (now + SESSION_TTL).isoformat()))
        return "303 See Other", b"", [("Location", "/"), self.cookie("diary_oauth", "", 0),
                                      self.cookie("diary_session", session, int(SESSION_TTL.total_seconds()))]

    def dashboard(self, user, now):
        zone = self.store.user_zone(GUILD, user, now)
        today = diary_day(now, zone)
        profile = self.store._stats(GUILD, user, today)
        book = self.store.user_forum(GUILD, user)
        pending = self.store.pending_zone(book["channel"], now) if book else None
        posts = [dict(row) for row in self.db.execute("""
            SELECT p.*, e.day, e.gold, e.eligible, e.user, a.name, b.length,
                (SELECT COUNT(*) FROM reactions WHERE thread=p.id AND gold>0) AS likes,
                (SELECT emoji FROM web_emojis WHERE thread=p.id AND user=?) AS reacted
            FROM web_posts p JOIN entries e ON e.thread=p.id JOIN web_accounts a USING(user)
            JOIN bodies b ON b.thread=p.id
            WHERE e.user=? OR (p.shared=1 AND e.eligible=1) ORDER BY p.id DESC LIMIT 50
        """, (user, user))]
        mine = self.db.execute("""SELECT p.*, e.day, e.gold, e.eligible, b.length
            FROM web_posts p JOIN entries e ON e.thread=p.id JOIN bodies b ON b.thread=p.id
            WHERE e.user=? AND e.day=?""", (user, today.isoformat())).fetchone()
        notices = []
        for missed in reversed(profile["shield_days"][-7:]):
            target = self.db.execute("""SELECT title FROM web_posts p JOIN entries e ON e.thread=p.id
                WHERE e.user=? AND e.eligible=1 AND e.day<? ORDER BY e.day DESC LIMIT 1""",
                                     (user, missed)).fetchone()
            notices.append(dict(day=missed, title=target["title"] if target else None))
        achievements = [dict(row) for row in self.db.execute("""SELECT a.name,m.label,m.gold,m.shields,m.tickets,m.day
            FROM milestones m JOIN web_accounts a ON a.user=m.user
            WHERE a.user=? OR a.community=1 ORDER BY m.rowid DESC LIMIT 30""", (user,))]
        for post in posts:
            post["user"] = str(post["user"])
        ranking = {}
        names = dict(self.db.execute("SELECT user,name FROM web_accounts WHERE community=1"))
        for metric in ("streak", "gold", "total"):
            ranking[metric] = [dict(name=names[uid], value=value)
                               for uid, value in self.store.ranking(GUILD, now, metric, members=names)]
        community = bool(self.db.execute("SELECT community FROM web_accounts WHERE user=?", (user,)).fetchone()[0])
        return dict(today=today.isoformat(), zone=str(zone), profile=profile, mine=dict(mine) if mine else None,
                    community=community, pending=dict(pending) if pending else None,
                    week=self.store.week_history(GUILD, user, today), posts=posts, ranking=ranking,
                    achievements=achievements, notices=notices, ledger=[dict(r) for r in self.store.ledger(GUILD, user)],
                    prices=SHOP_PRICES)

    def save(self, user, now, data):
        title, body = data.get("title"), data.get("body")
        shared = data.get("shared", False)
        if type(shared) is not bool:
            raise ValueError("일기 공유 여부를 확인해 주세요.")
        if not isinstance(title, str) or not isinstance(body, str) or not 1 <= len(title.strip()) <= 100 or not 1 <= len(body.strip()) <= 20000:
            raise ValueError("제목은 1~100자, 본문은 1~20,000자로 입력해 주세요.")
        if any(0xD800 <= ord(char) <= 0xDFFF for char in title + body):
            raise ValueError("지원하지 않는 문자가 포함돼 있습니다.")
        today = diary_day(now, self.store.user_zone(GUILD, user, now))
        day = today.isoformat()
        if data.get("expected_day") is not None and data["expected_day"] != day:
            raise Problem("409 Conflict", "새 일기 날짜가 시작됐어요. 본문을 복사한 뒤 페이지를 새로 열어 주세요.")
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            post_id = data.get("id")
            if post_id is not None:
                if type(post_id) is not int or not 1 <= post_id < 2**63:
                    raise ValueError("올바르지 않은 일기 번호입니다.")
                if type(data.get("revision")) is not int:
                    raise ValueError("일기를 다시 열고 수정해 주세요.")
                entry = self.store.entry(post_id)
                if not entry or entry["user"] != user:
                    raise Problem("404 Not Found", "수정할 일기를 찾을 수 없습니다.")
                day = entry["day"]
                cursor = self.db.execute("""UPDATE web_posts SET title=?,body=?,updated=?,shared=?,revision=revision+1
                    WHERE id=? AND revision=?""",
                                         (title.strip(), body, now.isoformat(), shared, post_id, data.get("revision")))
                if not cursor.rowcount:
                    raise Problem("409 Conflict", "다른 창에서 일기가 수정됐어요. 화면을 새로 열고 다시 시도해 주세요.")
            else:
                if self.db.execute("SELECT 1 FROM entries WHERE guild=? AND user=? AND day=?", (GUILD, user, day)).fetchone():
                    raise Problem("409 Conflict", "오늘은 이미 일기를 썼어요. 기존 일기를 열어 수정해 주세요.")
                post_id = self.db.execute("INSERT INTO web_posts(title,body,updated,shared) VALUES (?,?,?,?)",
                                          (title.strip(), body, now.isoformat(), shared)).lastrowid
            _, delta, count = self.store.update_body(GUILD, user, post_id, day, body, in_transaction=True)
            self.store._award_milestones(GUILD, user, today.isoformat())
            streak = self.store._stats(GUILD, user, today)["streak"]
        return dict(id=post_id, delta=delta, length=count, streak=streak, eligible=count >= 100)

    def api(self, env, path, method, now):
        if path == "/api/session" and method == "GET":
            try:
                account = self.user(env, now)
            except Problem:
                return dict(user=None, ready=self.oauth_ready)
            return dict(user=dict(id=str(account["user"]), name=account["name"], avatar=account["avatar"]),
                        ready=self.oauth_ready)
        account = self.user(env, now)
        user = account["user"]
        today = diary_day(now, self.store.user_zone(GUILD, user, now))
        if method == "GET" and path == "/api/dashboard":
            return self.dashboard(user, now)
        if method != "POST":
            raise Problem("404 Not Found", "페이지를 찾을 수 없습니다.")
        if env.get("HTTP_ORIGIN") != self.origin or env.get("CONTENT_TYPE", "").split(";")[0] != "application/json":
            raise Problem("403 Forbidden", "이 사이트에서 요청을 다시 시도해 주세요.")
        length = int(env.get("CONTENT_LENGTH") or 0)
        if not 1 <= length <= 250000:
            raise Problem("413 Payload Too Large", "요청 크기가 올바르지 않습니다.")
        data = json.loads(env["wsgi.input"].read(length))
        if not isinstance(data, dict):
            raise ValueError("요청 형식이 올바르지 않습니다.")
        if path == "/api/diaries":
            return self.save(user, now, data)
        if path == "/api/react":
            post, emoji = data.get("id"), data.get("emoji")
            if type(post) is not int or not 1 <= post < 2**63 or not isinstance(emoji, str) or emoji not in EMOJIS:
                raise ValueError("일기와 이모지를 확인해 주세요.")
            with self.db:
                self.db.execute("BEGIN IMMEDIATE")
                if not self.db.execute("SELECT 1 FROM web_posts WHERE id=? AND shared=1", (post,)).fetchone():
                    raise Problem("404 Not Found", "공유된 일기를 찾을 수 없습니다.")
                reward = self.store.record_reaction(GUILD, user, post, today.isoformat(), in_transaction=True)
                if not reward:
                    raise Problem("409 Conflict", "이미 반응했거나 반응할 수 없는 일기입니다.")
                self.db.execute("INSERT INTO web_emojis VALUES (?,?,?)", (user, post, emoji))
            return dict(gold=reward[0], tickets=reward[1])
        if path == "/api/buy":
            key, item = data.get("key"), data.get("item")
            if not isinstance(key, str) or not re.fullmatch(r"[a-zA-Z0-9-]{16,64}", key) or not isinstance(item, str):
                raise ValueError("상품과 구매 요청 번호를 확인해 주세요.")
            return self.store.buy(GUILD, user, today, quantity=data.get("quantity"), item=item,
                                  request_id=f"web:{user}:{key}")
        if path == "/api/settings":
            zone, community = data.get("zone"), data.get("community")
            if zone not in ("Asia/Seoul", "America/Toronto") or type(community) is not bool:
                raise ValueError("시간대와 공개 범위를 선택해 주세요.")
            effective = self.store.change_zone(user, zone, now)
            with self.db:
                self.db.execute("UPDATE web_accounts SET community=? WHERE user=?", (community, user))
            return dict(effective=effective.isoformat(), pending=effective > now)
        if path == "/api/logout":
            with self.db:
                self.db.execute("DELETE FROM web_sessions WHERE token=?",
                                (hashed(self.cookies(env)["diary_session"].value),))
            return dict(ok=True)
        raise Problem("404 Not Found", "페이지를 찾을 수 없습니다.")

    def __call__(self, env, start_response):
        path, method, now = env["PATH_INFO"], env["REQUEST_METHOD"], self.clock()
        status, headers, kind = "200 OK", [], "application/json"
        try:
            if path in ASSETS and method in {"GET", "HEAD"}:
                name, kind = ASSETS[path]
                body = (HERE / "docs" / name).read_bytes()
            elif path == "/healthz" and method == "GET":
                body = json.dumps({"ok": True, "discord_oauth": self.oauth_ready}).encode()
            elif path == "/auth/discord" and method == "GET":
                status, body, headers = self.start_oauth(now)
            elif path == "/auth/callback" and method == "GET":
                status, body, headers = self.finish_oauth(env, now)
            elif path.startswith("/api/"):
                with self.lock:
                    result = self.api(env, path, method, now)
                if path == "/api/logout":
                    headers.append(self.cookie("diary_session", "", 0))
                body = json.dumps(result, ensure_ascii=False).encode()
            else:
                raise Problem("404 Not Found", "페이지를 찾을 수 없습니다.")
        except (Problem, ValueError) as exc:
            status = exc.status if isinstance(exc, Problem) else "400 Bad Request"
            if path.startswith("/auth/"):
                message = urlencode({"auth_error": str(exc)})
                status, body = "303 See Other", b""
                headers = [("Location", f"/?{message}"), self.cookie("diary_oauth", "", 0)]
            else:
                body = json.dumps({"error": str(exc)}, ensure_ascii=False).encode()
        headers += [("Content-Type", f"{kind}; charset=utf-8"), ("Content-Length", str(len(body))),
                    ("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff"),
                    ("Referrer-Policy", "no-referrer"),
                    ("Content-Security-Policy", "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https://cdn.discordapp.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")]
        start_response(status, headers)
        return [body if method != "HEAD" else b""]


def create_app():
    return DiaryWeb(os.environ)


if __name__ == "__main__":
    from wsgiref.simple_server import make_server

    with make_server("127.0.0.1", int(os.environ.get("PORT", "8000")), create_app()) as httpd:
        print(f"Diary Web · http://localhost:{httpd.server_port}", flush=True)
        httpd.serve_forever()
