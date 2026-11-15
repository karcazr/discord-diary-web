from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.parse import parse_qs, urlencode, urlsplit
import json
import unittest

from server import DiaryWeb

ADMIN = "123456789000000001"
MEMBER = "123456789000000002"
ORIGIN = "https://diary.example"


class WebTest(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.now = datetime(2026, 11, 15, 19, tzinfo=timezone.utc)
        self.config = dict(PUBLIC_ORIGIN=ORIGIN, DISCORD_CLIENT_ID="123456789000000003",
                           DISCORD_CLIENT_SECRET="local-test", DISCORD_GUILD_ID="123456789000000004",
                           DIARY_ADMIN_IDS=ADMIN, DATABASE_PATH=str(Path(self.directory.name) / "ledger.sqlite3"))
        self.start_app()

    def start_app(self):
        self.web = DiaryWeb(self.config, clock=lambda: self.now, discord=self.discord)
        self.addCleanup(self.web.store.close)

    @staticmethod
    def discord(url, data=None, token=None):
        if url.endswith("/oauth2/token"):
            assert data["redirect_uri"] == ORIGIN + "/auth/callback"
            return {"access_token": data["code"]}
        if url.endswith("/users/@me"):
            return {"id": token, "username": "테스터 " + token[-1]}
        assert url.endswith("/guilds/123456789000000004/member")
        return {}

    def request(self, path, data=None, cookie="", query="", origin=ORIGIN):
        raw = b"" if data is None else json.dumps(data).encode()
        env = dict(PATH_INFO=path, REQUEST_METHOD="GET" if data is None else "POST",
                   HTTP_COOKIE=cookie, QUERY_STRING=query, HTTP_ORIGIN=origin,
                   CONTENT_LENGTH=str(len(raw)), CONTENT_TYPE="application/json")
        env["wsgi.input"] = BytesIO(raw)
        state = []
        output = b"".join(self.web(env, lambda *args: state.extend(args)))
        status, headers = state
        parsed = json.loads(output) if output and dict(headers)["Content-Type"].startswith("application/json") else output
        return int(status.split()[0]), headers, parsed

    def login(self, user):
        status, headers, _ = self.request("/auth/discord")
        self.assertEqual(status, 302)
        state = parse_qs(urlsplit(dict(headers)["Location"]).query)["state"][0]
        cookie = dict(headers)["Set-Cookie"].split(";")[0]
        query = urlencode(dict(state=state, code=user))
        status, headers, _ = self.request("/auth/callback", cookie=cookie, query=query)
        self.assertEqual(status, 303)
        self.assertEqual(dict(headers)["Location"], "/")
        self.assertIn("Secure", dict(headers)["Set-Cookie"])
        return dict(headers)["Set-Cookie"].split(";")[0]

    def enable(self, admin_cookie, user, zone="Asia/Seoul"):
        return self.request("/api/admin/book", dict(user=user, enabled=True, zone=zone), admin_cookie)

    def test_first_page_and_assets(self):
        status, headers, page = self.request("/")
        self.assertEqual(status, 200)
        self.assertIn("마딱도란".encode(), page)
        self.assertIn(b'id="login"', page)
        self.assertIn("text/html", dict(headers)["Content-Type"])
        for path in ("/style.css", "/app.js", "/config.js"):
            self.assertEqual(self.request(path)[0], 200)
        self.assertEqual(self.request("/healthz")[2], dict(ok=True, discord_oauth=True))

    def test_oauth_state_session_and_logout(self):
        self.assertEqual(self.request("/api/dashboard")[0], 401)
        with_state, headers, _ = self.request("/auth/discord")
        self.assertEqual(with_state, 302)
        bad = self.request("/auth/callback", query=urlencode(dict(state="invalid", code=ADMIN)))
        self.assertIn("auth_error", dict(bad[1])["Location"])
        cookie = self.login(ADMIN)
        self.assertEqual(self.request("/api/session", cookie=cookie)[2]["user"]["id"], ADMIN)
        self.assertEqual(self.request("/api/logout", {}, cookie, origin="https://wrong.example")[0], 403)
        self.assertEqual(self.request("/api/logout", {}, cookie)[0], 200)
        self.assertIsNone(self.request("/api/session", cookie=cookie)[2]["user"])

    def test_day_boundary_and_admin_assignment(self):
        admin, member = self.login(ADMIN), self.login(MEMBER)
        self.assertEqual(self.enable(member, MEMBER)[0], 403)
        self.assertEqual(self.request("/api/diaries", dict(title="a", body="일" * 100), member)[0], 403)
        self.assertEqual(self.enable(admin, MEMBER, "America/Toronto")[0], 200)
        self.now = datetime(2026, 11, 16, 9, tzinfo=timezone.utc)
        member = self.login(MEMBER)
        self.assertEqual(self.request("/api/dashboard", cookie=member)[2]["today"], "2026-11-15")
        self.now = self.now.replace(microsecond=1000)
        self.assertEqual(self.request("/api/dashboard", cookie=member)[2]["today"], "2026-11-16")
        self.assertEqual(self.request("/api/diaries", dict(title="a", body="일" * 100, expected_day="2026-11-15"), member)[0], 409)

    def test_eligibility_edit_dedup_and_restart(self):
        admin, member = self.login(ADMIN), self.login(MEMBER)
        self.enable(admin, MEMBER)
        post = dict(title="x" * 100, body="일" * 99 + " \u200b")
        first = self.request("/api/diaries", post, member)[2]
        self.assertEqual((first["length"], first["delta"], first["streak"]), (99, 0, 0))
        self.assertEqual(self.request("/api/diaries", post, member)[0], 409)
        post.update(id=first["id"], revision=1, body="일" * 1137)
        edited = self.request("/api/diaries", post, member)[2]
        self.assertEqual((edited["delta"], edited["streak"]), (320, 1))
        self.assertEqual(self.request("/api/diaries", post, member)[0], 409)
        self.assertEqual(self.request("/api/diaries", {**post, "revision": 2}, admin)[0], 403)
        reaction = dict(id=first["id"], emoji="❤️")
        self.assertEqual(self.request("/api/react", reaction, member)[0], 409)
        self.assertEqual(self.request("/api/react", reaction, admin)[2]["gold"], 10)
        self.assertEqual(self.request("/api/react", reaction, admin)[0], 409)
        self.request("/api/diaries", {**post, "revision": 2, "body": "짧은 글"}, member)
        self.assertEqual(self.request("/api/dashboard", cookie=admin)[2]["profile"]["gold"], 0)
        restored = self.request("/api/diaries", {**post, "revision": 3}, member)[2]
        self.assertEqual(restored["delta"], 320)
        self.start_app()
        dashboard = self.request("/api/dashboard", cookie=admin)[2]
        self.assertEqual(dashboard["profile"]["gold"], 10)
        self.assertEqual(len(dashboard["week"]), 7)
        self.assertEqual(dashboard["posts"][0]["reacted"], "❤️")


if __name__ == "__main__":
    unittest.main()
