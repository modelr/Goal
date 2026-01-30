import { createSupabaseClient } from "./supabaseClient.js";
import {
  defaultState, normalizeState, addGoal, deleteGoal,
  addHistorySave, markOpened, completeGoal,
  computeStreak, lastActionAt
} from "./state.js";
import {
  getDeviceId,
  loadGuestState,
  loadRemoteState,
  loadUserStateLocal,
  saveGuestState,
  saveRemoteState,
  saveUserStateLocal,
  backupState
} from "./storage.js";
import {
  bindUI,
  renderAll,
  startHistorySizer,
  syncHistoryHeight,
  toast,
  setOnlineBadge,
  setModeInfo,
  scrollHistoryToDay,
  setAuthStage,
  showDataChoiceModal,
  hideDataChoiceModal,
  renderDiffList
} from "./ui.js";
import { APP } from "./config.js";

const ui = bindUI();
const supabase = safeCreateSupabase();
let state = null;
let user = null;
let mode = "guest";
let saving = false;
let cloudReady = false;
let isDirty = false;
let lastSaveOk = null;
let saveInProgress = false;
let offlineModalShown = false;
let saveModalConfirmHandler = null;
let commentModalGoalId = null;
let dataChoiceResolve = null;
const THEME_KEY = "goal-theme";
const AUTH_TIMEOUT_MS = 9000;
const AUTH_STATUS_HIDE_DELAY_MS = 2200;
const SYNC_TOAST_THROTTLE_MS = 8000;
let authListenerAttached = false;
let authFlowInProgress = false;
let dataChoicePending = false;
let authStageTimer = null;
let authInitTimedOut = false;
let lastSyncToastAt = 0;
const deviceId = getDeviceId();

boot().catch(err => hardFail(err));

async function boot() {
  installGuards();
  applyTheme(loadTheme());
  setLoginLoading(false);

  wireEvents();

  await runAuthInit({ reason: "boot" });

  updateNetBadge();

  startHistorySizer(ui);
  window.addEventListener("resize", () => syncHistoryHeight(ui));

  if (supabase && !authListenerAttached) {
    authListenerAttached = true;
    supabase.auth.onAuthStateChange(async (_event, session) => {
      user = session?.user || null;
      setLoginLoading(false);
      syncLoginButtonLabel();
      await runAuthInit({ reason: "auth-change" });
      toast(ui, user ? "Вошли, данные синхронизированы" : "Вышли, гостевой режим");
    });
  }

  debug(`BOOT: renderAll OK`, {
    goalsListChildren: ui.goalsList.children.length,
    calendarChildren: ui.calendar.children.length
  });
}

async function handleAuthRedirect() {
  if (!supabase) return false;
  const hash = window.location.hash?.replace(/^#/, "");
  if (!hash) return false;
  const params = new URLSearchParams(hash);
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  if (!accessToken || !refreshToken) return false;

  logAuthStage("Обрабатываем вход (redirect)…");
  setAuthStage(ui, { text: "Обрабатываем вход (redirect)…", visible: true });
  startAuthTimeout();
  const { error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });

  if (error) {
    toast(ui, "Ошибка входа: " + (error.message || String(error)));
  }

  history.replaceState(null, "", window.location.origin + window.location.pathname);
  clearAuthTimeout();
  return true;
}

