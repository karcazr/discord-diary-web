import { buy, dashboard, Problem, query, rankings, react, saveDiary, settings } from "./database.mjs";

const discord = "https://discord.com/api/v10";
const policy = "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https://cdn.discordapp.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const sessionAge = 12 * 60 * 60;
const stateAge = 10 * 60;
const handlers = {
  "/api/diaries": saveDiary,
  "/api/react": react,
  "/api/buy": buy,
  "/api/settings": settings
};

function secure(response) {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", policy);
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, { status: response.status, headers });
}

function json(body, status = 200, headers = {}) {
  return secure(Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } }));
}

function randomToken() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(value => value.toString(16).padStart(2, "0")).join("");
}

async function digest(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function getCookie(request, key) {
  return (request.headers.get("Cookie") || "").split(";").map(value => value.trim())
    .find(value => value.startsWith(key + "="))?.slice(key.length + 1) || "";
}

function cookie(key, value, age, origin) {
  return `${key}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${origin.startsWith("https:") ? "; Secure" : ""}`;
}

function redirect(to, cookies = [], status = 303) {
  const headers = new Headers({ Location: to, "Cache-Control": "no-store" });
  for (const entry of cookies) headers.append("Set-Cookie", entry);
  return secure(new Response(null, { status, headers }));
}

function oauthReady(env) {
  return typeof env.DISCORD_CLIENT_ID === "string" && /^\d{17,20}$/.test(env.DISCORD_CLIENT_ID) &&
    Boolean(env.DISCORD_CLIENT_SECRET && env.PUBLIC_ORIGIN);
}

async function getAccount(db, request, now) {
  const token = getCookie(request, "diary_session");
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  return query(db, `SELECT a.* FROM sessions s JOIN accounts a ON a.id=s.user
    WHERE s.hash=? AND s.expires>?`, await digest(token), now).first();
}

async function startDiscord(env, origin, now) {
  const state = randomToken();
  await env.DB.batch([
    query(env.DB, "DELETE FROM oauth_states WHERE expires<=?", now),
    query(env.DB, "INSERT INTO oauth_states VALUES (?,?)", await digest(state), now + stateAge * 1000)
  ]);
  const params = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID, redirect_uri: origin + "/auth/callback",
    response_type: "code", scope: "identify", state
  });
  return redirect("https://discord.com/oauth2/authorize?" + params, [cookie("diary_oauth", state, stateAge, origin)], 302);
}

async function finishDiscord(request, url, env, origin, now, fetchDiscord) {
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || !code || !/^[a-f0-9]{64}$/.test(state) || state !== getCookie(request, "diary_oauth") ||
      (url.searchParams.has("iss") && url.searchParams.get("iss") !== "https://discord.com")) {
    throw new Problem(400, "Discord 로그인 요청이 만료되었거나 취소되었습니다.");
  }
  const used = await query(env.DB, "DELETE FROM oauth_states WHERE hash=? AND expires>? RETURNING hash", await digest(state), now).first();
  if (!used) throw new Problem(400, "이미 사용했거나 만료된 로그인 요청입니다.");
  const response = await fetchDiscord(discord + "/oauth2/token", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
    body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code", code, redirect_uri: origin + "/auth/callback" })
  });
  if (!response.ok) throw new Problem(502, "Discord 로그인에 실패했습니다. 다시 시도해 주세요.");
  const { access_token } = await response.json();
  if (!access_token) throw new Problem(502, "Discord 로그인에 실패했습니다. 다시 시도해 주세요.");
  const profile = await fetchDiscord(discord + "/users/@me", {
    headers: { Authorization: `Bearer ${access_token}` }, redirect: "error", signal: AbortSignal.timeout(10000)
  });
  const account = profile.ok ? await profile.json() : null;
  if (!account || !/^\d{17,20}$/.test(account.id) || typeof account.username !== "string") {
    throw new Problem(502, "Discord 계정을 확인할 수 없습니다.");
  }
  const session = randomToken();
  const previous = getCookie(request, "diary_session");
  await env.DB.batch([
    query(env.DB, `INSERT INTO accounts(id,name,avatar) VALUES (?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,avatar=excluded.avatar`,
    account.id, account.global_name || account.username, account.avatar ?? null),
    query(env.DB, "DELETE FROM sessions WHERE expires<=? OR hash=?", now, previous ? await digest(previous) : ""),
    query(env.DB, "INSERT INTO sessions VALUES (?,?,?)", await digest(session), account.id, now + sessionAge * 1000)
  ]);
  return redirect("/", [cookie("diary_oauth", "", 0, origin), cookie("diary_session", session, sessionAge, origin)]);
}

