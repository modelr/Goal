import { createSupabaseClient } from "./supabaseClient.js";
import {
  defaultState, normalizeState, addGoal, deleteGoal,
  addHistorySave, markOpened
} from "./state.js";
import { loadInitialState, saveState } from "./storage.js";
import { bindUI, renderAll, startHistorySizer, syncHistoryHeight, toast, setOnlineBadge, setModeInfo } from "./ui.js";
import { APP } from "./config.js";

const ui = bindUI();
const supabase = safeCreateSupabase();
let state = null;
let user = null;
let mode = "local";
let saving = false;
let hasPendingSync = false;
let offlineModalShown = false;
let saveModalConfirmHandler = null;
const THEME_KEY = "goal-theme";

boot().catch(err => hardFail(err));

async function boot() {
  installGuards();
  applyTheme(loadTheme());

  updateNetBadge();
  window.addEventListener("online", () => updateNetBadge());
  window.addEventListener("offline", () => updateNetBadge());
  // 1) загрузка состояния (local -> (если залогинен) supabase)
  const init = await loadInitialState({ supabase });
  state = normalizeState(init.state);
  user = init.user;
  if (ui.btnLogin) ui.btnLogin.textContent = user ? "🚪 Выйти" : "🔐 Войти";
  mode = init.mode;
  hasPendingSync = false;

  setModeInfo(ui, mode, user);
  updateNetBadge();
  renderAll(ui, state);
  startHistorySizer(ui);
  window.addEventListener("resize", () => syncHistoryHeight(ui));

  wireEvents();

  // 2) слушаем изменение auth (логин/логаут)
  if (supabase) {
    supabase.auth.onAuthStateChange(async (_event, session) => {
      user = session?.user || null;
	  if (ui.btnLogin) ui.btnLogin.textContent = user ? "🚪 Выйти" : "🔐 Войти";
      const init2 = await loadInitialState({ supabase });
      state = normalizeState(init2.state);
      mode = init2.mode;
      hasPendingSync = false;
      offlineModalShown = false;
      setModeInfo(ui, mode, user);
      updateNetBadge();
      renderAll(ui, state);
      toast(ui, user ? "Вошли, данные синхронизированы" : "Вышли, офлайн-режим");
    });
  }

  debug(`BOOT: renderAll OK`, {
    goalsListChildren: ui.goalsList.children.length,
    calendarChildren: ui.calendar.children.length
  });
}