async function runAuthInit({ force = false, reason = "" } = {}) {
  if (authFlowInProgress && !force) return;
  if (force) resetAuthInitState();
  authFlowInProgress = true;
  authInitTimedOut = false;
  cloudReady = false;
  lastSaveOk = null;
  saveInProgress = false;
  isDirty = false;
  dataChoicePending = false;
  hideDataChoiceModal(ui);
  logAuthStage(`Запуск загрузки (${reason})`);

  setAuthStage(ui, { text: "Проверяем сессию…", visible: true, showRetry: false });
  updateNetBadge();
  startAuthTimeout();

  try {
    await handleAuthRedirect();
    const sessionUser = await getUserSafe();
    user = sessionUser;
    syncLoginButtonLabel();
    clearAuthTimeout();

    setAuthStage(ui, { text: "Загружаем данные…", visible: true, showRetry: false });

    const guestRaw = loadGuestState(deviceId);
    const guestState = guestRaw ? normalizeState(guestRaw) : null;

    let cloudState = null;
    let userLocalState = null;
    if (user) {
      const remote = await loadRemoteState(supabase, user.id);
      cloudState = remote?.state ? normalizeState(remote.state) : null;
      const localRaw = loadUserStateLocal(user.id);
      userLocalState = localRaw ? normalizeState(localRaw) : null;
    }

    const effectiveCloud = cloudState || userLocalState;
    const guestHas = hasMeaningfulState(guestState);
    const cloudHas = hasMeaningfulState(effectiveCloud);

    if (user && guestHas && cloudHas && !statesEqual(guestState, effectiveCloud)) {
      dataChoicePending = true;
      const diffSections = buildDiffSummary(guestState, effectiveCloud);
      renderDiffList(ui, diffSections);
      showDataChoiceModal(ui);

      state = markOpened(normalizeState(guestState));
      mode = "remote";
      setModeInfo(ui, mode, user);
      updateNetBadge();
      renderAll(ui, state);
      scrollToTop();

      const choice = await waitForDataChoice();
      hideDataChoiceModal(ui);
      dataChoicePending = false;

      if (choice === "cloud") {
        if (guestState) {
          backupState("guest", guestState);
        }
        state = markOpened(normalizeState(effectiveCloud));
        const updatedGuest = {
          ...state,
          lastConflictResolvedAt: Date.now(),
          lastConflictChoice: "cloud",
        };
        saveGuestState(deviceId, updatedGuest, { skipGuard: true });
        saveUserStateLocal(user.id, state, { skipGuard: true });
        if (!cloudState) {
          const res = await saveRemoteState(supabase, user.id, state, { skipGuard: true });
          isDirty = !res.ok;
          lastSaveOk = res.ok;
          if (!res.ok) showOfflineNotice("Мы оффлайн, данные не сохранятся.");
        } else {
          isDirty = false;
          lastSaveOk = true;
        }
        toast(ui, "Оставляем облачные данные");
      } else if (choice === "local") {
        if (effectiveCloud) {
          backupState("cloud", effectiveCloud);
        }
        state = markOpened(normalizeState(guestState));
        const updatedLocal = {
          ...state,
          lastConflictResolvedAt: Date.now(),
          lastConflictChoice: "local",
        };
        saveGuestState(deviceId, updatedLocal, { skipGuard: true });
        saveUserStateLocal(user.id, state, { skipGuard: true });
        const res = await saveRemoteState(supabase, user.id, state, { skipGuard: true });
        isDirty = !res.ok;
        lastSaveOk = res.ok;
        if (!res.ok) showOfflineNotice("Мы оффлайн, данные не сохранятся.");
        toast(ui, "Оставляем локальные данные");
      }
    } else {
      const finalState = cloudHas
        ? effectiveCloud
        : guestHas
          ? guestState
          : defaultState();
      state = markOpened(normalizeState(finalState));
      mode = user ? "remote" : "guest";
      isDirty = false;
      lastSaveOk = true;
    }

    cloudReady = !!user;
    offlineModalShown = false;
    setModeInfo(ui, mode, user);
    updateNetBadge();
    renderAll(ui, state);
    scrollToTop();

    if (user) {
      setAuthStage(ui, { text: "Загружено", visible: true, showRetry: false });
      setTimeout(() => setAuthStage(ui, { text: "Загружено", visible: false }), AUTH_STATUS_HIDE_DELAY_MS);
    } else {
      setAuthStage(ui, { text: "Требуется вход", visible: true, showRetry: false });
    }
  } catch (err) {
    console.error(err);
    cloudReady = false;
    lastSaveOk = false;
    setAuthStage(ui, { text: "Кажется, вход завис. Повторить?", visible: true, showRetry: true });
    updateNetBadge();
  } finally {
    clearAuthTimeout();
    authFlowInProgress = false;
  }
}

