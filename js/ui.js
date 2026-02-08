import { computeStreak, dayKey, historyKey, lastActionAt } from "./state.js";

export function bindUI() {
  const el = (id) => document.getElementById(id);

  return {
    mainCard: el("mainCard"),
    historyCard: el("historyCard"),
    netBadge: el("netBadge"),
    btnLogin: el("btnLogin"),
    btnTheme: el("btnTheme"),
    areaButtons: Array.from(document.querySelectorAll(".areaSwitch")),

    mandatoryGoalActionBtn: el("mandatoryGoalActionBtn"),
    mandatoryGoalActionText: el("mandatoryGoalActionText"),
    mandatoryGoalSummaryBtn: el("mandatoryGoalSummaryBtn"),
    mandatoryGoalSummaryText: el("mandatoryGoalSummaryText"),
    mandatoryGoalInfoBtn: el("mandatoryGoalInfoBtn"),
    mandatoryGoalPopover: el("mandatoryGoalPopover"),

    principlesSummaryBtn: el("principlesSummaryBtn"),
    principlesInfoBtn: el("principlesInfoBtn"),
    principlesPopover: el("principlesPopover"),
    principlesModal: el("principlesModal"),
    principlesFields: el("principlesFields"),
    principlesAddBtn: el("principlesAddBtn"),
    principlesSaveBtn: el("principlesSaveBtn"),
    principlesCancelBtn: el("principlesCancelBtn"),
	  
    btnAddGoal: el("btnAddGoal"),
    ttlInfo: el("ttlInfo"),

    goalsList: el("goalsList"),
    modeInfo: el("modeInfo"),

    streakCount: el("streakCount"),
    todayBadge: el("todayBadge"),
    dayChips: el("dayChips"),
    dayProgressControls: el("dayProgressControls"),
    dayJumpBack: el("dayJumpBack"),
    dayJumpToday: el("dayJumpToday"),
    dayJumpForward: el("dayJumpForward"),
    historyDoneCount: el("historyDoneCount"),
    history: el("history"),
    historyPdfBtn: el("historyPdfBtn"),

    toast: el("toast"),
	
	authStatus: el("authStatus"),
    authStatusBtn: el("authStatusBtn"),
    offlineModal: el("offlineModal"),
    offlineMessage: el("offlineMessage"),
    offlineOkBtn: el("offlineOkBtn"),
    commentModal: el("commentModal"),
    commentInput: el("commentInput"),
    commentPartialCheckbox: el("commentPartialCheckbox"),
    commentSaveBtn: el("commentSaveBtn"),
    commentCancelBtn: el("commentCancelBtn"),
    deleteGoalModal: el("deleteGoalModal"),
    deleteGoalText: el("deleteGoalText"),
    deleteGoalConfirmBtn: el("deleteGoalConfirmBtn"),
    deleteGoalCancelBtn: el("deleteGoalCancelBtn"),
    dataChoiceModal: el("dataChoiceModal"),
    dataChoiceCloudBtn: el("dataChoiceCloudBtn"),
    dataChoiceLocalBtn: el("dataChoiceLocalBtn"),
    dataChoiceList: el("dataChoiceList"),

    mandatoryGoalModal: el("mandatoryGoalModal"),
    mandatoryGoalTitleInput: el("mandatoryGoalTitleInput"),
    mandatoryGoalMetricInput: el("mandatoryGoalMetricInput"),
    mandatoryGoalWhyInput: el("mandatoryGoalWhyInput"),
    mandatoryGoalMinStepInput: el("mandatoryGoalMinStepInput"),
    mandatoryGoalTitleError: el("mandatoryGoalTitleError"),
    mandatoryGoalMetricError: el("mandatoryGoalMetricError"),
    mandatoryGoalWhyError: el("mandatoryGoalWhyError"),
    mandatoryGoalMinStepError: el("mandatoryGoalMinStepError"),
    mandatoryGoalSaveBtn: el("mandatoryGoalSaveBtn"),
    mandatoryGoalCancelBtn: el("mandatoryGoalCancelBtn"),

  };
}

export function toast(ui, msg, ms = 2000) {
  ui.toast.textContent = msg;
  ui.toast.hidden = false;
  setTimeout(() => (ui.toast.hidden = true), ms);
}

