import { createSupabaseClient } from "./supabaseClient.js";
import {
  defaultState, normalizeState, addGoal, deleteGoal,
  addHistorySave, markOpened
} from "./state.js";
import { loadInitialState, saveState, clearLocal } from "./storage.js";
import { bindUI, renderAll, toast, setOnlineBadge, setModeInfo } from "./ui.js";
import { APP } from "./config.js";

const ui = bindUI();
const supabase = safeCreateSupabase();
let state = null;
let user = null;
let mode = "local";
let saving = false;

boot().catch(err => hardFail(err));

async function boot() {
  installGuards();

  setOnlineBadge(ui, navigator.onLine);
  window.addEventListener("online", () => setOnlineBadge(ui, true));
  window.addEventListener("offline", () => setOnlineBadge(ui, false));

  // 1) загрузка состояния (local -> (если залогинен) supabase)
  const init = await loadInitialState({ supabase });
  state = normalizeState(init.state);
  user = init.user;
  mode = init.mode;

  setModeInfo(ui, mode, user);
  renderAll(ui, state);

  wireEvents();

  // 2) слушаем изменение auth (логин/логаут)
  if (supabase) {
    supabase.auth.onAuthStateChange(async (_event, session) => {
      user = session?.user || null;
      const init2 = await loadInitialState({ supabase });
      state = normalizeState(init2.state);
      mode = init2.mode;
      setModeInfo(ui, mode, user);
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
    state = markOpened(state);
    renderAll(ui, state);
    scheduleSave();
  });

  ui.stakeDoneBtn.addEventListener("click", () => {
    state.stake.done = !state.stake.done;
    if (!state.stake.createdAt) state.stake.createdAt = Date.now();
    if (state.stake.done) state.stake.doneAt = Date.now();
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

  ui.btnClearAll.addEventListener("click", async () => {
    if (!confirm("Удалить всё?")) return;
    clearLocal();
    state = defaultState();
    renderAll(ui, state);
    await persist();
    toast(ui, "Очищено");
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
    await persist();
    toast(ui, "Импортировано и сохранено");
    e.target.value = "";
  });

  ui.btnLogin.addEventListener("click", () => {
    if (!supabase) return toast(ui, "Supabase не настроен (URL/KEY)");
    if (!ui.authModal) return toast(ui, "Нет модалки authModal в index.html");

    ui.authModal.hidden = false;
    ui.authModal.classList.add("show");
    ui.authEmail.value = "";
    ui.authEmail.focus();
    if (ui.authStatus) ui.authStatus.textContent = "—";

  });

    // auth modal: close button
  if (ui.closeAuthBtn && ui.authModal) {
    ui.closeAuthBtn.addEventListener("click", () => {
      ui.authModal.classList.remove("show");
      ui.authModal.hidden = true;
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


  ui.btnTheme.addEventListener("click", () => {
    document.documentElement.classList.toggle("light");
  });
}

function doSaveEntry() {
  state.todayNote = ui.todayNote.value;
  state = addHistorySave(state);
  state = markOpened(state);
  renderAll(ui, state);
  persist().then(() => toast(ui, "Сохранено"));
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persist(), 350);
}

async function persist() {
  if (saving) return;
  saving = true;
  const res = await saveState({ supabase, userId: user?.id || null, state });
  mode = res.mode === "remote" ? "remote" : mode; // не откатываем UI лишний раз
  setModeInfo(ui, user ? "remote" : "local", user);
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

function hardFail(err) {
  console.error(err);
  alert("BOOT FAIL: " + (err?.message || String(err)));
}