function waitForDataChoice() {
  return new Promise((resolve) => {
    dataChoiceResolve = resolve;
  });
}

function startAuthTimeout() {
  clearAuthTimeout();
  authStageTimer = setTimeout(() => {
    authInitTimedOut = true;
    cloudReady = false;
    setAuthStage(ui, { text: "Кажется, вход завис. Повторить?", visible: true, showRetry: true });
    updateNetBadge();
  }, AUTH_TIMEOUT_MS);
}

function clearAuthTimeout() {
  if (authStageTimer) {
    clearTimeout(authStageTimer);
    authStageTimer = null;
  }
}

function resetAuthInitState() {
  clearAuthTimeout();
  authFlowInProgress = false;
  authInitTimedOut = false;
}

async function getUserSafe() {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error) return null;
    return data?.user || null;
  } catch {
    return null;
  }
}

function wireEvents() {
  if (ui.authStatusBtn) {
    ui.authStatusBtn.addEventListener("click", () => {
      if (ui.authStatusBtn.dataset.retry !== "true") return;
      setAuthStage(ui, { text: "Проверяем сессию…", visible: true, showRetry: false });
      runAuthInit({ force: true, reason: "manual-retry-authStatusBtn" });
    });
  }

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
    if (t?.dataset?.role !== "goalDaily") return;
    const id = t.dataset.goalId;
    const g = state.dailyGoals.find(x => x.id === id);
    if (!g) return;
    g.isDaily = t.checked;
    state = markOpened(state);
    scheduleSave();
  });

  ui.goalsList.addEventListener("click", (e) => {
    const t = e.target;
    if (t?.dataset?.role === "goalDoneAction") {
      const id = t.dataset.goalId;
      const g = state.dailyGoals.find(x => x.id === id);
      if (!g) return;
      openCommentModal(id);
      return;
    }
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

  if (ui.calendar) {
    ui.calendar.addEventListener("click", (e) => {
      const cell = e.target.closest(".calCell");
      if (!cell?.dataset?.dayKey) return;
      scrollHistoryToDay(ui, cell.dataset.dayKey);
    });

    ui.calendar.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const cell = e.target.closest(".calCell");
      if (!cell?.dataset?.dayKey) return;
      e.preventDefault();
      scrollHistoryToDay(ui, cell.dataset.dayKey);
    });
  }

    ui.btnLogin.addEventListener("click", async () => {
    if (!supabase) return toast(ui, "Supabase не настроен (URL/KEY)");

    const isLoggedIn = ui.btnLogin.textContent.includes("Выйти");
    setLoginLoading(true, isLoggedIn ? "⏳ Выходим…" : "⏳ Входим…");
    logAuthStage(isLoggedIn ? "Запрос на выход" : "Запрос на вход");
    setAuthStage(ui, { text: isLoggedIn ? "Выходим…" : "Входим…", visible: true });

    // Если уже залогинен — делаем "Выйти"
    const { data } = await supabase.auth.getUser();
    if (data?.user) {
      await supabase.auth.signOut();
      setLoginLoading(false);
      syncLoginButtonLabel();
      setAuthStage(ui, { text: "Требуется вход", visible: true });
      return;
    }

    // Чистим URL от старых #error...
    history.replaceState(null, "", window.location.origin + window.location.pathname);

    const redirectTo = window.location.origin + window.location.pathname;

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });

    if (error) {
      setLoginLoading(false);
      syncLoginButtonLabel();
      toast(ui, "Ошибка входа: " + (error.message || String(error)));
    }
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
  if (ui.commentSaveBtn && ui.commentModal) {
    ui.commentSaveBtn.addEventListener("click", () => {
      if (!commentModalGoalId) return closeCommentModal();
      const goalId = commentModalGoalId;
      const g = state.dailyGoals.find(x => x.id === goalId);
      if (!g) return closeCommentModal();
      const comment = (ui.commentInput?.value || "").trim();
      state = completeGoal(state, goalId, { comment, keepGoal: !!g.isDaily });
      state = markOpened(state);
      renderAll(ui, state);
      scheduleSave();
      closeCommentModal();
    });
  }
  if (ui.commentCancelBtn && ui.commentModal) {
    ui.commentCancelBtn.addEventListener("click", () => {
      closeCommentModal();
    });
  }

  if (ui.dataChoiceCloudBtn) {
    ui.dataChoiceCloudBtn.addEventListener("click", () => {
      if (dataChoiceResolve) {
        dataChoiceResolve("cloud");
        dataChoiceResolve = null;
      }
    });
  }
  if (ui.dataChoiceLocalBtn) {
    ui.dataChoiceLocalBtn.addEventListener("click", () => {
      if (dataChoiceResolve) {
        dataChoiceResolve("local");
        dataChoiceResolve = null;
      }
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
  if (ui.commentModal) {
    ui.commentModal.addEventListener("click", (e) => {
      if (e.target === ui.commentModal) {
        closeCommentModal();
      }
    });
  }

  if (ui.dataChoiceModal) {
    ui.dataChoiceModal.addEventListener("click", (e) => {
      if (e.target === ui.dataChoiceModal) {
        e.preventDefault();
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
  persist().then((res) => {
    if (!res?.ok) return;
    if (res.mode === "guest") {
      toast(ui, "Сохранено локально");
      return;
    }
    toast(ui, "Сохранено");
  });
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

function openCommentModal(goalId) {
  if (!ui.commentModal) return;
  commentModalGoalId = goalId;
  if (ui.commentInput) ui.commentInput.value = "";
  ui.commentModal.hidden = false;
  ui.commentModal.classList.add("show");
  if (ui.commentInput) ui.commentInput.focus();
}

function closeCommentModal() {
  if (!ui.commentModal) return;
  ui.commentModal.classList.remove("show");
  ui.commentModal.hidden = true;
  commentModalGoalId = null;
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
  if (dataChoicePending || (authFlowInProgress && !authInitTimedOut)) {
    debug("Save skipped: awaiting auth/data choice");
    return;
  }
  if (saveTimer) clearTimeout(saveTimer);
  markPendingSync();
  saveTimer = setTimeout(() => persist(), 350);
}

async function persist() {
  if (saving) return;
  if (dataChoicePending || (authFlowInProgress && !authInitTimedOut)) return;
  saving = true;
  saveInProgress = true;
  if (!user) {
    const localRes = saveGuestState(deviceId, state);
    setModeInfo(ui, "guest", user);
    isDirty = !localRes?.ok;
    lastSaveOk = localRes?.ok || false;
    saving = false;
    saveInProgress = false;
    updateNetBadge();
    return { ok: !!localRes?.ok, mode: "guest" };
  }

  saveUserStateLocal(user.id, state);
  if (!cloudReady) {
    isDirty = true;
    lastSaveOk = false;
    updateNetBadge();
    showSyncToastOnce("Не удалось синхронизировать. Проверьте вход и нажмите ‘Повторить’.");
    saving = false;
    saveInProgress = false;
    return { ok: false, mode: "local", reason: "cloud-not-ready" };
  }
  const res = await saveRemoteState(supabase, user.id, state);
  mode = "remote";
  setModeInfo(ui, mode, user);
  if (res.ok) {
    isDirty = false;
    lastSaveOk = true;
  } else {
    isDirty = true;
    lastSaveOk = false;
    showOfflineNotice("Мы оффлайн, данные не сохранятся.");
    showSyncToastOnce("Не удалось синхронизировать. Проверьте вход и нажмите ‘Повторить’.");
  }
  saving = false;
  saveInProgress = false;
  updateNetBadge();
  return { ...res, mode: "remote" };
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

function logAuthStage(message) {
  console.log(`[auth] ${message}`);
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
  isDirty = true;
  if (user && !cloudReady) {
    showSyncToastOnce("Не удалось синхронизировать. Проверьте вход и нажмите ‘Повторить’.");
  }
  updateNetBadge();
}

function updateNetBadge() {
  setOnlineBadge(ui, {
    isDirty,
    lastSaveOk,
    saveInProgress
  });
}

function showOfflineNotice(message) {
  if (!ui.offlineModal || offlineModalShown) return;
  if (ui.offlineMessage) ui.offlineMessage.textContent = message;
  ui.offlineModal.hidden = false;
  ui.offlineModal.classList.add("show");
  offlineModalShown = true;
}

function showSyncToastOnce(message) {
  const now = Date.now();
  if (now - lastSyncToastAt < SYNC_TOAST_THROTTLE_MS) return;
  lastSyncToastAt = now;
  toast(ui, message, 3500);
}

function hardFail(err) {
  console.error(err);
  alert("BOOT FAIL: " + (err?.message || String(err)));
}

function scrollToTop() {
  window.scrollTo({ top: 0, left: 0 });
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

function hasMeaningfulState(state) {
  if (!state) return false;
  if (state?.stake?.text) return true;
  if (state?.stake?.done) return true;
  if (Array.isArray(state?.dailyGoals)) {
    const goalHasData = state.dailyGoals.some(goal =>
      (goal?.text && String(goal.text).trim()) ||
      goal?.doneToday ||
      goal?.isDaily
    );
    if (goalHasData) return true;
  }
  if (Array.isArray(state?.history) && state.history.length > 0) return true;
  if (state?.todayNote && String(state.todayNote).trim()) return true;
  return false;
}

function normalizeForCompare(state) {
  if (!state) return null;
  const normalized = normalizeState(state);
  const goals = [...normalized.dailyGoals]
    .map(goal => ({
      id: goal.id,
      text: String(goal.text || ""),
      doneToday: !!goal.doneToday,
      isDaily: !!goal.isDaily,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const history = [...(normalized.history || [])]
    .map(entry => ({
      ts: entry.ts,
      type: entry.type,
      payload: sanitizePayload(entry.payload),
    }))
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));

  return {
    stake: {
      text: String(normalized.stake?.text || ""),
      done: !!normalized.stake?.done,
    },
    dailyGoals: goals,
    todayNote: String(normalized.todayNote || ""),
    history,
  };
}

function sanitizePayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const out = {};
  Object.keys(payload)
    .sort()
    .forEach((key) => {
      if (payload[key] !== undefined) out[key] = payload[key];
    });
  return out;
}

function stableStringify(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortDeep(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function statesEqual(a, b) {
  return stableStringify(normalizeForCompare(a)) === stableStringify(normalizeForCompare(b));
}

function buildDiffSummary(localState, cloudState) {
  const local = normalizeState(localState);
  const cloud = normalizeState(cloudState);
  const sections = [];

  sections.push(buildGoalsDiff(local, cloud));
  sections.push(buildHistoryDiff(local, cloud));
  sections.push(buildActivityDiff(local, cloud));

  return sections.filter(section => section);
}

function buildGoalsDiff(local, cloud) {
  const localMap = new Map(local.dailyGoals.map(goal => [goal.id, goal]));
  const cloudMap = new Map(cloud.dailyGoals.map(goal => [goal.id, goal]));

  const addedLocal = [];
  const onlyCloud = [];
  const changed = [];

  localMap.forEach((goal, id) => {
    if (!cloudMap.has(id)) {
      if (goal.text) addedLocal.push(`Добавлено локально: ${goal.text}`);
      return;
    }
    const other = cloudMap.get(id);
    const diffs = [];
    if (goal.text !== other.text) {
      diffs.push(`текст: "${other.text || "—"}" → "${goal.text || "—"}"`);
    }
    if (!!goal.isDaily !== !!other.isDaily) {
      diffs.push(`ежедневная: ${other.isDaily ? "да" : "нет"} → ${goal.isDaily ? "да" : "нет"}`);
    }
    if (!!goal.doneToday !== !!other.doneToday) {
      diffs.push(`выполнена сегодня: ${other.doneToday ? "да" : "нет"} → ${goal.doneToday ? "да" : "нет"}`);
    }
    if (diffs.length) {
      changed.push(`Изменено: ${goal.text || other.text || "Цель"} (${diffs.join(", ")})`);
    }
  });

  cloudMap.forEach((goal, id) => {
    if (!localMap.has(id)) {
      if (goal.text) onlyCloud.push(`Есть только в облаке: ${goal.text}`);
    }
  });

  return {
    title: "Цели",
    items: [...addedLocal, ...onlyCloud, ...changed],
  };
}

function buildHistoryDiff(local, cloud) {
  const localHistory = Array.isArray(local.history) ? local.history : [];
  const cloudHistory = Array.isArray(cloud.history) ? cloud.history : [];
  const localSet = new Set(localHistory.map(historyKey));
  const cloudSet = new Set(cloudHistory.map(historyKey));

  const onlyLocal = localHistory.filter(entry => !cloudSet.has(historyKey(entry)));
  const onlyCloud = cloudHistory.filter(entry => !localSet.has(historyKey(entry)));

  const items = [
    `В облаке записей: ${cloudHistory.length}, локально: ${localHistory.length}`,
  ];

  onlyLocal.slice(0, 5).forEach(entry => {
    items.push(`Только локально: ${formatHistoryEntry(entry)}`);
  });
  onlyCloud.slice(0, 5).forEach(entry => {
    items.push(`Только в облаке: ${formatHistoryEntry(entry)}`);
  });

  return {
    title: "История",
    items,
  };
}

function historyKey(entry) {
  const payload = entry?.payload || {};
  return [
    entry?.ts || "",
    entry?.type || "",
    payload.goalId || "",
    payload.text || "",
    payload.note || "",
  ].join("|");
}

function formatHistoryEntry(entry) {
  const date = entry?.ts ? new Date(entry.ts).toLocaleString("ru-RU") : "—";
  const type = entry?.type || "—";
  const text = entry?.payload?.text || entry?.payload?.note || entry?.payload?.focusGoal || "";
  return `${date} — ${type}${text ? ` (${text})` : ""}`;
}

function buildActivityDiff(local, cloud) {
  const localLast = lastActionAt(local);
  const cloudLast = lastActionAt(cloud);
  const localStr = new Date(localLast).toLocaleString("ru-RU");
  const cloudStr = new Date(cloudLast).toLocaleString("ru-RU");
  const items = [];
  if (localLast !== cloudLast) {
    items.push(`Последняя активность: облако ${cloudStr}, локально ${localStr}`);
  }
  return {
    title: "Активность",
    items,
  };
}

function syncLoginButtonLabel() {
  if (!ui.btnLogin) return;
  ui.btnLogin.textContent = user ? "🚪 Выйти" : "🔐 Войти";
  ui.btnLogin.dataset.label = ui.btnLogin.textContent;
}

function setLoginLoading(isLoading, label) {
  if (!ui.btnLogin) return;
  if (isLoading) {
    if (!ui.btnLogin.dataset.label) {
      ui.btnLogin.dataset.label = ui.btnLogin.textContent;
    }
    ui.btnLogin.classList.add("is-loading");
    ui.btnLogin.disabled = true;
    ui.btnLogin.setAttribute("aria-busy", "true");
    ui.btnLogin.textContent = label || "⏳ Входим…";
    return;
  }

  ui.btnLogin.classList.remove("is-loading");
  ui.btnLogin.disabled = false;
  ui.btnLogin.removeAttribute("aria-busy");
}