function wireEvents() {
  // stake
  ui.stakeInput.addEventListener("input", () => {
    state.stake.text = ui.stakeInput.value;
    if (!state.stake.createdAt) state.stake.createdAt = Date.now();
    state = markOpened(state);
    renderAll(ui, state);
    scheduleSave();
  });

  ui.stakeDoneBtn.addEventListener("click", () => {
    state.stake.done = !state.stake.done;
    if (!state.stake.createdAt) state.stake.createdAt = Date.now();
    state.stake.doneAt = state.stake.done ? Date.now() : null;
    state = markOpened(state);
    renderAll(ui, state);
    scheduleSave();
  });

  // goals list delegation
  ui.goalsList.addEventListener("input", (e) => {
    const t = e.target;
    if (t?.dataset?.role !== "goalText") return;
    const id = t.dataset.goalId;
    const g = state.dailyGoals.find(x => x.id === id);
    if (!g) return;
    g.text = t.value;
    state = markOpened(state);
    scheduleSave();
  });

  ui.goalsList.addEventListener("change", (e) => {
    const t = e.target;
    if (t?.dataset?.role !== "goalDone") return;
    const id = t.dataset.goalId;
    const g = state.dailyGoals.find(x => x.id === id);
    if (!g) return;
    g.doneToday = t.checked;
    state = markOpened(state);
    renderAll(ui, state);
    scheduleSave();
  });

  ui.goalsList.addEventListener("click", (e) => {
    const t = e.target;
    if (t?.dataset?.role !== "goalDelete") return;
    state = deleteGoal(state, t.dataset.goalId);
    state = markOpened(state);
    renderAll(ui, state);
    scheduleSave();
  });

  ui.btnAddGoal.addEventListener("click", () => {
    state = addGoal(state);
    state = markOpened(state);
    renderAll(ui, state);
    scheduleSave();
  });

  ui.todayNote.addEventListener("input", () => {
    state.todayNote = ui.todayNote.value;
    state = markOpened(state);
    scheduleSave();
  });

  ui.btnSave.addEventListener("click", () => doSaveEntry());
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "Enter") doSaveEntry();
  });

    ui.btnExport.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "goal-export.json";
    a.click();
    URL.revokeObjectURL(url);
  });

  ui.fileImport.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    state = normalizeState(JSON.parse(text));
    renderAll(ui, state);
    markPendingSync();
    await persist();
    toast(ui, "Импортировано и сохранено");
    e.target.value = "";
  });

  ui.btnLogin.addEventListener("click", async () => {
  if (!supabase) return toast(ui, "Supabase не настроен (URL/KEY)");

  // Если уже залогинен — делаем "Выйти"
  const { data } = await supabase.auth.getUser();
  if (data?.user) {
    await supabase.auth.signOut();
    return;
  }

  // Чистим URL от старых #error...
  history.replaceState(null, "", window.location.origin + window.location.pathname);

  const redirectTo = window.location.origin + window.location.pathname;

  const { error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo },
  });

  if (error) toast(ui, "Ошибка входа: " + (error.message || String(error)));
});


    // auth modal: close button
  if (ui.closeAuthBtn && ui.authModal) {
    ui.closeAuthBtn.addEventListener("click", () => {
      ui.authModal.classList.remove("show");
      ui.authModal.hidden = true;
    });
  }

  if (ui.offlineOkBtn && ui.offlineModal) {
    ui.offlineOkBtn.addEventListener("click", () => {
      ui.offlineModal.classList.remove("show");
      ui.offlineModal.hidden = true;
    });
  }

  if (ui.saveConfirmBtn && ui.saveModal) {
    ui.saveConfirmBtn.addEventListener("click", () => {
      if (saveModalConfirmHandler) {
        const handler = saveModalConfirmHandler;
        saveModalConfirmHandler = null;
        handler();
      }
      closeSaveModal();
    });
  }

  if (ui.saveCancelBtn && ui.saveModal) {
    ui.saveCancelBtn.addEventListener("click", () => {
      saveModalConfirmHandler = null;
      closeSaveModal();
    });
  }

  // auth modal: send magic link
  if (ui.sendLinkBtn && ui.authEmail) {
    ui.sendLinkBtn.addEventListener("click", async () => {
      if (!supabase) return;

      const email = (ui.authEmail.value || "").trim();
      if (!email) {
        if (ui.authStatus) ui.authStatus.textContent = "Введите email";
        ui.authEmail.focus();
        return;
      }

      if (ui.authStatus) ui.authStatus.textContent = "Отправляю ссылку…";

	  history.replaceState(null, "", window.location.origin + window.location.pathname);

      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: window.location.origin + window.location.pathname }
      });

      if (error) {
        if (ui.authStatus) ui.authStatus.textContent = "Ошибка: " + (error.message || String(error));
        return;
      }

      if (ui.authStatus) ui.authStatus.textContent = "Ссылка отправлена. Проверь почту.";
    });
  }

  // click on backdrop closes modal

  if (ui.authModal) {
  ui.authModal.addEventListener("click", (e) => {
    if (e.target === ui.authModal) {
      ui.authModal.classList.remove("show");
      ui.authModal.hidden = true;
    }
  });
}

  if (ui.offlineModal) {
    ui.offlineModal.addEventListener("click", (e) => {
      if (e.target === ui.offlineModal) {
        ui.offlineModal.classList.remove("show");
        ui.offlineModal.hidden = true;
      }
    });
  }
  if (ui.saveModal) {
    ui.saveModal.addEventListener("click", (e) => {
      if (e.target === ui.saveModal) {
        saveModalConfirmHandler = null;
        closeSaveModal();
      }
    });
  }
 ui.btnTheme.addEventListener("click", () => {
    const nextTheme = document.documentElement.getAttribute("data-theme") === "light"
      ? "dark"
      : "light";
    saveTheme(nextTheme);
    applyTheme(nextTheme);
  });
}

function doSaveEntry() {
  const note = ui.todayNote.value.trim();
  if (!note) {
    openSaveModal({
      title: "Нужна отметка",
      message: "Введите то, что сделали за сегодня в направлении к вашей долгосрочной цели.",
      showTasks: false,
      confirmLabel: "Ок",
      showCancel: false,
      onConfirm: null,
    });
    return;
  }

  const activeGoals = getActiveGoals(state);
  openSaveModal({
    title: "Сохранить запись",
    message: "Выберите задачу по которой работали Сегодня.",
    showTasks: true,
    tasks: activeGoals,
    confirmLabel: "Сохранить запись",
    showCancel: true,
    onConfirm: () => {
      const selectedGoal = getSelectedGoalText();
      finalizeSaveEntry({ focusGoal: selectedGoal });
    },
  });
}

function finalizeSaveEntry({ focusGoal }) {
  state.todayNote = ui.todayNote.value.trim();
  state = addHistorySave(state, { focusGoal });
  state.todayNote = "";
  state = markOpened(state);
  renderAll(ui, state);
  markPendingSync();
  persist().then(() => toast(ui, "Сохранено"));
}

