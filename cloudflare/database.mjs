import { diaryDay, milestones, reactionRate, reward, shift, stats, zoneAt, agreeOnDate, countBody, prices, zones, SHIELD, RESTORE } from "./ledger.mjs";

export class Problem extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const query = (db, sql, ...values) => db.prepare(sql).bind(...values);
const list = result => result.results;
const emojis = new Set(["❤️", "👏", "🔥", "👍", "🎉", "💯"]);
const validId = value => Number.isSafeInteger(value) && value > 0;
const accountDay = (account, now) => diaryDay(now, zoneAt(account, now));
const daysOf = today => Array.from({ length: 7 }, (_, day) => shift(today, -day));

async function transaction(db, plan) {
  // Guard the snapshot used for calculations and commit all ledger rows together.
  for (let attempt = 0; attempt < 3; attempt++) {
    const revision = await query(db, "SELECT revision FROM revision_guard WHERE id=1").first("revision");
    const { statements, result } = await plan();
    if (!statements.length) return result;
    const guard = query(db, `UPDATE revision_guard SET revision =
      CASE WHEN revision=? THEN revision+1 ELSE -1 END WHERE id=1`, revision);
    try {
      const write = await db.batch([guard, ...statements]);
      return typeof result === "function" ? result(write.slice(1)) : result;
    } catch (error) {
      if (!String(error).includes("diary_revision")) throw error;
    }
  }
  throw new Problem(409, "다른 요청이 처리 중입니다. 잠시 뒤 다시 시도해 주세요.");
}

async function ledger(db, user) {
  const [entries, purchases, reactions, awards] = await db.batch([
    query(db, "SELECT day,gold,length FROM posts WHERE user=? AND eligible=1 ORDER BY day", user),
    query(db, "SELECT day,item,quantity,cost,restored FROM purchases WHERE user=? ORDER BY day", user),
    query(db, `SELECT r.day, COUNT(*) AS count, SUM(r.gold) AS gold, SUM(r.tickets) AS tickets
      FROM reactions r JOIN posts p ON p.id=r.post WHERE r.user=? AND p.eligible=1 GROUP BY r.day`, user),
    query(db, "SELECT * FROM awards WHERE user=?", user)
  ]);
  return { entries: list(entries), purchases: list(purchases), reactions: list(reactions), awards: list(awards) };
}

function awardStatements(db, user, awards) {
  return awards.map(row => query(db, "INSERT INTO awards VALUES (?,?,?,?,?,?,?)",
    user, row.key, row.label, row.day, row.gold, row.tickets, row.shields));
}

export async function rankings(db, now) {
  const [accounts, entries, purchases, reactions, awards] = await db.batch([
    query(db, "SELECT id,name,zone,next_zone,next_at FROM accounts WHERE community=1"),
    query(db, `SELECT p.user,p.day,p.gold,p.length FROM accounts a JOIN posts p ON p.user=a.id
      WHERE a.community=1 AND p.eligible=1 ORDER BY p.user,p.day`),
    query(db, `SELECT p.user,p.day,p.item,p.quantity,p.cost,p.restored
      FROM accounts a JOIN purchases p ON p.user=a.id WHERE a.community=1`),
    query(db, `SELECT r.user, COUNT(*) AS count, SUM(r.gold) AS gold, SUM(r.tickets) AS tickets
      FROM accounts a JOIN reactions r ON r.user=a.id JOIN posts p ON p.id=r.post
      WHERE a.community=1 AND p.eligible=1 GROUP BY r.user`),
    query(db, "SELECT w.* FROM accounts a JOIN awards w ON w.user=a.id WHERE a.community=1")
  ]);
  const groups = new Map(list(accounts).map(account => [account.id, { account, entries: [], purchases: [], reactions: [], awards: [] }]));
  for (const [key, result] of Object.entries({ entries, purchases, reactions, awards })) {
    for (const row of list(result)) groups.get(row.user)[key].push(row);
  }
  const all = [...groups.values()].map(data => ({ ...data.account, ...stats(data, accountDay(data.account, now)) }));
  return Object.fromEntries(["streak", "gold", "total"].map(metric => [metric, all.slice()
    .sort((a, b) => b[metric] - a[metric] || a.id.length - b.id.length || a.id.localeCompare(b.id))
    .slice(0, 10).map(row => ({ name: row.name, value: row[metric] }))]));
}