const CLOUD_ICON = `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M7.5 18a4.5 4.5 0 0 1-.3-9 5.6 5.6 0 0 1 10.6 1.8 3.6 3.6 0 0 1 .2 7.2H7.5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
`;
const CLOUD_CHECK_ICON = `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M7.5 18a4.5 4.5 0 0 1-.3-9 5.6 5.6 0 0 1 10.6 1.8 3.6 3.6 0 0 1 .2 7.2H7.5Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="m9.4 12.7 2.2 2.2 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
`;

export function setOnlineBadge(
  ui,
  {
    isDirty,
    lastSaveOk,
    saveInProgress,
    localSaveOk,
    cloudReady,
    hasUser,
  }
) {
  if (!ui.netBadge) return;

  const badge = ui.netBadge;
  if (saveInProgress) {
    badge.dataset.status = "pending";
    badge.innerHTML = `<span class="netBadgeIcon">${CLOUD_ICON}</span><span class="netBadgeText">Сохраняем…</span>`;
    badge.setAttribute("aria-label", "Сохраняем");
    badge.title = "Сохраняем";
    return;
  }

  const isCloudUnavailable = !cloudReady;
  const localSaved = localSaveOk === true;
  const hasUnsaved = isDirty || localSaveOk === false || (!isCloudUnavailable && lastSaveOk === false);

  if (hasUser && isCloudUnavailable && localSaved && !hasUnsaved) {
    badge.dataset.status = "local";
    badge.innerHTML = `<span class="netBadgeIcon">${CLOUD_CHECK_ICON}</span><span class="netBadgeText">Сохранено локально</span>`;
    badge.setAttribute("aria-label", "Сохранено локально");
    badge.title = "Сохранено локально, облако недоступно";
    return;
  }

  if (hasUnsaved) {
    badge.dataset.status = "pending";
    badge.innerHTML = `<span class="netBadgeIcon">${CLOUD_ICON}</span><span class="netBadgeText">Не сохранено</span>`;
    badge.setAttribute("aria-label", "Не сохранено");
    badge.title = lastSaveOk === false ? "Ошибка сохранения" : "Не сохранено";
    return;
  }

  badge.dataset.status = "synced";
  badge.innerHTML = `<span class="netBadgeIcon">${CLOUD_CHECK_ICON}</span><span class="netBadgeText">Сохранено</span>`;
  badge.setAttribute("aria-label", "Сохранено");
  badge.title = "Сохранено";
}


export function setModeInfo(ui, { mode, user, cloudReady, localSaveOk }) {
  if (user) {
    if (cloudReady) {
      ui.modeInfo.textContent = `Локально + облако (Supabase). Пользователь: ${user.email || user.id}`;
      return;
    }
    const localStatus = localSaveOk === false
      ? "Локальное сохранение недоступно"
      : "Сохраняем локально";
    ui.modeInfo.textContent = `Оффлайн-режим. ${localStatus}. Пользователь: ${user.email || user.id}`;
    return;
  }
  ui.modeInfo.textContent =
    mode === "local"
      ? "Локальное хранилище на этом устройстве."
      : "Войдите, чтобы включить облачную синхронизацию.";
}

export function setAuthStage(ui, { text, showRetry = false, visible = true } = {}) {
  if (!ui.authStatusBtn) return;
  ui.authStatusBtn.textContent = text || "—";
  ui.authStatusBtn.hidden = !visible;
  ui.authStatusBtn.disabled = !showRetry;
  ui.authStatusBtn.dataset.retry = showRetry ? "true" : "false";
}