function getActiveGoals(s) {
  return (s?.dailyGoals || [])
    .map(g => ({ id: g.id, text: String(g.text || "").trim() }))
    .filter(g => g.text);
}

function getSelectedGoalText() {
  if (!ui.saveTaskList) return "";
  const select = ui.saveTaskList.querySelector("select[name='saveGoal']");
  return select?.value || "";
}

function openSaveModal({
  title,
  message,
  showTasks,
  tasks = [],
  confirmLabel = "Ок",
  showCancel = true,
  onConfirm,
}) {
  if (!ui.saveModal) return;
  if (ui.saveTitle) ui.saveTitle.textContent = title;
  if (ui.saveMessage) ui.saveMessage.textContent = message;
  if (ui.saveConfirmBtn) ui.saveConfirmBtn.textContent = confirmLabel;
  if (ui.saveCancelBtn) ui.saveCancelBtn.hidden = !showCancel;

  renderSaveTasks(tasks, showTasks);

  saveModalConfirmHandler = onConfirm;
  ui.saveModal.hidden = false;
  ui.saveModal.classList.add("show");
}

function closeSaveModal() {
  if (!ui.saveModal) return;
  ui.saveModal.classList.remove("show");
  ui.saveModal.hidden = true;
}

function renderSaveTasks(tasks, showTasks) {
  if (!ui.saveTaskList) return;
  ui.saveTaskList.innerHTML = "";
  ui.saveTaskList.hidden = !showTasks;
  if (!showTasks) return;

  if (!tasks.length) {
    const empty = document.createElement("div");
    empty.className = "muted small";
    empty.textContent = "Активных задач нет.";
    ui.saveTaskList.appendChild(empty);
    return;
  }

  const select = document.createElement("select");
  select.name = "saveGoal";
  select.className = "modalSelect";
  select.setAttribute("aria-label", "Выбор задачи");

  tasks.forEach((task, index) => {
    const option = document.createElement("option");
    option.value = task.text;
    option.textContent = task.text;
    option.dataset.goalId = task.id;
    if (index === 0) option.selected = true;
    select.appendChild(option);
  });

  ui.saveTaskList.appendChild(select);
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  markPendingSync();
  saveTimer = setTimeout(() => persist(), 350);
}

async function persist() {
  if (saving) return;
  saving = true;
  const res = await saveState({ supabase, userId: user?.id || null, state });
  mode = res.mode === "remote" ? "remote" : mode; // не откатываем UI лишний раз
  setModeInfo(ui, user ? "remote" : "local", user);
  if (res.ok && user) hasPendingSync = false;
  if (!res.ok && user) {
    hasPendingSync = true;
    showOfflineNotice("Мы оффлайн, данные не сохранятся.");
  }
  updateNetBadge();
  saving = false;
  return res;
}

function safeCreateSupabase() {
  try { return createSupabaseClient(); }
  catch (e) {
    debug("Supabase init skipped: " + e.message);
    return null;
  }
}

function installGuards() {
  window.addEventListener("unhandledrejection", (e) => {
    console.warn("[unhandledrejection]", e.reason);
    // AbortError не пугаем алертом — просто лог
    if (e.reason?.name === "AbortError") return;
  });
  window.onerror = (m, src, line, col) => {
    console.error("[onerror]", m, src, line, col);
  };
}

function debug(msg, obj) {
  if (!APP.DEBUG) return;
  console.log(msg, obj || "");
  // маленький тост внизу слева — как у тебя
  ui.toast.hidden = false;
  ui.toast.textContent = `${new Date().toLocaleTimeString()} ${msg}\n${obj ? JSON.stringify(obj) : ""}`;
  setTimeout(() => (ui.toast.hidden = true), 2500);
}

function markPendingSync() {
  if (!user) return;
  hasPendingSync = true;
  updateNetBadge();
}

function updateNetBadge() {
  setOnlineBadge(ui, {
    isOnline: navigator.onLine,
    user,
    hasPendingSync
  });
}

function showOfflineNotice(message) {
  if (!ui.offlineModal || offlineModalShown) return;
  if (ui.offlineMessage) ui.offlineMessage.textContent = message;
  ui.offlineModal.hidden = false;
  ui.offlineModal.classList.add("show");
  offlineModalShown = true;
}

function hardFail(err) {
  console.error(err);
  alert("BOOT FAIL: " + (err?.message || String(err)));
}

function applyTheme(theme) {
  if (theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

function loadTheme() {
  try { return localStorage.getItem(THEME_KEY) || "dark"; }
  catch { return "dark"; }
}

function saveTheme(theme) {
  try { localStorage.setItem(THEME_KEY, theme); } catch {}
}



