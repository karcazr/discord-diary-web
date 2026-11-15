"use strict";

const root = document.querySelector("#root");
const account = document.querySelector("#account");
const toast = document.querySelector("#toast");
const format = new Intl.NumberFormat("ko-KR");
const reactionEmojis = ["❤️", "👏", "🔥", "👍", "🎉", "💯"];
const number = value => format.format(value);
const date = value => value ? value.replaceAll("-", ".") : "—";
const zone = value => value === "America/Toronto" ? "토론토" : "한국";
const escape = value => String(value ?? "").replace(/[&<>"']/g, ch => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[ch]);
let session;
let dashboard;
let tab = "diary";
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

function showLogin(message = "", server = "") {
  const login = document.querySelector("#login");
  login.replaceChildren();
  if (server) {
    const link = document.createElement("a");
    link.className = "button";
    link.href = server;
    link.textContent = "Discord로 시작하기 ↗";
    login.append(link);
  }
  if (message) {
    const detail = document.createElement("p");
    detail.className = "notice";
    detail.textContent = message;
    login.append(detail);
  }
}

function metric(title, value) {
  return `<div class="metric"><span class="subtle">${title}</span><strong>${value}</strong></div>`;
}

function diaryPanel() {
  const post = editing ?? dashboard.mine;
  const previous = post && post.day !== dashboard.today;
  const recent = dashboard.week.map(row => `<li class="between"><strong>${date(row.day)}</strong>
      <span class="meta">${number(row.gold)} + ${number(row.reaction_gold)} (공감 ${number(row.reactions)}회) = <b>${number(row.total)} G</b></span></li>`).join("");
  const alerts = dashboard.notices.map(notice => `<li><b>${date(notice.day)}</b> 일기를 빠뜨려 방패 1개가 차감됐어요.${notice.title ? ` <span class="meta">최근 글 · ${escape(notice.title)}</span>` : ""}</li>`).join("");
  return `<div class="layout">
    <section class="panel">
      <div class="between"><h2>${previous ? date(post.day) + " 일기 수정" : "오늘의 일기"}</h2><span class="badge">${dashboard.profile.today ? "출석 완료" : "출석 전"}</span></div>
      <form id="diary-form">
        <label for="title">제목</label><input id="title" name="title" maxlength="100" required value="${escape(post?.title)}" placeholder="오늘을 한 줄로 적어보세요">
        <label for="body">본문</label><textarea id="body" name="body" maxlength="40000" required placeholder="오늘은 어떤 하루였나요?">
${escape(post?.body)}</textarea>
        <label class="checkbox"><input type="checkbox" name="shared" ${post?.shared ? "checked" : ""}> 출석 기준을 충족하면 다른 회원에게 공유</label>
        <div class="between"><p class="meta" id="count"></p><div class="actions">
          ${previous ? '<button class="quiet" type="button" data-action="today">오늘 일기 열기</button>' : ""}
          <button type="submit">${post ? "수정 저장" : "일기 저장"}</button></div></div>
      </form>
    </section>
    <div class="stack">
      <section class="panel"><h2>최근 7일</h2><p class="subtle">일기 골드 + 공감 골드</p><ul class="rows">${recent}</ul></section>
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
      <div class="between"><span class="meta">${number(post.length)}자 · ${number(post.gold)} G ${post.eligible ? "" : "· 출석 미인정"}</span>
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
    <li><div class="between"><div><b>🛡️ 방패</b><p class="subtle">2,000 G · 상점 구매 후 최대 2개 보유</p></div>
      <div class="actions"><button data-action="buy" data-item="방패" data-quantity="1" ${state.shields >= 2 || state.gold < 2000 ? "disabled" : ""}>1개 구매</button>
      <button data-action="buy" data-item="방패" data-quantity="2" ${state.shields !== 0 || state.gold < 4000 ? "disabled" : ""}>2개 구매</button></div></div></li>
    <li><div class="between"><div><b>🔥 연속기록복구</b><p class="subtle">10,000 G · 현재 기록을 내 최고 기록으로 복구</p></div>
      <button data-action="buy" data-item="연속기록복구" data-quantity="1" ${state.streak >= state.best || state.gold < 10000 ? "disabled" : ""}>기록 복구</button></div></li></ul>
    <p class="subtle">마감까지 일기를 안 쓰면 방패가 하루에 1개 자동 사용돼요. 방패가 없으면 연속 기록이 초기화돼요.</p></section>
    <section class="panel"><h2>최근 골드 내역</h2><ul class="rows">${rows || '<li class="subtle">골드 내역이 없어요.</li>'}</ul></section></div>`;
}

function profilePanel() {
  const state = dashboard.profile;
  const lists = Object.entries({ streak: "연속 기록", gold: "골드", total: "누적 일기" }).map(([key, title]) =>
    `<h3>${title}</h3><ol class="rows">${dashboard.ranking[key].map((member, index) =>
      `<li class="between"><span>${index + 1}. ${escape(member.name)}</span><b>${number(member.value)}</b></li>`).join("") || "<li>집계된 회원이 없어요.</li>"}</ol>`).join("");
  return `<div class="layout"><section class="panel"><h2>내 프로필</h2><ul class="rows">
    <li>현재 연속 기록 <b>${number(state.streak)}일</b> · 최고 <b>${number(state.best)}일</b></li>
    <li>방패 <b>${state.shields ? `🛡️ × ${number(state.shields)}` : "방패가 없습니다"} </b> · 사용 ${number(state.used)}개</li>
    <li>누적 일기 <b>${number(state.total)}개</b> · <b>${number(state.characters)}자</b></li>
    <li>룰렛 티켓 <b>${number(state.tickets)}개</b> · 마일스톤 <b>${number(state.milestones)}개</b></li>
    <li>보상받은 공감 <b>${number(state.reactions)}회</b> · 다음 공감 보상 ${state.reaction_rate} G${state.reaction_tickets ? " + 티켓 1개" : ""}</li>
    ${state.next_reaction ? `<li>다음 공감 목표 <b>${number(state.next_reaction)}회</b></li>` : ""}
    <li>마지막 출석 <b>${date(state.last)}</b></li>
    </ul></section><section class="panel"><h2>커뮤니티 순위</h2>${lists}</section></div>`;
}

function settingsPanel() {
  const current = dashboard.pending?.zone ?? dashboard.zone;
  return `<section class="panel"><h2>일기장 설정</h2><form id="settings-form">
    <label for="zone">일기 집계 시간대</label>
    <select id="zone" name="zone">
      <option value="Asia/Seoul" ${current === "Asia/Seoul" ? "selected" : ""}>한국</option>
      <option value="America/Toronto" ${current === "America/Toronto" ? "selected" : ""}>토론토</option>
    </select>
    <label class="checkbox"><input type="checkbox" name="community" ${dashboard.community ? "checked" : ""}> 내 이름과 기록을 순위 및 마일스톤에 공개</label>
    <p class="subtle">공개를 선택하면 다른 회원이 내 연속 기록, 누적 일기 수, 골드 순위와 마일스톤을 볼 수 있어요.</p>
    <p><button type="submit">설정 저장</button></p>
    </form></section>`;
}

function render() {
  const state = dashboard.profile;
  const tabs = { diary: "내 일기", community: "공유 일기", shop: "상점", profile: "프로필", settings: "설정" };
  const panels = { diary: diaryPanel, community: communityPanel, shop: shopPanel, profile: profilePanel, settings: settingsPanel };
  root.className = "app";
  root.innerHTML = `<div class="heading"><div><p class="label">나의 일기장</p><h1>${escape(session.user.name)}님의 기록</h1></div>
    <div class="meta">${date(dashboard.today)} · ${zone(dashboard.zone)} 오전 4시 마감</div></div>
    <div class="metrics">${metric("연속 학습", number(state.streak) + "일")}${metric("누적 일기", number(state.total) + "개")}
    ${metric("골드", number(state.gold) + " G")}${metric("방패", number(state.shields) + "개")}</div>
    <nav class="tabs" aria-label="일기장 메뉴">${Object.entries(tabs).map(([id, label]) =>
      `<button type="button" class="tab" aria-current="${id === tab ? "page" : "false"}" data-action="tab" data-tab="${id}">${label}</button>`).join("")}</nav>
    ${dashboard.pending ? `<p class="notice">${zone(dashboard.pending.zone)} 시간대 전환 예정</p>` : ""}
    ${panels[tab]()}`;
  updateCount();
}

function updateCount() {
  const input = document.querySelector("#body");
  if (!input) return;
  const count = Array.from(input.value).filter(ch => !/[\p{White_Space}\p{Cf}\p{Cc}\p{Cs}]/u.test(ch)).length;
  document.querySelector("#count").textContent = `공백 제외 ${number(count)}자 · ${count >= 100 ? "출석 기준 충족" : `${100 - count}자 더 쓰면 출석`}`;
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
  const original = editing ?? dashboard.mine;
  return form && (form.elements.title.value !== (original?.title ?? "") ||
    form.elements.body.value !== (original?.body ?? "") || form.elements.shared.checked !== Boolean(original?.shared));
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
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const { action, id, emoji, item, quantity } = button.dataset;
  if (action === "tab" || action === "edit" || action === "today") {
    if (action === "tab" && tab === button.dataset.tab) return;
    if (hasUnsavedDiary() && !confirm("저장하지 않은 일기를 닫을까요?")) return;
    editing = action === "edit" ? dashboard.posts.find(post => post.id === Number(id)) : null;
    tab = action === "tab" ? button.dataset.tab : "diary";
    render();
    root.querySelector(`[data-tab="${tab}"]`)?.focus();
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
  const button = event.target.closest("#logout");
  if (!button || (hasUnsavedDiary() && !confirm("저장하지 않은 일기를 닫고 로그아웃할까요?"))) return;
  submitting(button, async () => {
    await api("logout", {});
    location.reload();
  });
});

async function start() {
  try {
    if (location.hostname.endsWith(".github.io")) {
      const configured = /^https:\/\/[^/?#]+$/.test(window.DIARY_SERVER_ORIGIN) ? window.DIARY_SERVER_ORIGIN : "";
      showLogin(configured ? "" : "Discord 로그인은 서비스 연결 후 사용할 수 있어요.", configured && configured + "/auth/discord");
      return;
    }
    session = await api("session");
    if (!session.user) {
      const message = new URLSearchParams(location.search).get("auth_error");
      showLogin(message || (session.ready ? "" : "Discord 로그인 설정이 필요해요."), session.ready ? "/auth/discord" : "");
      if (message) history.replaceState(null, "", location.pathname);
      return;
    }
    account.innerHTML = `<div class="account"><span>${escape(session.user.name)}</span><button id="logout" class="quiet" type="button">로그아웃</button></div>`;
    await load();
  } catch (error) {
    showLogin(error.message);
  } finally {
    root.setAttribute("aria-busy", "false");
  }
}
start();
