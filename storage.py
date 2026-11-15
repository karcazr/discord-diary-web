"""SQLite ledger. Discord-independent rules, dates in the configured timezone."""
from __future__ import annotations

import random
import sqlite3
from collections import Counter
from contextlib import nullcontext
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo
from pathlib import Path


SHIELD = '방패'
STREAK_RESTORE = '연속기록복구'
SHOP_PRICES = {SHIELD: 2000, STREAK_RESTORE: 10000}
REACTION_TIERS = {100: 20, 500: 30, 1000: 50, 2000: 100, 5000: 100}


def body_length(body):
    import unicodedata
    return sum(not c.isspace() and unicodedata.category(c) not in {'Cf', 'Cc', 'Cs'} for c in body)


def diary_day(instant: datetime, zone: ZoneInfo) -> date:
    local = instant.astimezone(zone)
    # The exact 04:00 boundary still belongs to the closing diary day.
    return local.date() - timedelta(days=local.time() <= time(4))


class Store:
    def __init__(self, path: str | Path, timezone="Asia/Seoul", milestone=7):
        if milestone < 1:
            raise ValueError("SHIELD_MILESTONE must be positive")
        self.path=str(path)
        if self.path != ':memory:':
            import shutil
            database=Path(path)
            backup=Path(str(database)+'.backup')
            marker=Path(str(database)+'.initialized')
            if not database.exists() and backup.exists():
                shutil.copy2(backup,database)
            elif not database.exists() and marker.exists():
                raise RuntimeError('기존 DB가 사라졌습니다. 초기화를 중단합니다. DATABASE_PATH와 영구 저장소/백업을 확인하세요.')
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA busy_timeout=5000")
        self.milestone = milestone
        self.default_timezone = timezone
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS release_announcements (
                guild INTEGER, version TEXT, message INTEGER, PRIMARY KEY(guild,version));
            CREATE TABLE IF NOT EXISTS milestones (
                guild INTEGER NOT NULL, user INTEGER NOT NULL, key TEXT NOT NULL,
                label TEXT NOT NULL, day TEXT NOT NULL, gold INTEGER NOT NULL,
                tickets INTEGER NOT NULL, shields INTEGER NOT NULL, message INTEGER,
                PRIMARY KEY(guild,user,key));
            CREATE INDEX IF NOT EXISTS milestones_pending ON milestones(guild,message);
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS forums (
                guild INTEGER, channel INTEGER PRIMARY KEY, since TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
            CREATE TABLE IF NOT EXISTS forum_labels(channel INTEGER PRIMARY KEY,last_name TEXT,streak INTEGER);
            CREATE TABLE IF NOT EXISTS users (guild INTEGER, user INTEGER, PRIMARY KEY(guild,user));
            CREATE TABLE IF NOT EXISTS timezone_changes (guild INTEGER, effective TEXT, zone TEXT,
                PRIMARY KEY(guild,effective));
            CREATE TABLE IF NOT EXISTS forum_timezone_changes (channel INTEGER, effective TEXT, zone TEXT,
                PRIMARY KEY(channel,effective));
            CREATE TABLE IF NOT EXISTS seen (thread INTEGER PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS entries (
                thread INTEGER PRIMARY KEY, guild INTEGER, user INTEGER, day TEXT, gold INTEGER,
                UNIQUE(guild,user,day));
            CREATE TABLE IF NOT EXISTS reactions (
                guild INTEGER, user INTEGER, thread INTEGER, day TEXT, gold INTEGER NOT NULL DEFAULT 10,
                PRIMARY KEY(guild,user,thread));
            CREATE TABLE IF NOT EXISTS purchases (
                id INTEGER PRIMARY KEY, guild INTEGER, user INTEGER, day TEXT, quantity INTEGER, cost INTEGER);
            CREATE INDEX IF NOT EXISTS entries_user ON entries(guild,user,day);
            CREATE INDEX IF NOT EXISTS reactions_user ON reactions(guild,user);
            CREATE INDEX IF NOT EXISTS purchases_user ON purchases(guild,user,day);
        """)
        self.db.executescript('CREATE TABLE IF NOT EXISTS bodies(thread INTEGER PRIMARY KEY,length INTEGER,roll INTEGER); CREATE TABLE IF NOT EXISTS shield_notices(guild INTEGER,user INTEGER,day TEXT,PRIMARY KEY(guild,user,day));')
        if 'base_name' not in {r[1] for r in self.db.execute('PRAGMA table_info(forum_labels)')}:
            self.db.execute('ALTER TABLE forum_labels ADD COLUMN base_name TEXT')
        if 'eligible' not in {r[1] for r in self.db.execute('PRAGMA table_info(entries)')}:
            self.db.execute('ALTER TABLE entries ADD COLUMN eligible INTEGER NOT NULL DEFAULT 1')
        reaction_columns = {row[1] for row in self.db.execute('PRAGMA table_info(reactions)')}
        if 'original_gold' not in reaction_columns:
            self.db.execute('ALTER TABLE reactions ADD COLUMN original_gold INTEGER NOT NULL DEFAULT 10')
        if 'tickets' not in reaction_columns:
            self.db.execute('ALTER TABLE reactions ADD COLUMN tickets INTEGER NOT NULL DEFAULT 0')
        with self.db:
            self.db.execute('UPDATE reactions SET gold=0 WHERE thread IN (SELECT thread FROM entries WHERE eligible=0)')
        if self.path != ':memory:':
            Path(str(path)+'.initialized').touch()
        purchase_columns = {row[1] for row in self.db.execute('PRAGMA table_info(purchases)')}
        if 'item' not in purchase_columns:
            self.db.execute("ALTER TABLE purchases ADD COLUMN item TEXT NOT NULL DEFAULT '방패'")
        if 'restored_streak' not in purchase_columns:
            self.db.execute('ALTER TABLE purchases ADD COLUMN restored_streak INTEGER NOT NULL DEFAULT 0')
        if 'request_id' not in {r[1] for r in self.db.execute('PRAGMA table_info(purchases)')}:
            self.db.execute('ALTER TABLE purchases ADD COLUMN request_id TEXT')
        self.db.execute('CREATE UNIQUE INDEX IF NOT EXISTS purchase_request ON purchases(request_id) WHERE request_id IS NOT NULL')
        if 'owner' not in {r[1] for r in self.db.execute('PRAGMA table_info(forums)')}:
            self.db.execute('ALTER TABLE forums ADD COLUMN owner INTEGER')
        if 'bonus_eligible' not in {r[1] for r in self.db.execute('PRAGMA table_info(entries)')}:
            with self.db:
                self.db.execute('ALTER TABLE entries ADD COLUMN bonus_eligible INTEGER NOT NULL DEFAULT 0')
                # Retain bonuses already earned before this upgrade; new diaries never award shields.
                self.db.execute('''UPDATE entries SET bonus_eligible=1 WHERE thread IN (
                    SELECT thread FROM (SELECT thread, ROW_NUMBER() OVER (PARTITION BY guild,user ORDER BY day) AS n FROM entries)
                    WHERE n % ? = 0)''', (milestone,))
        self.db.execute('CREATE UNIQUE INDEX IF NOT EXISTS one_active_forum_per_owner ON forums(guild,owner) WHERE enabled=1 AND owner IS NOT NULL')
        with self.db:
            for key, value in {"timezone": timezone, "milestone": str(milestone)}.items():
                self.db.execute("INSERT OR IGNORE INTO settings VALUES (?,?)", (key, value))
                if self.db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()[0] != value:
                    raise ValueError(f"Existing database uses a different {key}; restore original .env setting")
            style=self.db.execute("SELECT value FROM settings WHERE key='forum_label_style'").fetchone()
            if not style or style[0]!='immutable-base-v4':
                self.db.execute('DELETE FROM forum_labels WHERE base_name IS NULL')
                self.db.execute("UPDATE forum_labels SET last_name='',streak=-1")
                self.db.execute("INSERT OR REPLACE INTO settings VALUES ('forum_label_style','immutable-base-v4')")
            # Preserve each forum's existing calendar when migrating the server-wide setting.
            for forum in self.db.execute('SELECT * FROM forums').fetchall():
                if not self.db.execute('SELECT 1 FROM forum_timezone_changes WHERE channel=?', (forum['channel'],)).fetchone():
                    since = datetime.fromisoformat(forum['since'])
                    self.db.execute('INSERT INTO forum_timezone_changes VALUES (?,?,?)',
                                    (forum['channel'],since.isoformat(),str(self.zone_at(forum['guild'],since))))
                    self.db.execute('INSERT OR IGNORE INTO forum_timezone_changes SELECT ?,effective,zone FROM timezone_changes WHERE guild=? AND effective>?',
                                    (forum['channel'],forum['guild'],since.isoformat()))

    def update_body(self, guild, user, thread, day, body, *, in_transaction=False):
        count = body_length(body)
        with nullcontext() if in_transaction else self.db:
            if not in_transaction:
                self.db.execute('BEGIN IMMEDIATE')
            previous = self.db.execute('SELECT * FROM bodies WHERE thread=?',(thread,)).fetchone()
            roll = previous['roll'] if previous else random.randint(0,50)
            if previous and previous['length']==count:
                return 'seen',0,count
            old = self.entry(thread)
            other = self.db.execute('SELECT thread FROM entries WHERE guild=? AND user=? AND day=? AND thread!=?',(guild,user,day,thread)).fetchone()
            if other:
                if self.has_seen(thread):
                    return 'seen',0,count
                self.db.execute('INSERT OR IGNORE INTO seen VALUES (?)',(thread,))
                return 'duplicate',0,count
            self._user(guild,user)
            self.db.execute('INSERT INTO bodies VALUES (?,?,?) ON CONFLICT(thread) DO UPDATE SET length=excluded.length',(thread,count,roll))
            reward = 0 if count<100 else (100+20*(count//100) if count>=1000 else (200 if count>=700 else 150 if count>=500 else 100 if count>=300 else 50)+roll)
            old_gold = old['gold'] if old else 0
            self.db.execute('INSERT INTO entries(thread,guild,user,day,gold,eligible) VALUES (?,?,?,?,?,?) ON CONFLICT(thread) DO UPDATE SET gold=excluded.gold,eligible=excluded.eligible',(thread,guild,user,day,reward,int(count>=100)))
            self.db.execute('UPDATE reactions SET gold=CASE WHEN ? THEN original_gold ELSE 0 END WHERE thread=?',(count>=100,thread))
            self.db.execute('INSERT OR IGNORE INTO seen VALUES (?)',(thread,))
            return ('updated' if old else 'new'),reward-old_gold,count

    def backup(self):
        if not self.path or self.path==':memory:':
            return
        target=Path(str(self.path)+'.backup')
        temporary=Path(str(target)+'.tmp')
        destination=sqlite3.connect(temporary)
        try:
            self.db.backup(destination)
        finally:
            destination.close()
        temporary.replace(target)

    def close(self):
        self.db.close()

    def _user(self, guild, user):
        self.db.execute("INSERT OR IGNORE INTO users VALUES (?,?)", (guild, user))

    def register(self, guild, channel, since, owner=None, admin=False):
        if not admin:
            raise ValueError('포럼 연결은 서버 관리자만 설정할 수 있습니다.')
        if owner is None:
            raise ValueError('연결할 사용자를 지정해 주세요.')
        with self.db:
            inherited_zone = str(self.user_zone(guild,owner,datetime.fromisoformat(since)))
            old = self.db.execute('SELECT * FROM forums WHERE channel=?', (channel,)).fetchone()
            if owner is not None and self.db.execute('SELECT 1 FROM forums WHERE guild=? AND owner=? AND enabled=1 AND channel!=?', (guild,owner,channel)).fetchone():
                raise ValueError('이 사용자는 이미 다른 포럼에 연결되어 있습니다. 기존 포럼을 먼저 해제하세요.')
            if old and not admin and old['owner'] != owner:
                raise ValueError('다른 사용자 또는 관리자가 등록한 포럼입니다. 관리자에게 소유자 연결을 요청하세요.')
            if old and old['owner'] is not None and old['owner'] != owner:
                raise ValueError('기존 포럼의 소유자는 변경할 수 없습니다. 다른 포럼을 사용하세요.')
            self.db.execute("""INSERT INTO forums(guild,channel,since,owner) VALUES (?,?,?,?)
                ON CONFLICT(channel) DO UPDATE SET enabled=1, owner=excluded.owner""", (guild, channel, since, owner))
            if not self.db.execute('SELECT 1 FROM forum_timezone_changes WHERE channel=?', (channel,)).fetchone():
                self.db.execute('INSERT INTO forum_timezone_changes VALUES (?,?,?)',
                                (channel,since,inherited_zone))

    def unregister(self, guild, channel, actor=None, admin=False):
        if not admin:
            raise ValueError('포럼 연결 해제는 서버 관리자만 할 수 있습니다.')
        with self.db:
            old = self.db.execute('SELECT * FROM forums WHERE guild=? AND channel=?', (guild,channel)).fetchone()
            if old and not admin and (old['owner'] is None or old['owner'] != actor):
                raise ValueError('본인 소유의 포럼만 해제할 수 있습니다.')
            return self.db.execute("UPDATE forums SET enabled=0 WHERE guild=? AND channel=? AND enabled=1",
                                   (guild, channel)).rowcount

    def forums(self, guild=None):
        sql = "SELECT * FROM forums WHERE enabled=1"
        return self.db.execute(sql + (" AND guild=?" if guild is not None else ""),
                               (guild,) if guild is not None else ()).fetchall()

    def forum(self, channel):
        return self.db.execute("SELECT * FROM forums WHERE channel=? AND enabled=1", (channel,)).fetchone()

    def user_forum(self, guild, user):
        return self.db.execute('SELECT * FROM forums WHERE guild=? AND owner=? ORDER BY enabled DESC, since DESC LIMIT 1',
                               (guild,user)).fetchone()

    def forum_zone(self, channel, instant):
        row = self.db.execute('SELECT zone FROM forum_timezone_changes WHERE channel=? AND effective<=? ORDER BY effective DESC LIMIT 1',
                              (channel,instant.astimezone(timezone.utc).isoformat())).fetchone()
        return ZoneInfo(row[0] if row else self.default_timezone)

    def user_zone(self, guild, user, instant):
        forum = self.user_forum(guild,user)
        return self.forum_zone(forum['channel'],instant) if forum else ZoneInfo(self.default_timezone)

    def entry(self, thread):
        return self.db.execute("SELECT * FROM entries WHERE thread=?", (thread,)).fetchone()

    def has_seen(self, thread):
        return self.db.execute("SELECT 1 FROM seen WHERE thread=?", (thread,)).fetchone() is not None

    def add_entry(self, guild, user, thread, day):
        """Return (new|duplicate|seen, reward). Atomic across all event paths."""
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            if self.has_seen(thread):
                return "seen", 0
            self._user(guild, user)
            self.db.execute("INSERT INTO seen VALUES (?)", (thread,))
            gold = random.randint(50, 150)
            added = self.db.execute("INSERT OR IGNORE INTO entries(thread,guild,user,day,gold) VALUES (?,?,?,?,?)",
                                    (thread, guild, user, day, gold)).rowcount
            return ("new", gold) if added else ("duplicate", 0)

    def reaction_rate(self, guild, user):
        tier = 0
        for row in self.db.execute("SELECT key FROM milestones WHERE guild=? AND user=? AND key LIKE 'reaction:%'", (guild,user)):
            tier = max(tier, int(row['key'].split(':')[1]))
        return REACTION_TIERS.get(tier, 10), int(tier >= 5000)

    def record_reaction(self, guild, user, thread, day, *, in_transaction=False):
        with nullcontext() if in_transaction else self.db:
            if not in_transaction:
                self.db.execute('BEGIN IMMEDIATE')
            entry = self.entry(thread)
            if entry is None or entry['guild'] != guild or entry['user'] == user or not entry['eligible']:
                return None
            self._user(guild, user)
            # Apply any existing progress before pricing this new reaction.
            self._award_milestones(guild, user, day)
            gold, tickets = self.reaction_rate(guild, user)
            inserted = self.db.execute('''INSERT OR IGNORE INTO reactions(guild,user,thread,day,gold,original_gold,tickets)
                VALUES (?,?,?,?,?,?,?)''', (guild,user,thread,day,gold,gold,tickets)).rowcount
            if inserted:
                self._award_milestones(guild, user, day)
                return gold, tickets
            return None

    def react(self, guild, user, thread, day):
        return self.record_reaction(guild, user, thread, day) is not None

    def _diary_progress(self, guild, user, day):
        rows = self.db.execute('''SELECT e.day, COALESCE(b.length,0) AS length
            FROM entries e LEFT JOIN bodies b ON b.thread=e.thread
            WHERE e.guild=? AND e.user=? AND e.eligible=1 AND e.day<=? ORDER BY e.day''', (guild,user,day))
        dates, characters = [], 0
        for row in rows:
            dates.append(date.fromisoformat(row['day']))
            characters += row['length']
        return dates, characters

    def award_milestones(self, guild, user, today):
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            self._award_milestones(guild, user, today.isoformat())

    def _award_milestones(self, guild, user, day):
        dates, characters = self._diary_progress(guild, user, day)
        keys = {row[0] for row in self.db.execute('SELECT key FROM milestones WHERE guild=? AND user=?', (guild,user))}
        occupied = set()
        for key in keys:
            if key.startswith('week:'):
                end = date.fromisoformat(key.split(':',1)[1])
                occupied.update(end-timedelta(days=n) for n in range(7))

        def award(key, label, gold=0, tickets=0, shields=0):
            if key not in keys:
                self.db.execute('INSERT INTO milestones(guild,user,key,label,day,gold,tickets,shields) VALUES (?,?,?,?,?,?,?,?)',
                                (guild,user,key,label,day,gold,tickets,shields))
                keys.add(key)

        previous, streak, best = None, 0, 0
        for current in dates:
            streak = streak+1 if previous and current-previous == timedelta(days=1) else 1
            best = max(streak,best)
            previous = current
            if streak >= 7:
                week = {current-timedelta(days=n) for n in range(7)}
                if occupied.isdisjoint(week):
                    award(f'week:{current}',f'완벽한 연속 일기 주 ({current-timedelta(days=6)}~{current})',tickets=1)
                    occupied.update(week)

        for threshold, gold, tickets in ((7,500,1),(30,1000,5)):
            if best >= threshold:
                award(f'streak:{threshold}',f'최초 연속 일기 {threshold:,}일',gold,tickets)
        for threshold in range(100,best+1,100):
            award(f'streak:{threshold}',f'최초 연속 일기 {threshold:,}일',2000,10,1)
        for threshold in range(365,best+1,365):
            award(f'anniversary:{threshold}',f'최초 연속 일기 {threshold:,}일 기념',3650,50)

        for threshold in range(10000,min(characters,90000)+1,10000):
            award(f'chars:{threshold}',f'누적 일기 {threshold:,}자',1000,threshold//1000)
        for threshold in range(100000,characters+1,100000):
            award(f'chars:{threshold}',f'누적 일기 {threshold:,}자',5000 if threshold==100000 else 0,100)

        reactions = self.db.execute('SELECT COUNT(*) FROM reactions WHERE guild=? AND user=? AND gold>0',(guild,user)).fetchone()[0]
        for threshold in REACTION_TIERS:
            if reactions >= threshold:
                award(f'reaction:{threshold}',f'누적 보상받은 반응 {threshold:,}개')

    def stats(self, guild, user, today: date):
        with self.db:
            self._user(guild, user)
        return self._stats(guild, user, today)

    def _stats(self, guild, user, today):
        entries = self.db.execute("SELECT * FROM entries WHERE guild=? AND user=? AND eligible=1 ORDER BY day",
                                  (guild, user)).fetchall()
        purchases = self.db.execute("SELECT * FROM purchases WHERE guild=? AND user=? ORDER BY day",
                                    (guild, user)).fetchall()
        reaction = self.db.execute("SELECT COUNT(CASE WHEN gold>0 THEN 1 END), COALESCE(SUM(gold),0), COALESCE(SUM(CASE WHEN gold>0 THEN tickets ELSE 0 END),0) FROM reactions WHERE guild=? AND user=?",
                                   (guild, user)).fetchone()
        days = {date.fromisoformat(e["day"]) for e in entries}
        legacy_bonus_days = {date.fromisoformat(e['day']) for e in entries if e['bonus_eligible']}
        bought = Counter()
        restored = {}
        for purchase in purchases:
            day = date.fromisoformat(purchase['day'])
            if purchase['item'] == SHIELD:
                bought[day] += purchase['quantity']
            elif purchase['item'] == STREAK_RESTORE:
                restored[day] = max(restored.get(day, 0), purchase['restored_streak'])
        awards = self.db.execute('SELECT day,gold,tickets,shields FROM milestones WHERE guild=? AND user=? AND day<=?',
                                 (guild,user,today.isoformat())).fetchall()
        granted = Counter()
        for award in awards:
            granted[date.fromisoformat(award['day'])] += award['shields']
        shields, used, streak, best, total = 2, 0, 0, 0, 0
        # Replay the ledger so an offline diary can repair an apparent gap.
        # Purchases only apply on/after their actual date, never retroactively.
        event_days = sorted(days | set(bought) | set(restored) | set(granted))
        previous = None
        shield_days=[]
        for current in event_days + [today + timedelta(days=1)]:
            if previous is not None:
                gap = max(0, (min(current, today) - previous).days - 1)
                if streak:
                    spent = min(shields, gap)
                    shield_days.extend((previous+timedelta(days=n+1)).isoformat() for n in range(spent))
                    shields -= spent
                    used += spent
                    if gap > spent:
                        streak = 0
            if current > today:
                break
            shields += min(bought[current], max(0, 2-shields))
            shields += granted[current]
            if current in days:
                total += 1
                streak += 1
                best = max(best, streak)
                if current in legacy_bonus_days:
                    shields = max(shields, min(2, shields + 1))
            # The purchase restores that day's counter without creating a diary.
            # Historical edits can reduce the earned best, never create a higher one.
            streak = max(streak, min(restored.get(current, 0), best))
            if current not in days and current < today and streak:
                if shields:
                    shield_days.append(current.isoformat())
                    shields -= 1
                    used += 1
                else:
                    streak = 0
            previous = current
        _, characters = self._diary_progress(guild,user,today.isoformat())
        rate, reaction_tickets = self.reaction_rate(guild,user)
        next_reaction = next((n for n in REACTION_TIERS if n>reaction[0]), None)
        return dict(characters=characters, tickets=sum(a['tickets'] for a in awards)+reaction[2],
                    reaction_rate=rate, reaction_tickets=reaction_tickets, next_reaction=next_reaction,
                    milestones=len(awards), shield_days=shield_days,total=len(entries), streak=streak, best=best, shields=shields, used=used,
                    gold=sum(e["gold"] for e in entries) + reaction[1] + sum(a["gold"] for a in awards) - sum(p["cost"] for p in purchases),
                    reactions=reaction[0], today=today in days,
                    last=entries[-1]["day"] if entries else None)

    def buy(self, guild, user, today, quantity=1, item=SHIELD, request_id=None):
        if item not in SHOP_PRICES:
            raise ValueError('판매하지 않는 상품입니다.')
        maximum = 2 if item == SHIELD else 1
        if type(quantity) is not int or not 1 <= quantity <= maximum:
            raise ValueError(f'{item} 구매 개수는 ' + ('1~2개입니다.' if maximum == 2 else '1개입니다.'))
        cost = quantity * SHOP_PRICES[item]
        request_key = str(request_id) if request_id is not None else None
        with self.db:
            self.db.execute('BEGIN IMMEDIATE')
            self._user(guild, user)
            if request_key is not None:
                prior = self.db.execute('SELECT * FROM purchases WHERE request_id=?', (request_key,)).fetchone()
                if prior:
                    if (prior['guild'], prior['user'], prior['quantity'], prior['item']) != (guild, user, quantity, item):
                        raise ValueError('이미 사용된 구매 요청입니다.')
                    return self._stats(guild, user, today)
            state = self._stats(guild, user, today)
            restored_streak = 0
            if item == SHIELD and state['shields'] + quantity > 2:
                raise ValueError('구매 후 방패는 최대 2개까지 보유할 수 있습니다. 골드는 차감되지 않았습니다.')
            if item == STREAK_RESTORE:
                if state['streak'] >= state['best']:
                    raise ValueError('복구할 연속 기록이 없습니다. 골드는 차감되지 않았습니다.')
                restored_streak = state['best']
            if state['gold'] < cost:
                raise ValueError(f"골드가 부족합니다. 필요 {cost:,} / 보유 {state['gold']:,}")
            self.db.execute(
                'INSERT INTO purchases(guild,user,day,quantity,cost,request_id,item,restored_streak) VALUES (?,?,?,?,?,?,?,?)',
                (guild, user, today.isoformat(), quantity, cost, request_key, item, restored_streak),
            )
            return self._stats(guild, user, today)

    def zone_at(self, guild, instant):
        row = self.db.execute('SELECT zone FROM timezone_changes WHERE guild=? AND effective<=? ORDER BY effective DESC LIMIT 1',
                              (guild,instant.astimezone(timezone.utc).isoformat())).fetchone()
        return ZoneInfo(row[0] if row else self.default_timezone)

    def change_zone(self, channel, zone, now):
        forum = self.forum(channel)
        if not forum:
            raise ValueError('먼저 해당 포럼을 사용자에게 연결해 주세요.')
        if zone not in {'Asia/Seoul','America/Toronto'}:
            raise ValueError('한국 또는 토론토만 선택할 수 있습니다.')
        now = now.astimezone(timezone.utc)
        current = self.forum_zone(channel,now)
        target = ZoneInfo(zone)
        effective = now
        has_activity = self.db.execute('SELECT 1 FROM entries WHERE guild=? AND user=? UNION ALL SELECT 1 FROM purchases WHERE guild=? AND user=? LIMIT 1',
                                       (forum['guild'],forum['owner'],forum['guild'],forum['owner'])).fetchone()
        # Switch only when both calendars agree, so a day cannot be counted twice/skipped.
        while has_activity and diary_day(effective, current) != diary_day(effective, target):
            effective += timedelta(minutes=1)
        with self.db:
            self.db.execute('DELETE FROM forum_timezone_changes WHERE channel=? AND effective>?', (channel,now.isoformat()))
            self.db.execute('INSERT OR REPLACE INTO forum_timezone_changes VALUES (?,?,?)', (channel,effective.isoformat(),zone))
        return effective

    def pending_zone(self, channel, now):
        return self.db.execute('SELECT * FROM forum_timezone_changes WHERE channel=? AND effective>? ORDER BY effective LIMIT 1',
                               (channel,now.astimezone(timezone.utc).isoformat())).fetchone()

    def history(self, guild, user, limit=10):
        return self.db.execute("SELECT * FROM entries WHERE guild=? AND user=? ORDER BY day DESC LIMIT ?",
                               (guild,user,limit)).fetchall()

    def week_history(self,guild,user,today):
        first=today-timedelta(days=6)
        entries={r['day']:r for r in self.db.execute('SELECT * FROM entries WHERE guild=? AND user=? AND day BETWEEN ? AND ?',
                 (guild,user,first.isoformat(),today.isoformat()))}
        reactions={r['day']:(r['n'],r['gold']) for r in self.db.execute('SELECT day,COUNT(*) n,SUM(gold) gold FROM reactions WHERE guild=? AND user=? AND gold>0 AND day BETWEEN ? AND ? GROUP BY day',
                   (guild,user,first.isoformat(),today.isoformat()))}
        rows=[]
        for n in range(7):
            day=(today-timedelta(days=n)).isoformat()
            entry=entries.get(day)
            gold=entry['gold'] if entry and entry['eligible'] else 0
            count,reaction_gold=reactions.get(day,(0,0))
            rows.append(dict(day=day,thread=entry['thread'] if entry else None,gold=gold,reactions=count,reaction_gold=reaction_gold,total=gold+reaction_gold))
        return rows

    def ledger(self, guild, user):
        return self.db.execute("""SELECT day, '일기' kind, gold amount FROM entries WHERE guild=? AND user=?
            UNION ALL SELECT day, '반응', gold FROM reactions WHERE guild=? AND user=?
            UNION ALL SELECT day, item || ' 구매', -cost FROM purchases WHERE guild=? AND user=?
            UNION ALL SELECT day, label, gold FROM milestones WHERE guild=? AND user=? AND gold>0
            ORDER BY day DESC LIMIT 15""", (guild,user,guild,user,guild,user,guild,user)).fetchall()

    def ranking(self, guild, instant, metric):
        if metric not in {"total", "streak", "gold"}:
            raise ValueError("Unknown ranking metric")
        users = self.db.execute("SELECT user FROM users WHERE guild=?", (guild,)).fetchall()
        rows = [(u[0], self.stats(guild,u[0],diary_day(instant,self.user_zone(guild,u[0],instant)))[metric]) for u in users]
        return sorted(rows, key=lambda r: (-r[1], r[0]))[:10]