export function setActiveAreaButtons(ui, activeArea) {
  if (!ui.areaButtons?.length) return;
  ui.areaButtons.forEach((btn) => {
    const isActive = btn.dataset.area === activeArea;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

export function renderDiffList(ui, sections = []) {
  if (!ui.dataChoiceList) return;
  ui.dataChoiceList.innerHTML = "";
  const appendText = (node, text) => {
    node.appendChild(document.createTextNode(text));
  };
  const appendPrefix = (node, text) => {
    const prefixSpan = document.createElement("span");
    prefixSpan.className = "histPrefix";
    prefixSpan.textContent = text;
    node.appendChild(prefixSpan);
  };
  const renderGoalDiff = (li, item) => {
    appendText(li, `${item.title} (`);
    item.diffs.forEach((diff, index) => {
      if (index > 0) appendText(li, ", ");
      if (diff.type === "text") {
        appendText(li, `${diff.label}: "${diff.from}" `);
        appendPrefix(li, "на облаке");
        appendText(li, " → ");
        appendText(li, `"${diff.to}" `);
        appendPrefix(li, "локально");
        return;
      }
      appendText(li, `${diff.label}: ${diff.from} → ${diff.to}`);
    });
    appendText(li, ")");
  };
  if (!sections.length) {
    const empty = document.createElement("div");
    empty.className = "muted small";
    empty.textContent = "Отличий не найдено.";
    ui.dataChoiceList.appendChild(empty);
    return;
  }

  sections.forEach((section) => {
    const wrap = document.createElement("div");
    wrap.className = "diffSection";

    const title = document.createElement("div");
    title.className = "diffTitle";
    title.textContent = section.title || "—";
    wrap.appendChild(title);

    const list = document.createElement("ul");
    list.className = "diffList";
    if (!section.items?.length) {
      const li = document.createElement("li");
      li.className = "muted small";
      li.textContent = "Нет отличий.";
      list.appendChild(li);
    } else {
      section.items.forEach((item) => {
        const li = document.createElement("li");
        if (item?.type === "goal-change") {
          renderGoalDiff(li, item);
        } else {
          const text = String(item);
          const html = text
            .replaceAll(
              "на облаке",
              '<span class="histPrefix">на облаке</span>',
            )
            .replaceAll(
              "в облаке",
              '<span class="histPrefix">в облаке</span>',
            )
            .replaceAll(
              "локально",
              '<span class="histPrefix">локально</span>',
            );
          li.innerHTML = html;
        }
        list.appendChild(li);
      });
    }

    wrap.appendChild(list);
    ui.dataChoiceList.appendChild(wrap);
  });
}

export function showDataChoiceModal(ui) {
  if (!ui.dataChoiceModal) return;
  ui.dataChoiceModal.hidden = false;
  ui.dataChoiceModal.classList.add("show");
  document.body.classList.add("modalOpen");
  document.documentElement.classList.add("modalOpen");
}

export function hideDataChoiceModal(ui) {
  if (!ui.dataChoiceModal) return;
  ui.dataChoiceModal.classList.remove("show");
  ui.dataChoiceModal.hidden = true;
  document.body.classList.remove("modalOpen");
  document.documentElement.classList.remove("modalOpen");
}

export function renderAll(ui, state, { activeDayIndex = null } = {}) {
  renderMeta(ui, state);
  renderMandatoryGoal(ui, state);
  renderPrinciples(ui, state);
  renderGoals(ui, state);
  renderStreak(ui, state, { activeDayIndex });
  renderHistory(ui, state);
  requestAnimationFrame(() => syncHistoryHeight(ui));
}

export function startHistorySizer(ui) {
  if (!ui?.mainCard || !ui?.historyCard) return;
  if (ui.historySizer) return;

  window.addEventListener("load", () => syncHistoryHeight(ui), { once: true });

  if (typeof ResizeObserver === "undefined") {
    window.addEventListener("load", () => syncHistoryHeight(ui));
    syncHistoryHeight(ui);
    return;
  }

  const observer = new ResizeObserver(() => syncHistoryHeight(ui));
  observer.observe(ui.mainCard);
  ui.historySizer = observer;
  syncHistoryHeight(ui);
}

export function syncHistoryHeight(ui) {
  if (!ui?.mainCard || !ui?.historyCard) return;

  if (window.matchMedia("(max-width: 920px)").matches) {
    ui.historyCard.style.height = "";
    ui.historyCard.style.maxHeight = "";
    if (ui.history) {
      ui.history.style.maxHeight = "";
      ui.history.style.height = "";
    }
    return;
  }

  const mainHeight = ui.mainCard.offsetHeight || ui.mainCard.getBoundingClientRect().height;
  if (!mainHeight) {
    requestAnimationFrame(() => syncHistoryHeight(ui));
    return;
  }

  ui.historyCard.style.height = `${mainHeight}px`;
  ui.historyCard.style.maxHeight = `${mainHeight}px`;

  if (ui.history) {
    const cardStyles = window.getComputedStyle(ui.historyCard);
    const paddingBottom = parseFloat(cardStyles.paddingBottom) || 0;
    const cardTop = ui.historyCard.getBoundingClientRect().top;
    const historyTop = ui.history.getBoundingClientRect().top;
    const available = Math.max(0, mainHeight - (historyTop - cardTop) - paddingBottom);
    ui.history.style.maxHeight = `${available}px`;
    ui.history.style.height = `${available}px`;
  }
}


export function renderMeta(ui, state) {
  // "Удаление через 36ч без действий"
  const TTL_HOURS = 36;
  const ttlMs = TTL_HOURS * 60 * 60 * 1000;
  const lastAction = lastActionAt(state);
  const left = (lastAction + ttlMs) - Date.now();

  if (!ui.ttlInfo) return;

  if (left <= 0) {
    ui.ttlInfo.textContent = `Удаление: срок истёк`;
    return;
  }

  const mins = Math.floor(left / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  ui.ttlInfo.textContent = `Удаление через ${h}ч ${m}м без действий`;
}


export function renderMandatoryGoal(ui, state) {
  if (!ui.mandatoryGoalSummaryText) return;
  const goal = state?.mandatoryGoal || {};
  const title = String(goal.title || "").trim();
  const metric = String(goal.metric || "").trim();
  const why = String(goal.why || "").trim();
  const minStep = String(goal.minStep || "").trim();
  const hasGoal = Boolean(title && metric && why);
  const shortTitle = title.length > 48 ? `${title.slice(0, 48).trim()}…` : title;

  ui.mandatoryGoalSummaryText.textContent = hasGoal ? `:\u00A0“${shortTitle}”` : "—";
  if (ui.mandatoryGoalActionBtn) {
    ui.mandatoryGoalActionBtn.textContent = "Моя цель";
    ui.mandatoryGoalActionBtn.hidden = hasGoal;
  }

  if (ui.mandatoryGoalActionText) {
    ui.mandatoryGoalActionText.hidden = true;
    ui.mandatoryGoalActionText.textContent = "";
  }

  if (ui.mandatoryGoalInfoBtn) {
    ui.mandatoryGoalInfoBtn.hidden = !hasGoal;
  }

  if (ui.mandatoryGoalPopover) {
    ui.mandatoryGoalPopover.hidden = true;
    if (!hasGoal) {
      ui.mandatoryGoalPopover.innerHTML = "";
      return;
    }
    const sections = [
      {
        label: "Результат/метрика",
        value: metric,
      },
      {
        label: "Почему это важно",
        value: why,
      },
    ];
    if (minStep) {
      sections.push({
        label: "Минимальный шаг",
        value: minStep,
      });
    }

    ui.mandatoryGoalPopover.innerHTML = `
      <div class="mgTip">
        ${sections
          .map((section) => `
            <div class="mgTipSection">
              <div class="mgTipLabel">${escapeHtml(section.label)}</div>
              <div class="mgTipValue">${escapeHtml(section.value)}</div>
            </div>
          `)
          .join("")}
      </div>
    `;
  }
}

export function renderPrinciples(ui, state) {
  if (!ui.principlesInfoBtn) return;
  const items = Array.isArray(state?.principles?.items) ? state.principles.items : [];
  const hasItems = items.length > 0;

  ui.principlesInfoBtn.hidden = !hasItems;

  if (ui.principlesPopover) {
    ui.principlesPopover.hidden = true;
    if (!hasItems) {
      ui.principlesPopover.innerHTML = "";
      return;
    }
    const list = items.map(item => `<li>${escapeHtml(item)}</li>`).join("");
    ui.principlesPopover.innerHTML = `
      <div class="mgTip">
        <ul class="mgTipList">${list}</ul>
      </div>
    `;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderGoals(ui, state) {
  ui.goalsList.innerHTML = "";
  const hasNoGoals = state.dailyGoals.length === 0;

  if (hasNoGoals) {
    ui.goalsList.classList.add("is-empty");
    const empty = document.createElement("div");
    empty.className = "goalsEmpty";
    empty.textContent = "Пока задач нет";
    ui.goalsList.appendChild(empty);
    return;
  }

  ui.goalsList.classList.remove("is-empty");

  state.dailyGoals.forEach((g, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "goalItem";

    const label = document.createElement("div");
    label.className = "pill mutedPill";
    label.textContent = `Задача №${idx + 1}`;

    const daily = document.createElement("label");
    daily.className = "pill goalAction";
    const dailyCb = document.createElement("input");
    dailyCb.type = "checkbox";
    dailyCb.checked = !!g.isDaily;
    dailyCb.dataset.goalId = g.id;
    dailyCb.dataset.role = "goalDaily";
    dailyCb.style.marginRight = "8px";
    daily.appendChild(dailyCb);
    daily.appendChild(document.createTextNode("Ежедневная"));

    const input = document.createElement("input");
    input.className = "input";
    input.value = g.text || "";
    input.placeholder = "Например: 30 минут ОФП / 1500м плавания / 1 час фокуса";
    input.dataset.goalId = g.id;
    input.dataset.role = "goalText";

    const doneBtn = document.createElement("button");
    doneBtn.className = "pill btn goalDoneBtn goalAction";
    doneBtn.dataset.goalId = g.id;
    doneBtn.dataset.role = "goalDoneAction";
    doneBtn.textContent = "Сделано сегодня";

    const del = document.createElement("button");
    del.className = "btn red goalAction goalDeleteBtn";
    del.textContent = "🗑️";
    del.dataset.goalId = g.id;
    del.dataset.role = "goalDelete";

    const header = document.createElement("div");
    header.className = "goalHeader";
    header.appendChild(label);
    header.appendChild(daily);

    const controls = document.createElement("div");
    controls.className = "goalControls";
    controls.appendChild(doneBtn);
    controls.appendChild(del);

    const row = document.createElement("div");
    row.className = "goalTop";
    row.appendChild(header);
    row.appendChild(controls);

    wrap.appendChild(row);
    wrap.appendChild(input);

    ui.goalsList.appendChild(wrap);
  });
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function startOfLocalDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function parseDayKeyToDate(key) {
  if (!key) return null;
  const [y, m, d] = key.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

export function getDayProgressData(state) {
  const history = Array.isArray(state?.history) ? state.history : [];
  const minTs = history.reduce((min, entry) => Math.min(min, entry?.ts || min), Infinity);
  const fallbackTs = state?.mandatoryGoal?.createdAt || state?.principles?.createdAt || state?.lastOpenAt || Date.now();
  const start = startOfLocalDay(isFinite(minTs) ? new Date(minTs) : new Date(fallbackTs));
  const today = startOfLocalDay(new Date());
  const diff = Math.max(0, Math.floor((today - start) / MS_PER_DAY));
  const totalDays = diff + 1;
  const dayStats = dayStatsFromHistory(history);

  return {
    startDate: start,
    today,
    totalDays,
    dayStats,
  };
}

function getVisibleChipCount() {
  const width = window.innerWidth || 1200;
  if (width <= 520) return 8;
  if (width <= 720) return 10;
  if (width <= 920) return 14;
  return 21;
}

export function getDayChipStep() {
  return Math.max(6, getVisibleChipCount() - 2);
}

function buildDayChipRange(activeDayIndex, totalDays) {
  const maxVisible = Math.max(6, getVisibleChipCount());
  if (totalDays <= maxVisible) {
    return { start: 1, end: totalDays, showStartEllipsis: false, showEndEllipsis: false };
  }
  const half = Math.floor(maxVisible / 2);
  let start = Math.max(1, activeDayIndex - half);
  let end = start + maxVisible - 1;
  if (end > totalDays) {
    end = totalDays;
    start = Math.max(1, end - maxVisible + 1);
  }
  return {
    start,
    end,
    showStartEllipsis: start > 2,
    showEndEllipsis: end < totalDays - 1,
  };
}

function dayStatsFromHistory(history = []) {
  const map = new Map();
  for (const e of history) {
    const key = dayKey(e.ts);
    const stat = map.get(key) || { any: false, done: 0 };
    stat.any = true;
    if (e?.type === "done_goal") stat.done += 1;
    map.set(key, stat);
  }
  return map;
}

export function renderStreak(ui, state, { activeDayIndex = null } = {}) {
  const s = computeStreak(state.history);
  ui.streakCount.textContent = String(s.streak);
  ui.todayBadge.textContent = s.todayCounted ? "Сегодня засчитан ✅" : "Сегодня ещё не засчитан";

  if (!ui.dayChips) return;

  const data = getDayProgressData(state);
  const totalDays = data.totalDays;
  const visibleCount = getVisibleChipCount();
  const showControls = totalDays > visibleCount;
  const step = getDayChipStep();
  const safeActive = Math.min(Math.max(activeDayIndex || totalDays, 1), totalDays);
  ui.dayChips.innerHTML = "";
  ui.dayChips.classList.toggle("is-compact", !showControls);

  const range = buildDayChipRange(safeActive, totalDays);
  const appendEllipsis = () => {
    const ellipsis = document.createElement("span");
    ellipsis.className = "dayChip dayChipEllipsis";
    ellipsis.textContent = "…";
    ellipsis.setAttribute("aria-hidden", "true");
    ui.dayChips.appendChild(ellipsis);
  };
  const appendChip = (index) => {
    const date = new Date(data.startDate);
    date.setDate(date.getDate() + (index - 1));
    const key = dayKey(date.getTime());
    const stat = data.dayStats.get(key);
    const counted = !!stat?.any;
    const doneCount = stat?.done || 0;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "dayChip";
    chip.dataset.dayIndex = String(index);
    chip.dataset.dayKey = key;
    chip.textContent = String(index);
    chip.setAttribute("aria-pressed", index === safeActive ? "true" : "false");
    chip.title = `День ${index}${counted ? " — засчитан" : " — не засчитан"}`;
    if (counted) chip.classList.add("is-counted");
    if (index === safeActive) chip.classList.add("is-active");
    if (doneCount > 0) {
      const badge = document.createElement("span");
      badge.className = "dayChipCount";
      badge.textContent = String(doneCount);
      chip.appendChild(badge);
    }
    ui.dayChips.appendChild(chip);
  };

  if (range.start > 1) {
    appendChip(1);
    if (range.showStartEllipsis) appendEllipsis();
  }

  for (let index = range.start; index <= range.end; index++) {
    appendChip(index);
  }

  if (range.end < totalDays) {
    if (range.showEndEllipsis) appendEllipsis();
    appendChip(totalDays);
  }

  if (ui.dayProgressControls) ui.dayProgressControls.hidden = !showControls;
  if (ui.dayJumpBack) {
    ui.dayJumpBack.disabled = safeActive <= 1;
    ui.dayJumpBack.textContent = `⟵ -${step}`;
  }
  if (ui.dayJumpForward) {
    ui.dayJumpForward.disabled = safeActive >= totalDays;
    ui.dayJumpForward.textContent = `+${step} ⟶`;
  }

  requestAnimationFrame(() => {
    const activeChip = ui.dayChips.querySelector(".dayChip.is-active");
    if (!activeChip) return;
    const container = ui.dayChips;
    const containerCenter = container.clientWidth / 2;
    const targetCenter = activeChip.offsetLeft + activeChip.offsetWidth / 2;
    container.scrollLeft = Math.max(0, targetCenter - containerCenter);
  });
}

export function renderHistory(ui, state) {
  ui.history.innerHTML = "";
  const doneCount = state.history.filter(entry => entry?.type === "done_goal").length;
  if (ui.historyDoneCount) ui.historyDoneCount.textContent = String(doneCount);

  if (!state.history.length) {
    const p = document.createElement("div");
    p.className = "muted small";
    p.textContent = "Пока записей нет. Отмечай задачи кнопкой “Сделано сегодня”.";
    ui.history.appendChild(p);
    return;
  }

  const groups = new Map();
  const todayKey = dayKey(Date.now());
  const addLine = (body, prefix, text) => {
    const line = document.createElement("div");
    line.className = "histLine";
    const prefixSpan = document.createElement("span");
    prefixSpan.className = "histPrefix";
    prefixSpan.textContent = prefix;
    line.appendChild(prefixSpan);
    if (text) {
      const textSpan = document.createElement("span");
      textSpan.className = "histText";
      textSpan.textContent = text;
      line.appendChild(textSpan);
    }
    body.appendChild(line);
  };

  for (const e of state.history) {
    const key = dayKey(e.ts);
    let group = groups.get(key);
    if (!group) {
      group = document.createElement("div");
      group.className = "histDay";
      group.dataset.dayKey = key;
      const dayStart = startOfLocalDay(e.ts);
      group.dataset.dayTs = String(dayStart.getTime());

      const title = document.createElement("div");
      title.className = "histDayTitle";
      title.textContent = new Date(e.ts).toLocaleDateString("ru-RU", {
        day: "numeric",
        month: "long",
        year: "numeric",
      });

      const cards = document.createElement("div");
      cards.className = "histDayCards";

      group.appendChild(title);
      group.appendChild(cards);
      ui.history.appendChild(group);
      groups.set(key, group);
    }

    const card = document.createElement("div");
    card.className = "histCard";
    card.dataset.dayKey = key;
    card.dataset.historyKey = historyKey(e);

    const dt = new Date(e.ts);
    const h = document.createElement("div");
    h.className = "histTitle";
    h.textContent = dt.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

    const body = document.createElement("div");
    body.className = "histBody";

    if (e.type === "delete_goal") {
      const text = e.payload?.text || "";
      addLine(body, "Удалена задача:", `«${text}»`);
    } else if (e.type === "done_goal") {
      const text = e.payload?.text || "";
      const comment = e.payload?.comment || "";
      const isDaily = !!e.payload?.isDaily;
      const statusLabel = (e.payload?.statusLabel || "").trim();
      const label = statusLabel || (isDaily ? "Сделана ежедневная задача" : "Сделана задача");
      addLine(body, `${label}:`, `«${text}»`);
      if (comment) {
        addLine(body, "Комментарий:", comment);
      }
    } else if (e.type === "save") {
      const p = e.payload || {};
      if (p.focusGoal) {
        addLine(body, "Задача:", p.focusGoal);
      }
      if (p.note) {
        addLine(body, "Сделано сегодня:", p.note);
      }
    } else if (e.type === "save_principles") {
      const items = Array.isArray(e.payload?.items) ? e.payload.items : [];
      if (items.length) {
        addLine(body, "Принципы:", items.map(item => `- ${item}`).join("\n"));
      } else {
        addLine(body, "Принципы:", "—");
      }
    } else {
      body.textContent = JSON.stringify(e, null, 2);
    }

    if (key === todayKey) {
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "histDelete";
      deleteBtn.type = "button";
      deleteBtn.dataset.role = "historyDelete";
      deleteBtn.dataset.historyKey = historyKey(e);
      deleteBtn.setAttribute("aria-label", "Удалить запись");
      deleteBtn.title = "Удалить запись";
      deleteBtn.textContent = "✕";
      card.appendChild(deleteBtn);
    }

    card.appendChild(h);
    card.appendChild(body);
    const cardsWrap = group.querySelector(".histDayCards");
    cardsWrap.appendChild(card);
  }
}

export function scrollHistoryToDay(ui, key) {
  if (!ui?.history || !key) return;
  const group = ui.history.querySelector(`.histDay[data-day-key="${key}"]`);
  let target = group?.querySelector(".histDayTitle");

  if (!target) {
    const targetDate = parseDayKeyToDate(key);
    const targetTs = targetDate ? startOfLocalDay(targetDate).getTime() : null;
    const dayGroups = Array.from(ui.history.querySelectorAll(".histDay"));
    if (targetTs !== null && dayGroups.length) {
      const sorted = dayGroups
        .map((item) => ({
          node: item,
          ts: Number(item.dataset.dayTs || 0),
        }))
        .sort((a, b) => a.ts - b.ts);
      const next = sorted.find((item) => item.ts >= targetTs) || sorted[sorted.length - 1];
      target = next?.node?.querySelector(".histDayTitle") || null;
    }
  }

  if (!target) return;
  const containerRect = ui.history.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const offset = targetRect.top - containerRect.top;
  ui.history.scrollTo({
    top: ui.history.scrollTop + offset,
    behavior: "smooth",
  });
}