async function jsonInput(request, origin) {
  if (request.headers.get("Origin") !== origin ||
      request.headers.get("Content-Type")?.split(";")[0] !== "application/json") {
    throw new Problem(403, "이 사이트에서 요청을 다시 시도해 주세요.");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new Problem(400, "요청 형식을 확인해 주세요.");
  const decoder = new TextDecoder();
  let body = "";
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 250000) {
      await reader.cancel();
      throw new Problem(413, "요청이 너무 큽니다.");
    }
    body += decoder.decode(chunk.value, { stream: true });
  }
  try {
    const value = JSON.parse(body + decoder.decode());
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError();
    return value;
  } catch {
    throw new Problem(400, "요청 형식을 확인해 주세요.");
  }
}

export function createWorker(clock = Date.now, fetchDiscord = fetch) {
  return {
    async fetch(request, env) {
      const now = clock();
      const url = new URL(request.url);
      const path = url.pathname;
      const origin = env.PUBLIC_ORIGIN || url.origin;
      const ready = oauthReady(env);
      try {
        if (path === "/healthz" && request.method === "GET") {
          const schema = await query(env.DB, "SELECT revision FROM revision_guard WHERE id=1").first("revision");
          return json({ ok: schema != null, discord_oauth: ready });
        }
        if (!path.startsWith("/api/") && !path.startsWith("/auth/")) {
          return secure(await env.ASSETS.fetch(request));
        }
        if (url.origin !== origin) throw new Problem(403, "등록된 서비스 주소로 열어 주세요.");
        if (path.startsWith("/auth/") && request.method === "GET") {
          if (!ready) throw new Problem(503, "Discord 로그인 준비 중입니다.");
          if (path === "/auth/discord") return await startDiscord(env, origin, now);
          if (path === "/auth/callback") return await finishDiscord(request, url, env, origin, now, fetchDiscord);
        }
        const account = ready ? await getAccount(env.DB, request, now) : null;
        if (path === "/api/session" && request.method === "GET") {
          return json({ ready, user: account ? { id: account.id, name: account.name, avatar: account.avatar } : null });
        }
        if (!account) throw new Problem(401, "Discord로 먼저 로그인해 주세요.");
        if (path === "/api/dashboard" && request.method === "GET") return json(await dashboard(env.DB, account, now));
        if (path === "/api/rankings" && request.method === "GET") return json(await rankings(env.DB, now));
        if (request.method === "POST") {
          const input = await jsonInput(request, origin);
          if (path === "/api/logout") {
            await query(env.DB, "DELETE FROM sessions WHERE hash=?", await digest(getCookie(request, "diary_session"))).run();
            return json({ ok: true }, 200, { "Set-Cookie": cookie("diary_session", "", 0, origin) });
          }
          if (Object.hasOwn(handlers, path)) return json(await handlers[path](env.DB, account.id, now, input));
        }
        throw new Problem(404, "페이지를 찾을 수 없습니다.");
      } catch (error) {
        const message = error instanceof Problem ? error.message : "잠시 뒤 다시 시도해 주세요.";
        if (path.startsWith("/auth/")) {
          return redirect("/?" + new URLSearchParams({ auth_error: message }), [cookie("diary_oauth", "", 0, origin)]);
        }
        return json({ error: message }, error instanceof Problem ? error.status : 500);
      }
    }
  };
}

export default createWorker();
