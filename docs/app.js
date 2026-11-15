"use strict";

const root = document.querySelector("#root");
const account = document.querySelector("#account");
const navigation = document.querySelector("#navigation");
const loginDialog = document.querySelector("#login-dialog");
const toast = document.querySelector("#toast");
const format = new Intl.NumberFormat("ko-KR");
const tabs = { diary: "내 일기", community: "공유 일기", shop: "상점", profile: "내 정보", settings: "설정" };
const reactionEmojis = ["❤️", "👏", "🔥", "👍", "🎉", "💯"];
const number = value => format.format(value);
const date = value => value ? value.replaceAll("-", ".") : "—";
const zone = value => value === "America/Toronto" ? "토론토" : "한국";
const escape = value => String(value ?? "").replace(/[&<>"']/g, ch => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[ch]);
let session;
let dashboard;
let tab = Object.hasOwn(tabs, location.hash.slice(1)) ? location.hash.slice(1) : "diary";
let editing = null;
let toastTimer;
let pendingPurchase;

function notify(message) {
  toast.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.textContent = ""; }, 6500);
}

async function api(path, data) {
  const options = { redirect: "error", cache: "no-store" };
  if (data !== undefined) {
    options.method = "POST";
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(data);
  }
  const response = await fetch("/api/" + path, options);
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("일기 서버에 연결할 수 없습니다.");
  }
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && session?.user) location.reload();
    throw new Error(result.error);
  }
  return result;
}

function setLogin(server = "", message = "") {
  const link = document.querySelector("#discord-login");
  const detail = document.querySelector("#login-message");
  link.hidden = !server;
  if (server) link.href = server;
  detail.textContent = message || (server ? "" : "Discord 로그인 준비 중");
  detail.hidden = !detail.textContent;
}

function openLogin() {
  if (!loginDialog.open) loginDialog.showModal();
}

function renderGuestWeek() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  const month = new Intl.DateTimeFormat("ko-KR", { month: "long", year: "numeric" });
  document.querySelector("#week-month").textContent = month.format(now);
  document.querySelector("#week-days").innerHTML = ["월", "화", "수", "목", "금", "토", "일"].map((label, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    const key = [day.getFullYear(), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0")].join("-");
    return `<li><small>${label}</small><time datetime="${key}"${index === (now.getDay() + 6) % 7 ? ' aria-current="date"' : ""}>${day.getDate()}</time></li>`;
  }).join("");
  document.querySelector("#guest-week").hidden = false;
}

function avatar(user, large = false) {
  const icon = /^(a_)?[0-9a-f]{32}$/i.test(user.avatar ?? "") && /^\d+$/.test(user.id)
    ? `<img src="https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.webp?size=${large ? 128 : 64}" alt="">`
    : escape(Array.from(user.name.trim())[0] ?? "?");
  return `<span class="avatar${large ? " avatar-large" : ""}" aria-hidden="true">${icon}</span>`;
}

function stat(title, value) {
  return `<div class="stat"><dt class="stat-label">${title}</dt><dd>${value}</dd></div>`;
}

function diaryPanel() {
  const post = editing ?? dashboard.mine;
  const previous = post && post.day !== dashboard.today;
  const recent = dashboard.week.map(row => `<li class="between"><strong>${date(row.day)}</strong>
      <span class="meta">${number(row.gold)} + ${number(row.reaction_gold)} (공감 ${number(row.reactions)}회) = <b>${number(row.total)} G</b></span></li>`).join("");
  const alerts = dashboard.notices.map(notice => `<li class="between"><span>${date(notice.day)}${notice.title ? ` · ${escape(notice.title)}` : ""}</span><b>−1</b></li>`).join("");
  return `<div class="layout">
    <section class="panel editor">
      <div class="between editor-head"><h2>${previous ? date(post.day) + " 일기 수정" : "오늘의 일기"}</h2><span class="badge">${dashboard.profile.today ? "출석 완료" : "출석 전"}</span></div>
      <form id="diary-form">
        <label class="sr-only" for="title">제목</label><input class="title-input" id="title" name="title" maxlength="100" required value="${escape(post?.title)}" placeholder="제목">
        <label class="sr-only" for="body">본문</label><textarea id="body" name="body" maxlength="40000" required placeholder="본문">
${escape(post?.body)}</textarea>
        <div class="between editor-foot">
          <label class="checkbox" title="100자 이상인 일기를 다른 회원과 공유해요."><input type="checkbox" name="shared" ${post?.shared ? "checked" : ""}> 공유</label>
          <div class="actions"><p class="meta" id="count"></p>
          ${previous ? '<button class="quiet" type="button" data-action="today">오늘 일기</button>' : ""}
          <button type="submit">저장</button></div></div>
      </form>
    </section>
    <div class="stack">
      <section class="panel"><div class="between"><h2>최근 7일</h2><span class="meta">일기 + 공감</span></div><ul class="rows">${recent}</ul></section>
      ${alerts ? `<section class="panel"><h2>방패 사용 기록</h2><ul class="rows">${alerts}</ul></section>` : ""}
    </div></div>`;
}