export async function dashboard(db, account, now) {
  const user = account.id;
  const zone = zoneAt(account, now);
  const today = diaryDay(now, zone);
  const [data, result] = await Promise.all([
    ledger(db, user),
    db.batch([
      query(db, "SELECT * FROM posts WHERE user=? AND day=?", user, today),
      query(db, `WITH recent(id) AS (
          SELECT id FROM (SELECT id FROM posts WHERE user=? ORDER BY id DESC LIMIT 50)
          UNION SELECT id FROM (SELECT id FROM posts WHERE shared=1 AND eligible=1 ORDER BY id DESC LIMIT 50)
        )
        SELECT p.*, a.name, (SELECT COUNT(*) FROM reactions WHERE post=p.id AND p.eligible=1) AS likes,
          (SELECT emoji FROM reactions WHERE post=p.id AND user=?) AS reacted
        FROM recent JOIN posts p USING(id) JOIN accounts a ON p.user=a.id ORDER BY p.id DESC LIMIT 50`, user, user),
      query(db, `SELECT a.name,w.label,w.gold,w.shields,w.tickets,w.day FROM awards w
        JOIN accounts a ON w.user=a.id WHERE a.id=? OR a.community=1 ORDER BY w.day DESC,w.rowid DESC LIMIT 30`, user),
      query(db, `SELECT day,'일기' AS kind,gold AS amount FROM posts WHERE user=?
        UNION ALL SELECT r.day,'반응',r.gold FROM reactions r JOIN posts p ON p.id=r.post WHERE r.user=? AND p.eligible=1
        UNION ALL SELECT day,item||' 구매',-cost FROM purchases WHERE user=?
        UNION ALL SELECT day,label,gold FROM awards WHERE user=? AND gold>0 ORDER BY day DESC LIMIT 15`,
        user, user, user, user)
    ])
  ]);
  const profile = stats(data, today);
  const week = daysOf(today).map(day => {
    const entry = data.entries.find(row => row.day === day);
    const reaction = data.reactions.find(row => row.day === day);
    const gold = entry?.gold ?? 0;
    const reaction_gold = reaction?.gold ?? 0;
    return { day, gold, reaction_gold, reactions: reaction?.count ?? 0, total: gold + reaction_gold };
  });
  const missed = profile.shield_days.slice(-7).reverse();
  const notices = missed.length ? (await db.batch(missed.map(day => query(db, `
    SELECT ? AS day, (SELECT title FROM posts WHERE user=? AND eligible=1 AND day<? ORDER BY day DESC LIMIT 1) AS title`,
    day, user, day)))).flatMap(list) : [];
  return {
    today, zone, profile, week, notices, prices, community: Boolean(account.community),
    pending: account.next_zone && account.next_at > now ? { zone: account.next_zone } : null,
    mine: list(result[0])[0] ?? null, posts: list(result[1]), achievements: list(result[2]),
    ledger: list(result[3])
  };
}

export async function saveDiary(db, user, now, input) {
  const { title, body, id, revision, expected_day: expectedDay, shared = false } = input;
  if (typeof title !== "string" || !title.trim() || Array.from(title.trim()).length > 100 ||
      typeof body !== "string" || !body.trim() || Array.from(body).length > 20000 ||
      /[\p{Cs}]/u.test(title + body) || typeof shared !== "boolean") {
    throw new Problem(400, "제목은 1~100자, 본문은 1~20,000자로 입력해 주세요.");
  }
  if (id != null && (!validId(id) || !validId(revision))) throw new Problem(400, "일기를 다시 열어 주세요.");
  const length = countBody(body);
  return transaction(db, async () => {
    const account = await query(db, "SELECT * FROM accounts WHERE id=?", user).first();
    const today = accountDay(account, now);
    if (expectedDay != null && expectedDay !== today) {
      throw new Problem(409, "새 일기 날짜가 시작됐어요. 본문을 복사한 뒤 페이지를 새로 열어 주세요.");
    }
    const previous = id == null
      ? await query(db, "SELECT id FROM posts WHERE user=? AND day=?", user, today).first()
      : await query(db, "SELECT * FROM posts WHERE id=? AND user=?", id, user).first();
    if (id == null && previous) throw new Problem(409, "오늘은 이미 일기를 썼어요. 기존 글을 수정해 주세요.");
    if (id != null && !previous) throw new Problem(404, "수정할 일기를 찾을 수 없습니다.");
    if (previous && previous.revision !== revision) throw new Problem(409, "다른 창에서 수정됐어요. 일기를 다시 열어 주세요.");
    const day = previous?.day ?? today;
    const roll = previous?.roll ?? Math.floor(Math.random() * 51);
    const gold = reward(length, roll);
    const values = [title.trim(), body, length, gold, Number(shared), Number(length >= 100)];
    const write = previous
      ? query(db, "UPDATE posts SET title=?,body=?,length=?,gold=?,shared=?,eligible=?,revision=revision+1 WHERE id=? RETURNING id",
        ...values, id)
      : query(db, "INSERT INTO posts(title,body,length,gold,shared,eligible,user,day,roll) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id",
        ...values, user, day, roll);
    const data = await ledger(db, user);
    data.entries = data.entries.filter(row => row.day !== day);
    if (length >= 100) data.entries.push({ day, gold, length });
    data.entries.sort((a, b) => a.day.localeCompare(b.day));
    const granted = milestones(data, today);
    data.awards.push(...granted);
    return { statements: [write, ...awardStatements(db, user, granted)], result: ([row]) => ({
      id: list(row)[0].id, delta: gold - (previous?.gold ?? 0), length,
      eligible: length >= 100, streak: stats(data, today).streak
    }) };
  });
}

