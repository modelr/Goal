import { computeProgress, computeStreak, dayKey } from "./state.js";

export function bindUI() {
  const el = (id) => document.getElementById(id);

  return {
    netBadge: el("netBadge"),
    btnLogin: el("btnLogin"),
    btnTheme: el("btnTheme"),
    btnExport: el("btnExport"),
    fileImport: el("fileImport"),

    stakeInput: el("stakeInput"),
    stakeDoneBtn: el("stakeDoneBtn"),
    stakeStatus: el("stakeStatus"),

    btnAddGoal: el("btnAddGoal"),
    ttlInfo: el("ttlInfo"),
    lastVisit: el("lastVisit"),

    goalsList: el("goalsList"),
    todayNote: el("todayNote"),
    btnSave: el("btnSave"),
    btnClearAll: el("btnClearAll"),
    modeInfo: el("modeInfo"),

    progressBar: el("progressBar"),
    progressText: el("progressText"),

    streakCount: el("streakCount"),
    todayBadge: el("todayBadge"),
    calendar: el("calendar"),
    history: el("history"),

    toast: el("toast"),
	
	authModal: el("authModal"),
    authEmail: el("authEmail"),
    sendLinkBtn: el("sendLinkBtn"),
    closeAuthBtn: el("closeAuthBtn"),
    authStatus: el("authStatus"),

  };
}

export function toast(ui, msg, ms = 2000) {
  ui.toast.textContent = msg;
  ui.toast.hidden = false;
  setTimeout(() => (ui.toast.hidden = true), ms);
}

export function setOnlineBadge(ui, online) {
  ui.netBadge.textContent = online ? "Онлайн" : "Офлайн";
}

export function setModeInfo(ui, mode, user) {
  if (mode === "remote" && user) ui.modeInfo.textContent = `Облачный режим (Supabase). Пользователь: ${user.email || user.id}`;
  else ui.modeInfo.textContent = "Офлайн режим (локально).";
}

export function renderAll(ui, state) {
  renderMeta(ui, state);
  renderStake(ui, state);
  renderGoals(ui, state);
  renderTodayNote(ui, state);
  renderProgress(ui, state);
  renderStreak(ui, state);
  renderHistory(ui, state);
}

export function renderMeta(ui, state) {
  // "Последний визит"
  const last = state?.lastOpenAt || state?.lastVisitAt || Date.now();
  const lastStr = new Date(last).toLocaleString("ru-RU");
  if (ui.lastVisit) ui.lastVisit.textContent = `Последний визит: ${lastStr}`;

  // "Удаление через ~48ч без открытия"
  const TTL_HOURS = 48;
  const ttlMs = TTL_HOURS * 60 * 60 * 1000;
  const left = (last + ttlMs) - Date.now();

  if (!ui.ttlInfo) return;

  if (left <= 0) {
    ui.ttlInfo.textContent = `Удаление: срок истёк`;
    return;
  }

  const mins = Math.floor(left / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  ui.ttlInfo.textContent = `Удаление через ~${h}ч ${m}м без открытия`;
}


export function renderStake(ui, state) {
  ui.stakeInput.value = state.stake.text || "";
  ui.stakeStatus.textContent = state.stake.done ? "Статус: Готово ✅" : "Статус: В процессе";
}

export function renderGoals(ui, state) {
  ui.goalsList.innerHTML = "";

  state.dailyGoals.forEach((g, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "goalItem";

    const label = document.createElement("div");
    label.className = "pill mutedPill";
    label.textContent = `Цель #${idx + 1}`;

    const input = document.createElement("input");
    input.className = "input";
    input.value = g.text || "";
    input.placeholder = "Например: 30 минут ОФП / 1500м плавания / 1 час фокуса";
    input.dataset.goalId = g.id;
    input.dataset.role = "goalText";

    const chk = document.createElement("label");
    chk.className = "pill";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!g.doneToday;
    cb.dataset.goalId = g.id;
    cb.dataset.role = "goalDone";
    cb.style.marginRight = "8px";
    chk.appendChild(cb);
    chk.appendChild(document.createTextNode("Сделано сегодня"));

    const del = document.createElement("button");
    del.className = "btn red";
    del.textContent = "🗑";
    del.dataset.goalId = g.id;
    del.dataset.role = "goalDelete";

    const row = document.createElement("div");
    row.className = "row";
    row.appendChild(label);
    row.appendChild(chk);
    row.appendChild(del);

    wrap.appendChild(row);
    wrap.appendChild(input);

    ui.goalsList.appendChild(wrap);
  });
}

export function renderProgress(ui, state) {
  const p = computeProgress(state);
  ui.progressText.textContent = `${p.done}/${p.total} • ${p.pct}%`;
  ui.progressBar.style.width = `${p.pct}%`;
}

export function renderStreak(ui, state) {
  const s = computeStreak(state.history);
  ui.streakCount.textContent = String(s.streak);
  ui.todayBadge.textContent = s.todayCounted ? "Сегодня засчитан ✅" : "Сегодня ещё не засчитан";

  // календарь: последние 28 дней
  ui.calendar.innerHTML = "";
  const days = new Set(state.history.map(h => dayKey(h.ts)));
  const today = new Date();
  // 28 дней, включая сегодня
  for (let i = 27; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = dayKey(d.getTime());

    const cell = document.createElement("div");
    cell.className = "calCell";
    cell.textContent = String(d.getDate());
    // закрашиваем, если есть любая запись в этот день
    if (days.has(key)) cell.classList.add("on");
    ui.calendar.appendChild(cell);
  }
}

export function renderHistory(ui, state) {
  ui.history.innerHTML = "";

  if (!state.history.length) {
    const p = document.createElement("div");
    p.className = "muted small";
    p.textContent = "Пока записей нет. Нажми “Сохранить запись”.";
    ui.history.appendChild(p);
    return;
  }

  for (const e of state.history) {
    const card = document.createElement("div");
    card.className = "histCard";

    const dt = new Date(e.ts);
    const h = document.createElement("div");
    h.className = "histTitle";
    h.textContent = dt.toLocaleString();

    const body = document.createElement("div");
    body.className = "histBody";

    if (e.type === "delete_goal") {
      body.textContent = `Событие: удалена цель\n${e.payload?.text || ""}`.trim();
    } else if (e.type === "save") {
      const p = e.payload || {};
      body.textContent =
        `Ставка: ${p.stake || "—"}\n` +
        `День: выполнено ${p.done}/${p.total}\n` +
        (p.note ? `\n${p.note}` : "");
    } else {
      body.textContent = JSON.stringify(e, null, 2);
    }

    card.appendChild(h);
    card.appendChild(body);
    ui.history.appendChild(card);
  }
}