function communityPanel() {
  const posts = dashboard.posts.map(post => {
    const own = post.user === session.user.id;
    const buttons = reactionEmojis.map(emoji => `<button class="quiet" type="button" data-action="react" data-id="${post.id}" data-emoji="${emoji}" aria-label="${emoji} 공감">${emoji}</button>`).join("");
    return `<details class="panel post" data-post="${post.id}">
      <summary><strong class="post-title">${escape(post.title)}</strong> <span class="meta">· ${escape(post.name)} · ${date(post.day)} · 공감 ${post.likes}${own && !(post.shared && post.eligible) ? " · 나만 보기" : ""}</span></summary>
      <p class="post-body">${escape(post.body)}</p>
      <div class="between post-footer"><span class="meta">${number(post.length)}자 · ${number(post.gold)} G ${post.eligible ? "" : "· 출석 미인정"}</span>
        <div class="actions">${own ? `<button type="button" class="quiet" data-action="edit" data-id="${post.id}">수정</button>` : post.reacted ? `<span class="badge">${escape(post.reacted)} 공감 완료</span>` : buttons}</div></div>
    </details>`;
  }).join("");
  const awards = dashboard.achievements.map(award => `<li><b>${escape(award.name)}</b>님이 ${escape(award.label)}을 달성했어요.
    <div class="meta">${date(award.day)} ${award.gold ? `· ${number(award.gold)} G` : ""} ${award.tickets ? `· 티켓 ${award.tickets}` : ""} ${award.shields ? `· 방패 ${award.shields}` : ""}</div></li>`).join("");
  return `<div class="layout"><section class="stack" aria-label="커뮤니티 일기">${posts || '<p class="panel subtle">아직 등록된 일기가 없어요.</p>'}</section>
    <section class="panel"><h2>마일스톤</h2><ul class="rows">${awards || '<li class="subtle">아직 달성 소식이 없어요.</li>'}</ul></section></div>`;
}

function shopPanel() {
  const state = dashboard.profile;
  const rows = dashboard.ledger.map(row => `<li class="between"><span>${date(row.day)} · ${escape(row.kind)}</span><b>${row.amount > 0 ? "+" : ""}${number(row.amount)} G</b></li>`).join("");
  return `<div class="layout"><section class="panel"><h2>상점</h2><ul class="rows">
    <li><div class="between"><div><b>방패</b><p class="subtle">2,000 G · 구매 한도 2개</p></div>
      <div class="actions"><button data-action="buy" data-item="방패" data-quantity="1" ${state.shields >= 2 || state.gold < 2000 ? "disabled" : ""}>1개 구매</button>
      <button data-action="buy" data-item="방패" data-quantity="2" ${state.shields !== 0 || state.gold < 4000 ? "disabled" : ""}>2개 구매</button></div></div></li>
    <li><div class="between"><div><b>연속 기록 복구</b><p class="subtle">10,000 G · 최고 기록으로 복구</p></div>
      <button data-action="buy" data-item="연속기록복구" data-quantity="1" ${state.streak >= state.best || state.gold < 10000 ? "disabled" : ""}>기록 복구</button></div></li></ul>
    </section>
    <section class="panel"><h2>최근 골드 내역</h2><ul class="rows">${rows || '<li class="subtle">골드 내역이 없어요.</li>'}</ul></section></div>`;
}