export async function react(db, user, now, { id, emoji }) {
  if (!validId(id) || !emojis.has(emoji)) throw new Problem(400, "일기와 이모지를 확인해 주세요.");
  return transaction(db, async () => {
    const [postResult, priorResult, accountResult] = await db.batch([
      query(db, "SELECT user,shared,eligible FROM posts WHERE id=? AND shared=1", id),
      query(db, "SELECT 1 FROM reactions WHERE user=? AND post=?", user, id),
      query(db, "SELECT * FROM accounts WHERE id=?", user)
    ]);
    const post = list(postResult)[0];
    if (!post) throw new Problem(404, "공유된 일기를 찾을 수 없습니다.");
    if (post.user === user || !post.eligible || list(priorResult).length) {
      throw new Problem(409, "이미 반응했거나 반응할 수 없는 일기입니다.");
    }
    const day = accountDay(list(accountResult)[0], now);
    const data = await ledger(db, user);
    const before = milestones(data, day);
    data.awards.push(...before);
    const [gold, tickets] = reactionRate(data.awards);
    data.reactions.push({ day, gold, tickets, count: 1 });
    const after = milestones(data, day);
    return {
      statements: [query(db, "INSERT INTO reactions VALUES (?,?,?,?,?,?)", user, id, day, emoji, gold, tickets),
        ...awardStatements(db, user, [...before, ...after])],
      result: { gold, tickets }
    };
  });
}

export async function buy(db, user, now, { key, item, quantity }) {
  if (typeof key !== "string" || !/^[a-zA-Z0-9-]{16,64}$/.test(key) ||
      typeof item !== "string" || !Object.hasOwn(prices, item) ||
      !Number.isInteger(quantity) || quantity < 1 || quantity > (item === SHIELD ? 2 : 1)) {
    throw new Problem(400, "상품과 수량을 확인해 주세요.");
  }
  return transaction(db, async () => {
    const [accountResult, priorResult] = await db.batch([
      query(db, "SELECT * FROM accounts WHERE id=?", user),
      query(db, "SELECT item,quantity FROM purchases WHERE user=? AND request=?", user, key)
    ]);
    const day = accountDay(list(accountResult)[0], now);
    const prior = list(priorResult)[0];
    if (prior) {
      if (prior.item !== item || prior.quantity !== quantity) throw new Problem(409, "이미 사용된 구매 요청입니다.");
      return { statements: [], result: { ok: true } };
    }
    const state = stats(await ledger(db, user), day);
    const cost = quantity * prices[item];
    if (item === SHIELD && state.shields + quantity > 2) throw new Problem(400, "방패 구매 한도는 2개입니다.");
    if (item === RESTORE && state.streak >= state.best) throw new Problem(400, "복구할 연속 기록이 없습니다.");
    if (state.gold < cost) throw new Problem(400, "골드가 부족합니다.");
    const restored = item === RESTORE ? state.best : 0;
    return {
      statements: [query(db, "INSERT INTO purchases VALUES (?,?,?,?,?,?,?)", user, key, day, item, quantity, cost, restored)],
      result: { ok: true }
    };
  });
}

export async function settings(db, user, now, { zone, community }) {
  if (!zones.includes(zone) || typeof community !== "boolean") throw new Problem(400, "시간대와 공개 범위를 선택해 주세요.");
  return transaction(db, async () => {
    const [accountResult, activityResult] = await db.batch([
      query(db, "SELECT * FROM accounts WHERE id=?", user),
      query(db, `SELECT 1 FROM posts WHERE user=? UNION ALL SELECT 1 FROM purchases WHERE user=?
        UNION ALL SELECT 1 FROM reactions WHERE user=? LIMIT 1`, user, user, user)
    ]);
    const current = zoneAt(list(accountResult)[0], now);
    const effective = list(activityResult).length ? agreeOnDate(now, current, zone) : now;
    const pending = effective > now;
    return { statements: [query(db, "UPDATE accounts SET zone=?,next_zone=?,next_at=?,community=? WHERE id=?",
      pending ? current : zone, pending ? zone : null, pending ? effective : null, Number(community), user)],
    result: { pending, effective: new Date(effective).toISOString() } };
  });
}
