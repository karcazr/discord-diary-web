import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { countBody, diaryDay, milestones, reward, shift, stats } from "./ledger.mjs";
import { createWorker } from "./worker.mjs";

const writer = "123456789000000001";
const reader = "123456789000000002";
const origin = "https://haru-diary.example";
const schema = readFileSync(new URL("./migrations/0001_diary.sql", import.meta.url), "utf8");

function d1(sqlite) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          const statement = sqlite.prepare(sql);
          return {
            execute: () => ({ results: statement.all(...args) }),
            async first(column) {
              const row = statement.get(...args);
              return row ? (column ? row[column] : row) : null;
            },
            async run() { return statement.run(...args); }
          };
        }
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(statement => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

function fixture(existingDb) {
  const sqlite = existingDb ?? new DatabaseSync(":memory:");
  if (!existingDb) sqlite.exec(schema);
  const env = {
    DB: d1(sqlite), ASSETS: { fetch: async () => new Response("일기장") },
    PUBLIC_ORIGIN: origin, DISCORD_CLIENT_ID: "123456789000000003", DISCORD_CLIENT_SECRET: "test-only"
  };
  let now = Date.parse("2026-11-15T19:00:00Z");
  const worker = createWorker(() => now, async (url, options) => {
    if (url.endsWith("/oauth2/token")) {
      assert.equal(options.body.get("redirect_uri"), origin + "/auth/callback");
      return Response.json({ access_token: options.body.get("code") });
    }
    assert(url.endsWith("/users/@me"));
    return Response.json({ id: options.headers.Authorization.slice(7), username: "테스터" });
  });
  const get = (path, cookie = "") => worker.fetch(new Request(origin + path, { headers: { Cookie: cookie } }), env);
  const post = (path, value, cookie, requestOrigin = origin) => worker.fetch(new Request(origin + path, {
    method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", Origin: requestOrigin },
    body: JSON.stringify(value)
  }), env);
  async function login(user) {
    const redirect = await get("/auth/discord");
    const state = redirect.headers.get("set-cookie").split(";")[0];
    const authorization = new URL(redirect.headers.get("location"));
    assert.equal(authorization.searchParams.get("scope"), "identify");
    assert.equal(authorization.searchParams.get("redirect_uri"), origin + "/auth/callback");
    const query = new URLSearchParams({ state: authorization.searchParams.get("state"), code: user });
    const callback = await get("/auth/callback?" + query, state);
    assert.equal(callback.headers.get("location"), "/");
    assert((await get("/auth/callback?" + query, state)).headers.get("location").startsWith("/?auth_error="));
    const session = callback.headers.getSetCookie().find(value => value.startsWith("diary_session="));
    assert(session.includes("Secure"));
    return session.split(";")[0];
  }
  return { sqlite, get, post, login, time: instant => { now = Date.parse(instant); } };
}

test("Discord callback, protected session, CSRF and logout", async () => {
  const app = fixture();
  assert.deepEqual(await (await app.get("/healthz")).json(), { ok: true, discord_oauth: true });
  assert.equal((await app.get("/api/dashboard")).status, 401);
  const cookie = await app.login(writer);
  assert.equal((await (await app.get("/api/session", cookie)).json()).user.id, writer);
  assert.equal((await app.post("/api/logout", {}, cookie, "https://wrong.example")).status, 403);
  assert.equal((await app.post("/api/logout", {}, cookie)).status, 200);
  assert.equal((await app.get("/api/dashboard", cookie)).status, 401);
});

test("one entry per day, body edits, sharing, reactions and persistence", async () => {
  const app = fixture();
  const owner = await app.login(writer);
  const guest = await app.login(reader);
  const draft = { title: "비공개 일기", body: "일".repeat(99) + " \u200b" };
  const concurrent = await Promise.all([app.post("/api/diaries", draft, owner), app.post("/api/diaries", draft, owner)]);
  assert.deepEqual(concurrent.map(x => x.status).sort(), [200, 409]);
  const first = await concurrent.find(x => x.ok).json();
  assert.deepEqual([first.length, first.delta, first.streak], [99, 0, 0]);
  const edit = { ...draft, id: first.id, revision: 1, body: "일".repeat(1137) };
  const eligible = await (await app.post("/api/diaries", edit, owner)).json();
  assert.deepEqual([eligible.delta, eligible.streak], [320, 1]);
  assert.equal((await app.post("/api/diaries", edit, owner)).status, 409);
  assert.equal((await app.post("/api/diaries", edit, guest)).status, 404);
  const reaction = { id: first.id, emoji: "🔥" };
  assert.equal((await app.post("/api/react", reaction, guest)).status, 404);
  const shared = { ...edit, revision: 2, shared: true };
  assert.equal((await app.post("/api/diaries", shared, owner)).status, 200);
  assert.equal((await app.post("/api/react", reaction, owner)).status, 409);
  const reactions = await Promise.all([app.post("/api/react", reaction, guest), app.post("/api/react", reaction, guest)]);
  assert.deepEqual(reactions.map(x => x.status).sort(), [200, 409]);
  assert.equal((await reactions.find(x => x.ok).json()).gold, 10);
  await app.post("/api/diaries", { ...shared, body: "짧은 글", revision: 3 }, owner);
  assert.equal((await (await app.get("/api/dashboard", guest)).json()).profile.gold, 0);
  await app.post("/api/diaries", { ...shared, revision: 4 }, owner);
  await app.post("/api/settings", { zone: "Asia/Seoul", community: true }, owner);
  const after = await (await fixture(app.sqlite).get("/api/dashboard", guest)).json();
  assert.equal(after.profile.gold, 10);
  assert.equal(after.posts[0].reacted, "🔥");
  const ranking = await (await app.get("/api/rankings", guest)).json();
  assert.equal(ranking.gold[0].value, 320);
  assert.equal(after.week.length, 7);
});

test("4 AM boundary, Unicode length and milestone replay", () => {
  assert.equal(diaryDay(Date.parse("2026-11-16T09:00:00Z"), "America/Toronto"), "2026-11-15");
  assert.equal(diaryDay(Date.parse("2026-11-16T09:00:00.001Z"), "America/Toronto"), "2026-11-16");
  assert.equal(diaryDay(Date.parse("2026-07-16T08:00:00Z"), "America/Toronto"), "2026-07-15");
  assert.equal(diaryDay(Date.parse("2026-11-15T19:00:00.001Z"), "Asia/Seoul"), "2026-11-16");
  assert.equal(countBody("한 😀\u200b\n"), 2);
  assert.deepEqual([99, 100, 300, 500, 700, 1000, 1137, 2049].map(n => reward(n, 0)), [0, 50, 100, 150, 200, 300, 320, 500]);
  const start = "2026-01-01";
  const entries = Array.from({ length: 100 }, (_, i) => ({ day: shift(start, i), gold: 300, length: 1000 }));
  const ledger = { entries, purchases: [], reactions: [], awards: [] };
  ledger.awards = milestones(ledger, shift(start, 99));
  assert.equal(ledger.awards.filter(award => award.key.startsWith("week:")).length, 14);
  assert.equal(ledger.awards.find(award => award.key === "streak:100").shields, 1);
  assert.equal(ledger.awards.find(award => award.key === "chars:100000").tickets, 100);
  assert.equal(milestones(ledger, shift(start, 99)).length, 0);
  assert.equal(stats(ledger, shift(start, 101)).shields, 2);
  assert.equal(stats(ledger, shift(start, 104)).streak, 0);
});

test("purchase retries charge once", async () => {
  const app = fixture();
  const cookie = await app.login(writer);
  app.sqlite.prepare("INSERT INTO posts(user,day,title,body,length,roll,gold,shared,eligible) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(writer, "2026-10-01", "일기", "일".repeat(100), 100, 0, 3000, 0, 1);
  const purchase = { key: "this-is-an-idempotent-purchase", item: "방패", quantity: 1 };
  const results = await Promise.all([app.post("/api/buy", purchase, cookie), app.post("/api/buy", purchase, cookie)]);
  assert(results.every(result => result.ok));
  const dashboard = await (await app.get("/api/dashboard", cookie)).json();
  assert.equal(dashboard.profile.gold, 1000);
  assert.equal(dashboard.profile.shields, 1);
});