function profilePanel() {
  const state = dashboard.profile;
  const lists = Object.entries({ streak: "연속 기록", gold: "골드", total: "누적 일기" }).map(([key, title]) =>
    `<h3>${title}</h3><ol class="rows">${dashboard.ranking[key].map((member, index) =>
      `<li class="between"><span>${index + 1}. ${escape(member.name)}</span><b>${number(member.value)}</b></li>`).join("") || '<li class="subtle">공개 기록 없음</li>'}</ol>`).join("");
  return `<div class="layout profile-layout">
    <section class="panel" aria-label="내 프로필">
      <div class="profile-name">${avatar(session.user, true)}<div><strong>${escape(session.user.name)}</strong>
        <p class="meta">${state.today ? "오늘 출석 완료" : "오늘 출석 전"}</p></div></div>
      <dl class="stat-grid">
        ${stat("연속 일기", number(state.streak) + "일")}
        ${stat("최고 기록", number(state.best) + "일")}
        ${stat("골드", number(state.gold) + " G")}
        ${stat("방패", number(state.shields) + "개")}
        ${stat("누적 일기", number(state.total) + "편")}
        ${stat("누적 글자 수", number(state.characters) + "자")}
        ${stat("룰렛 티켓", number(state.tickets) + "장")}
        ${stat("보상받은 공감", number(state.reactions) + "회")}
      </dl>
    </section>
    <div class="stack">
      <section class="panel"><h2>활동</h2><ul class="rows">
        <li class="between"><span>마지막 출석</span><b>${date(state.last)}</b></li>
        <li class="between"><span>마일스톤</span><b>${number(state.milestones)}개</b></li>
        <li class="between"><span>사용한 방패</span><b>${number(state.used)}개</b></li>
        <li class="between"><span>공감 보상</span><b>${number(state.reaction_rate)} G${state.reaction_tickets ? " + 티켓 1장" : ""}</b></li>
        ${state.next_reaction ? `<li class="between"><span>다음 공감 목표</span><b>${number(state.next_reaction)}회</b></li>` : ""}
      </ul></section>
      <details class="panel rankings"><summary>순위</summary>${lists}</details>
    </div>
  </div>`;
}

function settingsPanel() {
  const current = dashboard.pending?.zone ?? dashboard.zone;
  return `<section class="panel"><form id="settings-form">
    <label for="zone">일기 집계 시간대</label>
    <select id="zone" name="zone">
      <option value="Asia/Seoul" ${current === "Asia/Seoul" ? "selected" : ""}>한국</option>
      <option value="America/Toronto" ${current === "America/Toronto" ? "selected" : ""}>토론토</option>
    </select>
    <label class="checkbox"><input type="checkbox" name="community" ${dashboard.community ? "checked" : ""}> 순위와 마일스톤에 내 기록 공개</label>
    <button type="submit">저장</button>
    </form></section>`;
}

