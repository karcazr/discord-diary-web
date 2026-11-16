export const SHIELD = "방패";
export const RESTORE = "연속기록복구";
export const prices = { [SHIELD]: 2000, [RESTORE]: 10000 };
export const zones = ["Asia/Seoul", "America/Toronto"];
const tiers = [[100, 20], [500, 30], [1000, 50], [2000, 100], [5000, 100]];
const labels = new Intl.NumberFormat("ko-KR");
const calendars = new Map(zones.map(zone => [zone, new Intl.DateTimeFormat("en-CA", {
  timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
})]));

export function shift(day, days) {
  return new Date(Date.parse(day) + days * 86400000).toISOString().slice(0, 10);
}

function distance(start, end) {
  return (Date.parse(end) - Date.parse(start)) / 86400000;
}

export function diaryDay(now, zone) {
  const local = Object.fromEntries(calendars.get(zone).formatToParts(now).map(part => [part.type, part.value]));
  const day = `${local.year}-${local.month}-${local.day}`;
  const beforeClose = local.hour < "04" || (local.hour === "04" && local.minute === "00" &&
    local.second === "00" && new Date(now).getUTCMilliseconds() === 0);
  return beforeClose ? shift(day, -1) : day;
}

export function zoneAt(account, now) {
  return account.next_zone && now >= account.next_at ? account.next_zone : account.zone;
}

export function agreeOnDate(now, from, to) {
  // The calendars overlap daily. Binary search the first shared date using the
  // next agreeing minute as a bound, so the process takes a few dozen lookups.
  const agree = at => diaryDay(at, from) === diaryDay(at, to);
  if (agree(now)) return now;
  let later = now + 3600000;
  while (!agree(later)) later += 3600000;
  let earlier = later - 3600000;
  while (later - earlier > 1) {
    const middle = Math.floor((later + earlier) / 2);
    if (agree(middle)) later = middle;
    else earlier = middle;
  }
  return later;
}

export function countBody(body) {
  return Array.from(body).filter(char => !/[\p{White_Space}\p{Cf}\p{Cc}\p{Cs}]/u.test(char)).length;
}

export function reward(length, roll) {
  if (length >= 1000) return 100 + 20 * Math.floor(length / 100);
  if (length >= 700) return 200 + roll;
  if (length >= 500) return 150 + roll;
  if (length >= 300) return 100 + roll;
  return length >= 100 ? 50 + roll : 0;
}

export function reactionRate(awards) {
  const tier = tiers.findLast(([threshold]) => awards.some(award => award.key === `reaction:${threshold}`));
  return tier ? [tier[1], Number(tier[0] === 5000)] : [10, 0];
}

export function milestones(ledger, today) {
  const existing = new Set(ledger.awards.map(award => award.key));
  const occupied = new Set();
  for (const key of existing) {
    if (!key.startsWith("week:")) continue;
    for (let days = 0; days < 7; days++) occupied.add(shift(key.slice(5), -days));
  }
  const earned = [];
  function grant(key, label, gold = 0, tickets = 0, shields = 0) {
    if (existing.has(key)) return;
    earned.push({ key, label, day: today, gold, tickets, shields });
    existing.add(key);
  }
  let previous = null;
  let streak = 0;
  let best = 0;
  let characters = 0;
  for (const entry of ledger.entries) {
    if (entry.day > today) continue;
    streak = previous && distance(previous, entry.day) === 1 ? streak + 1 : 1;
    previous = entry.day;
    best = Math.max(streak, best);
    characters += entry.length;
    if (streak >= 7) {
      const week = Array.from({ length: 7 }, (_, days) => shift(entry.day, -days));
      if (week.every(day => !occupied.has(day))) {
        grant(`week:${entry.day}`, `완벽한 연속 일기 주 (${week[6]}~${entry.day})`, 0, 1);
        week.forEach(day => occupied.add(day));
      }
    }
  }
  for (const [days, gold, tickets] of [[7, 500, 1], [30, 1000, 5]]) {
    if (best >= days) grant(`streak:${days}`, `최초 연속 일기 ${days}일`, gold, tickets);
  }
  for (let days = 100; days <= best; days += 100) {
    grant(`streak:${days}`, `최초 연속 일기 ${labels.format(days)}일`, 2000, 10, 1);
  }
  for (let days = 365; days <= best; days += 365) {
    grant(`anniversary:${days}`, `최초 연속 일기 ${labels.format(days)}일 기념`, 3650, 50);
  }
  for (let count = 10000; count <= Math.min(characters, 90000); count += 10000) {
    grant(`chars:${count}`, `누적 일기 ${labels.format(count)}자`, 1000, count / 1000);
  }
  for (let count = 100000; count <= characters; count += 100000) {
    grant(`chars:${count}`, `누적 일기 ${labels.format(count)}자`, count === 100000 ? 5000 : 0, 100);
  }
  const reactions = ledger.reactions.reduce((sum, row) => sum + row.count, 0);
  for (const [count] of tiers) {
    if (reactions >= count) grant(`reaction:${count}`, `누적 보상받은 반응 ${labels.format(count)}개`);
  }
  return earned;
}

export function stats({ entries, purchases, reactions, awards }, today) {
  const events = new Map();
  function event(day) {
    if (!events.has(day)) events.set(day, { wrote: false, bought: 0, granted: 0, restored: 0 });
    return events.get(day);
  }
  let gold = 0;
  let characters = 0;
  let tickets = 0;
  let reactionCount = 0;
  for (const entry of entries) {
    gold += entry.gold;
    if (entry.day <= today) {
      event(entry.day).wrote = true;
      characters += entry.length;
    }
  }
  for (const row of purchases) {
    gold -= row.cost;
    if (row.day > today) continue;
    const day = event(row.day);
    if (row.item === SHIELD) day.bought += row.quantity;
    else day.restored = Math.max(day.restored, row.restored);
  }
  for (const award of awards) {
    if (award.day > today) continue;
    gold += award.gold;
    tickets += award.tickets;
    if (award.shields) event(award.day).granted += award.shields;
  }
  for (const row of reactions) {
    gold += row.gold;
    tickets += row.tickets;
    reactionCount += row.count;
  }

  let shields = 2;
  let streak = 0;
  let best = 0;
  let previous = null;
  const spent = [];
  const days = [...events.keys()].sort();
  for (const day of [...days, shift(today, 1)]) {
    if (previous && streak) {
      const gap = Math.max(0, distance(previous, day > today ? today : day) - 1);
      const used = Math.min(shields, gap);
      for (let offset = 1; offset <= used; offset++) spent.push(shift(previous, offset));
      shields -= used;
      if (gap > used) streak = 0;
    }
    if (day > today) break;
    const { wrote, bought, granted, restored } = events.get(day);
    shields += Math.min(bought, Math.max(0, 2 - shields)) + granted;
    if (wrote) best = Math.max(best, ++streak);
    streak = Math.max(streak, Math.min(restored, best));
    if (!wrote && day < today && streak) {
      if (shields) {
        shields--;
        spent.push(day);
      } else streak = 0;
    }
    previous = day;
  }
  const [reactionGold, reactionTickets] = reactionRate(awards);
  return {
    gold, tickets, shields, streak, best, characters, total: entries.length, used: spent.length,
    shield_days: spent, today: Boolean(events.get(today)?.wrote), last: entries.at(-1)?.day ?? null,
    milestones: awards.filter(award => award.day <= today).length, reactions: reactionCount,
    reaction_rate: reactionGold, reaction_tickets: reactionTickets,
    next_reaction: tiers.find(([count]) => count > reactionCount)?.[0] ?? null
  };
}