function render() {
  const panels = { diary: diaryPanel, community: communityPanel, shop: shopPanel, profile: profilePanel, settings: settingsPanel };
  for (const button of navigation.querySelectorAll("[data-tab]")) {
    if (button.dataset.tab === tab) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  const subtitle = tab === "diary" ? `${date(dashboard.today)} · ${zone(dashboard.zone)} 04:00 마감` : "";
  root.innerHTML = `<div class="heading"><div><h1 tabindex="-1">${tabs[tab]}</h1>${subtitle ? `<p class="meta">${subtitle}</p>` : ""}</div>
    ${tab === "shop" ? `<b>${number(dashboard.profile.gold)} G</b>` : ""}
    ${tab === "settings" ? '<button class="quiet" id="logout" type="button">로그아웃</button>' : ""}</div>
    ${tab === "settings" && dashboard.pending ? `<p class="notice">${zone(dashboard.pending.zone)} 시간대 전환 예정</p>` : ""}
    ${panels[tab]()}`;
  updateCount();
}

function updateCount() {
  const input = document.querySelector("#body");
  if (!input) return;
  const count = Array.from(input.value).filter(ch => !/[\p{White_Space}\p{Cf}\p{Cc}\p{Cs}]/u.test(ch)).length;
  const counter = document.querySelector("#count");
  counter.textContent = count >= 100 ? `${number(count)}자 · 출석 가능` : `${number(count)} / 100자`;
  counter.title = "출석 기준 · 공백 제외 100자";
}

async function load() {
  const open = Array.from(root.querySelectorAll("details[open]"), item => item.dataset.post);
  dashboard = await api("dashboard");
  render();
  for (const id of open) {
    const post = root.querySelector(`details[data-post="${id}"]`);
    if (post) post.open = true;
  }
}

function hasUnsavedDiary() {
  const form = document.querySelector("#diary-form");
  if (!form) return false;
  const original = editing ?? dashboard.mine;
  return form.elements.title.value !== (original?.title ?? "") ||
    form.elements.body.value !== (original?.body ?? "") || form.elements.shared.checked !== Boolean(original?.shared);
}

function selectTab(next, nextPost = null) {
  if (!dashboard) {
    if (next !== "diary") openLogin();
    return;
  }
  if (tab === next && editing === nextPost) return;
  if (hasUnsavedDiary() && !confirm("저장하지 않은 일기를 닫을까요?")) return;
  editing = nextPost;
  tab = next;
  history.replaceState(null, "", "#" + tab);
  render();
  root.querySelector("h1").focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

async function submitting(button, action) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    await action();
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
}

root.addEventListener("input", event => {
  if (event.target.id === "body") updateCount();
});
root.addEventListener("click", event => {
  const logout = event.target.closest("#logout");
  if (logout) {
    submitting(logout, async () => {
      await api("logout", {});
      location.replace(location.pathname);
    });
    return;
  }
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id, emoji, item, quantity } = button.dataset;
  if (action === "login") {
    openLogin();
  } else if (action === "edit" || action === "today") {
    const post = action === "edit" ? dashboard.posts.find(post => post.id === Number(id)) : null;
    selectTab("diary", post);
  } else if (action === "react") {
    submitting(button, async () => {
      const reward = await api("react", { id: Number(id), emoji });
      notify(`공감 완료 · +${number(reward.gold)} G${reward.tickets ? " · 티켓 1개" : ""}`);
      await load();
    });
  } else if (action === "buy") {
    if (!confirm(`${item} ${quantity}개를 ${number(dashboard.prices[item] * Number(quantity))} G에 구매할까요?`)) return;
    const identity = `${item}:${quantity}`;
    submitting(button, async () => {
      if (pendingPurchase?.identity !== identity) pendingPurchase = { identity, key: crypto.randomUUID() };
      await api("buy", { item, quantity: Number(quantity), key: pendingPurchase.key });
      pendingPurchase = null;
      notify(`${item} 구매 완료`);
      await load();
    });
  }
});
root.addEventListener("submit", event => {
  const form = event.target;
  if (form.id !== "diary-form" && form.id !== "settings-form") return;
  event.preventDefault();
  const fields = new FormData(form);
  submitting(event.submitter ?? form.querySelector("button"), async () => {
    if (form.id === "diary-form") {
      const post = editing ?? dashboard.mine;
      const result = await api("diaries", { title: fields.get("title"), body: fields.get("body"),
        id: post?.id, revision: post?.revision, shared: fields.has("shared"), expected_day: editing ? undefined : dashboard.today });
      editing = null;
      notify(result.eligible
        ? `일기 저장 · ${result.delta >= 0 ? "+" : ""}${number(result.delta)} G · 연속 ${result.streak}일`
        : `일기 저장 · ${result.length}자 · 출석 미인정${result.delta < 0 ? ` · ${number(result.delta)} G` : ""}`);
    } else {
      const result = await api("settings", { zone: fields.get("zone"), community: fields.has("community") });
      notify(result.pending ? "시간대 전환을 예약했어요." : "일기장 설정을 저장했어요.");
    }
    await load();
  });
});
account.addEventListener("click", event => {
  if (event.target.closest("#login")) openLogin();
  else if (event.target.closest("#profile-button")) selectTab("profile");
});
navigation.addEventListener("click", event => {
  const button = event.target.closest("[data-tab]");
  if (button) selectTab(button.dataset.tab);
});

async function start() {
  renderGuestWeek();
  try {
    if (location.hostname.endsWith(".github.io")) {
      const configured = /^https:\/\/[^/?#]+$/.test(window.DIARY_SERVER_ORIGIN) ? window.DIARY_SERVER_ORIGIN : "";
      setLogin(configured && configured + "/auth/discord");
      return;
    }
    session = await api("session");
    if (!session.user) {
      const message = new URLSearchParams(location.search).get("auth_error");
      setLogin(session.ready ? "/auth/discord" : "", message);
      if (message) {
        history.replaceState(null, "", location.pathname);
        openLogin();
      }
      return;
    }
    await load();
    if (loginDialog.open) loginDialog.close();
    account.innerHTML = `<div class="account"><button id="profile-button" class="quiet account-profile" type="button"
      aria-label="내 정보">${avatar(session.user)}<span class="account-name">${escape(session.user.name)}</span></button></div>`;
  } catch (error) {
    setLogin("", error.message);
  } finally {
    root.setAttribute("aria-busy", "false");
  }
}
start();
