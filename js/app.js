import { createSupabaseClient } from "./supabaseClient.js";
import {
  defaultState, normalizeState, addGoal, deleteGoal,
  markOpened, completeGoal,
  computeStreak, lastActionAt, deleteHistoryEntry
} from "./state.js";
import {
  getDeviceId,
  loadActiveArea,
  loadGuestState,
  loadRemoteState,
  loadUserStateLocal,
  saveActiveArea,
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
  setActiveAreaButtons,
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
let localSaveOk = null;
let saveInProgress = false;
let offlineModalShown = false;
let commentModalGoalId = null;
let deleteGoalId = null;
let dataChoiceResolve = null;
let mandatoryGoalReturnFocusEl = null;
let deleteGoalReturnFocusEl = null;
const THEME_KEY = "goal-theme";
const AREAS = [
  { id: "business", label: "Бизнес" },
  { id: "health", label: "Здоровье" },
  { id: "relationships", label: "Отношения" },
];
const DEFAULT_AREA = "business";
const AUTH_TIMEOUT_MS = 8000;
const AUTH_STATUS_HIDE_DELAY_MS = 500;
const SYNC_TOAST_THROTTLE_MS = 1000;
const RETRY_BASE_DELAY_MS = 2000;
const RETRY_MAX_DELAY_MS = 10000;
let authListenerAttached = false;
let authFlowInProgress = false;
let dataChoicePending = false;
let pendingSave = false;
let authStageTimer = null;
let authInitTimedOut = false;
let lastSyncToastAt = 0;
let cloudBlockReason = null;
let retryTimer = null;
let retryAttempt = 0;
let loginActionInProgress = false;
let loginAttemptId = 0;
let oauthFallbackTimer = null;
let activeArea = normalizeArea(loadActiveArea() || DEFAULT_AREA);
let areaSwitchInProgress = false;
let areaSwitchAttemptId = 0;
let pendingAreaSwitch = null;
const deviceId = getDeviceId();

function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(label || `timeout after ${ms}ms`);
      err.name = "AbortError";
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function normalizeArea(area) {
  const normalized = String(area || "").toLowerCase();
  if (AREAS.some((entry) => entry.id === normalized)) return normalized;
  return DEFAULT_AREA;
}

function areaLabel(area) {
  const match = AREAS.find((entry) => entry.id === area);
  return match?.label || area;
}

function setActiveArea(area) {
  activeArea = normalizeArea(area);
  saveActiveArea(activeArea);
  setActiveAreaButtons(ui, activeArea);
}

boot().catch(err => hardFail(err));

async function boot() {
  installGuards();
  applyTheme(loadTheme());
  setLoginLoading(false);

  wireEvents();
  setActiveArea(activeArea);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    const shouldForce = authInitTimedOut || cloudBlockReason === "auth-timeout";
    if (shouldForce) {
      if (navigator.onLine) {
        runAuthInit({ force: true, reason: "tab-visible" });
      } else {
        toast(ui, "Нет подключения к интернету");
      }
    }
  });
	
  await runAuthInit({ reason: "boot" });

  updateNetBadge();

  startHistorySizer(ui);
  window.addEventListener("resize", () => syncHistoryHeight(ui));

  if (supabase && !authListenerAttached) {
    authListenerAttached = true;
    supabase.auth.onAuthStateChange(async (event, session) => {
      user = session?.user || null;
      setLoginLoading(false);
      syncLoginButtonLabel();
      const shouldInit = ["SIGNED_IN", "SIGNED_OUT", "INITIAL_SESSION"].includes(event);
      if (shouldInit) {
        await runAuthInit({ reason: `auth-change:${event}` });
        toast(ui, user ? "Вошли, данные синхронизированы" : "Вышли, гостевой режим");
        return;
      }
      if (event === "TOKEN_REFRESHED") {
        console.info("[auth] TOKEN_REFRESHED: init skipped");
      }
    });
  }

  debug(`BOOT: renderAll OK`, {
    goalsListChildren: ui.goalsList.children.length,
    calendarChildren: ui.calendar.children.length
  });
}

async function handleAuthRedirect() {
  if (!supabase) return false;
  const search = window.location.search || "";
  if (search) {
    const query = new URLSearchParams(search);
    const code = query.get("code");
    if (code) {
      logAuthStage("Обрабатываем вход (code)…");
      setAuthStage(ui, { text: "Обрабатываем вход (code)…", visible: true });
      startAuthTimeout();
      if (typeof supabase.auth.exchangeCodeForSession === "function") {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) {
          toast(ui, "Ошибка входа: " + (error.message || String(error)));
        }
      } else if (typeof supabase.auth.getSessionFromUrl === "function") {
        const { error } = await supabase.auth.getSessionFromUrl({ storeSession: true });
        if (error) {
          toast(ui, "Ошибка входа: " + (error.message || String(error)));
        }
      } else {
        toast(ui, "Ошибка входа: метод обмена кода не найден");
      }
      history.replaceState(null, "", window.location.origin + window.location.pathname);
      clearAuthTimeout();
      return true;
    }
  }
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
  cloudBlockReason = "auth-init";
  clearRetry();
  dataChoicePending = false;
  hideDataChoiceModal(ui);
  logAuthStage(`Запуск загрузки (${reason})`);

  setAuthStage(ui, { text: "Проверяем сессию…", visible: true, showRetry: false });
  updateNetBadge();
  startAuthTimeout();

  try {
    setAuthStage(ui, { text: "Проверяем redirect…", visible: true, showRetry: false });
    await handleAuthRedirect();
    setAuthStage(ui, { text: "Проверяем сессию…", visible: true, showRetry: false });
    const sessionUser = await getSessionUser();
    user = sessionUser;
    cloudReady = !!user;
    syncLoginButtonLabel();
    clearAuthTimeout();

    setAuthStage(ui, { text: "Загружаем данные…", visible: true, showRetry: false });

    const guestRaw = loadGuestState(deviceId, activeArea);
    const guestState = guestRaw ? normalizeState(guestRaw) : null;

    let cloudState = null;
    let userLocalState = null;
    const canAttemptRemote = !!user && (cloudReady || authInitTimedOut);
    if (user) {
      if (canAttemptRemote) {
        setAuthStage(ui, { text: "Читаем облако…", visible: true, showRetry: false });
        const remote = await loadRemoteState(supabase, user.id, activeArea);
        cloudState = remote?.state ? normalizeState(remote.state) : null;
      }
      const localRaw = loadUserStateLocal(user.id, activeArea);
      userLocalState = localRaw ? normalizeState(localRaw) : null;
    }

    const localPick = pickLocalState(guestState, userLocalState);
    const localState = localPick.state;
    const localHas = hasMeaningfulState(localState);
    const cloudHas = hasMeaningfulState(cloudState);

    if (user && canAttemptRemote && localHas && cloudHas && !statesEqual(localState, cloudState)) {
      dataChoicePending = true;
      const diffSections = buildDiffSummary(localState, cloudState);
      renderDiffList(ui, diffSections);
      showDataChoiceModal(ui);

      state = markOpened(normalizeState(localState));
      mode = "remote";
      setModeInfo(ui, { mode, user, cloudReady, localSaveOk });
      updateNetBadge();
      renderAll(ui, state);
      scrollToTop();

      const choice = await waitForDataChoice();
      hideDataChoiceModal(ui);
      dataChoicePending = false;

      if (choice === "cloud") {
        if (localState) {
          backupState("local", localState);
        }
        state = markOpened(normalizeState(cloudState));
        const updatedGuest = {
          ...state,
          lastConflictResolvedAt: Date.now(),
          lastConflictChoice: "cloud",
        };
        state = updatedGuest;
        const localUserRes = saveUserStateLocal(user.id, activeArea, state, { skipGuard: true });
        localSaveOk = !!localUserRes?.ok;
        isDirty = false;
        lastSaveOk = true;
        toast(ui, "Оставляем облачные данные");
      } else if (choice === "local") {
        if (cloudState) {
          backupState("cloud", cloudState);
        }
        state = markOpened(normalizeState(localState));
        const updatedLocal = {
          ...state,
          lastConflictResolvedAt: Date.now(),
          lastConflictChoice: "local",
        };
        state = updatedLocal;
        const localUserRes = saveUserStateLocal(user.id, activeArea, state, { skipGuard: true });
        localSaveOk = !!localUserRes?.ok;
        const res = await saveRemoteState(supabase, user.id, activeArea, state, { skipGuard: true });
        isDirty = !res.ok;
        lastSaveOk = res.ok;
        if (!res.ok) showOfflineNotice("Мы оффлайн, данные не сохранятся.");
        toast(ui, "Оставляем локальные данные");
      }
    } else {
      const finalState = cloudHas
        ? cloudState
        : localHas
          ? localState
          : defaultState();
      state = markOpened(normalizeState(finalState));
      mode = user ? "remote" : "guest";
      isDirty = false;
      lastSaveOk = true;
      if (user) {
        const localUserRes = saveUserStateLocal(user.id, activeArea, state);
        localSaveOk = !!localUserRes?.ok;
        if (localHas && !cloudHas && canAttemptRemote) {
          const res = await saveRemoteState(supabase, user.id, activeArea, state, { skipGuard: true });
          isDirty = !res.ok;
          lastSaveOk = res.ok;
          if (!res.ok) showOfflineNotice("Мы оффлайн, данные не сохранятся.");
        }
      }
    }

    cloudBlockReason = cloudReady ? null : "no-user";
    if (!cloudReady) {
      logAuthStage(`Cloud disabled: ${cloudBlockReason}`);
    }
    offlineModalShown = false;
    setModeInfo(ui, { mode, user, cloudReady, localSaveOk });
    updateNetBadge();
    renderAll(ui, state);
    scrollToTop();

    if (user) {
      setAuthStage(ui, { text: "Загружено", visible: true, showRetry: false });
      setTimeout(() => setAuthStage(ui, { text: "Загружено", visible: false }), AUTH_STATUS_HIDE_DELAY_MS);
    } else {
      setAuthStage(ui, { text: "Локально", visible: true, showRetry: false });
    }
  } catch (err) {
    console.error(err);
    cloudReady = false;
    lastSaveOk = false;
    cloudBlockReason = "auth-error";
    setAuthStage(ui, { text: "Обновить", visible: true, showRetry: true });
    updateNetBadge();
  } finally {
    clearAuthTimeout();
    authFlowInProgress = false;
    if (pendingAreaSwitch) {
      const nextArea = pendingAreaSwitch;
      pendingAreaSwitch = null;
      switchArea(nextArea);
    }
    if (pendingSave && !dataChoicePending) {
      pendingSave = false;
      persist();
    }
    if (user && (isDirty || pendingSave) && !dataChoicePending) {
      pendingSave = false;
      persist();
    }
  }
}

async function switchArea(newArea) {
  const targetArea = normalizeArea(newArea);
  if (targetArea === activeArea) return;
  if (authFlowInProgress) {
    pendingAreaSwitch = targetArea;
    toast(ui, `Переключение после входа: ${areaLabel(targetArea)}…`);
    return;
  }
  if (dataChoicePending) return;
  if (areaSwitchInProgress) {
    pendingAreaSwitch = targetArea;
    areaSwitchAttemptId += 1;
    return;
  }

  const attemptId = ++areaSwitchAttemptId;
  areaSwitchInProgress = true;

  try {
    if (isDirty) {
      const snapshot = { ...state };
      if (!user) {
        saveGuestState(deviceId, activeArea, snapshot);
      }
      if (user) {
        saveUserStateLocal(user.id, activeArea, snapshot);
      }
      if (user && (cloudReady || authInitTimedOut)) {
        saveRemoteState(supabase, user.id, activeArea, snapshot).catch(() => null);
      }
    }

    setActiveArea(targetArea);
    toast(ui, `Переключаемся на: ${areaLabel(targetArea)}…`);

    const guestRaw = loadGuestState(deviceId, targetArea);
    const guestState = guestRaw ? normalizeState(guestRaw) : null;

    let cloudState = null;
    let userLocalState = null;
    const canAttemptRemote = !!user && (cloudReady || authInitTimedOut);
    if (user) {
      const localRaw = loadUserStateLocal(user.id, targetArea);
      userLocalState = localRaw ? normalizeState(localRaw) : null;
      if (canAttemptRemote) {
        const remote = await loadRemoteState(supabase, user.id, targetArea);
        if (attemptId !== areaSwitchAttemptId) return;
        cloudState = remote?.state ? normalizeState(remote.state) : null;
      }
    }

    const localPick = pickLocalState(guestState, userLocalState);
    const localState = localPick.state;
    const localHas = hasMeaningfulState(localState);
    const cloudHas = hasMeaningfulState(cloudState);

    if (user && canAttemptRemote && localHas && cloudHas && !statesEqual(localState, cloudState)) {
      dataChoicePending = true;
      const diffSections = buildDiffSummary(localState, cloudState);
      renderDiffList(ui, diffSections);
      showDataChoiceModal(ui);

      state = markOpened(normalizeState(localState));
      renderAll(ui, state);
      scrollToTop();

      const choice = await waitForDataChoice();
      if (attemptId !== areaSwitchAttemptId) return;
      hideDataChoiceModal(ui);
      dataChoicePending = false;

      if (choice === "cloud") {
        if (localState) {
          backupState("local", localState);
        }
        state = markOpened(normalizeState(cloudState));
        const updatedGuest = {
          ...state,
          lastConflictResolvedAt: Date.now(),
          lastConflictChoice: "cloud",
        };
        state = updatedGuest;
        const localUserRes = saveUserStateLocal(user.id, targetArea, state, { skipGuard: true });
        localSaveOk = !!localUserRes?.ok;
        isDirty = false;
        lastSaveOk = true;
        toast(ui, "Оставляем облачные данные");
      } else if (choice === "local") {
        if (cloudState) {
          backupState("cloud", cloudState);
        }
        state = markOpened(normalizeState(localState));
        const updatedLocal = {
          ...state,
          lastConflictResolvedAt: Date.now(),
          lastConflictChoice: "local",
        };
        state = updatedLocal;
        const localUserRes = saveUserStateLocal(user.id, targetArea, state, { skipGuard: true });
        localSaveOk = !!localUserRes?.ok;
        const res = await saveRemoteState(supabase, user.id, targetArea, state, { skipGuard: true });
        isDirty = !res.ok;
        lastSaveOk = res.ok;
        if (!res.ok) showOfflineNotice("Мы оффлайн, данные не сохранятся.");
        toast(ui, "Оставляем локальные данные");
      }
    } else {
      const finalState = cloudHas
        ? cloudState
        : localHas
          ? localState
          : defaultState();
      state = markOpened(normalizeState(finalState));
      isDirty = false;
      lastSaveOk = true;
      if (user) {
        const localUserRes = saveUserStateLocal(user.id, targetArea, state);
        localSaveOk = !!localUserRes?.ok;
        if (localHas && !cloudHas && (cloudReady || authInitTimedOut)) {
          const res = await saveRemoteState(supabase, user.id, targetArea, state, { skipGuard: true });
          isDirty = !res.ok;
          lastSaveOk = res.ok;
          if (!res.ok) showOfflineNotice("Мы оффлайн, данные не сохранятся.");
        }
      } else {
        const localGuestRes = saveGuestState(deviceId, targetArea, state);
        localSaveOk = !!localGuestRes?.ok;
      }
    }

    if (attemptId !== areaSwitchAttemptId) return;
    mode = user ? "remote" : "guest";
    setModeInfo(ui, { mode, user, cloudReady, localSaveOk });
    updateNetBadge();
    renderAll(ui, state);
    scrollToTop();
  } finally {
    areaSwitchInProgress = false;
    const nextArea = pendingAreaSwitch;
    pendingAreaSwitch = null;
    if (nextArea && nextArea !== activeArea) {
      switchArea(nextArea);
    }
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
    if (!authFlowInProgress) return;

    // Если вкладка скрыта — не показываем “Обновить” сейчас,
    // но помечаем таймаут, чтобы при возврате переинициализировать.
    if (document.hidden) {
      authInitTimedOut = true;
      logAuthStage("Auth init timeout while hidden: will retry on tab-visible.");
      updateNetBadge();
      return;
    }

    authInitTimedOut = true;
    cloudBlockReason = "auth-timeout";
    logAuthStage("Auth init timeout (still in progress): retry suggested.");
    authFlowInProgress = false;
    setAuthStage(ui, { text: "Обновить", visible: true, showRetry: true });
    updateNetBadge();
    if (pendingSave && !dataChoicePending) {
      pendingSave = false;
      persist();
    }
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
  cloudBlockReason = null;
}

async function getSessionUser() {
  if (!supabase) return null;
  try {
    const { data, error } = await withTimeout(
      supabase.auth.getSession(),
      AUTH_TIMEOUT_MS,
      `[auth] getSession timed out after ${AUTH_TIMEOUT_MS}ms.`
    );
    if (error) return null;
    return data?.session?.user || null;
  } catch (err) {
    if (err?.name === "AbortError") {
      console.warn(err?.message || `[auth] getSession timed out after ${AUTH_TIMEOUT_MS}ms.`);
      return null;
    }
    console.warn("[auth] getSession failed:", err);
    return null;
  }
}

function wireEvents() {
  if (ui.authStatusBtn) {
    ui.authStatusBtn.addEventListener("click", () => {
      if (ui.authStatusBtn.dataset.retry !== "true") return;
      setAuthStage(ui, { text: "Проверяем сессию…", visible: true, showRetry: false });
      location.reload();
    });
  }

  if (ui.areaButtons?.length) {
    ui.areaButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const area = btn.dataset.area;
        if (!area) return;
        switchArea(area);
      });
    });
  }

  if (ui.mandatoryGoalActionBtn) {
    ui.mandatoryGoalActionBtn.addEventListener("click", () => {
      openMandatoryGoalModal();
    });
  }

  if (ui.mandatoryGoalSummaryBtn) {
    ui.mandatoryGoalSummaryBtn.addEventListener("click", () => {
      openMandatoryGoalModal();
    });
  }

  if (ui.mandatoryGoalInfoBtn) {
    ui.mandatoryGoalInfoBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMandatoryGoalPopover();
    });
  }

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
    openDeleteGoalModal(t.dataset.goalId);
  });

  ui.btnAddGoal.addEventListener("click", () => {
    state = addGoal(state);
    state = markOpened(state);
    renderAll(ui, state);
    scheduleSave();
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

  if (ui.history) {
    ui.history.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-role='historyDelete']");
      if (!btn) return;
      const key = btn.dataset.historyKey;
      if (!key) return;
      state = deleteHistoryEntry(state, key);
      state = markOpened(state);
      renderAll(ui, state);
      scheduleSave();
    });
  }

ui.btnLogin.addEventListener("click", async () => {
  if (!supabase) return toast(ui, "Supabase не настроен (URL/KEY)");
  if (loginActionInProgress) return;
  loginActionInProgress = true;
  const attemptId = ++loginAttemptId;
  if (oauthFallbackTimer) {
    clearTimeout(oauthFallbackTimer);
    oauthFallbackTimer = null;
  }
  let oauthStarted = false;

  try {
    setLoginLoading(true, "⏳ Проверяем…");
    setAuthStage(ui, { text: "Проверяем…", visible: true });

    let authUser = null;
    try {
      const { data, error } = await withTimeout(
        supabase.auth.getUser(),
        AUTH_TIMEOUT_MS,
        `[auth] getUser timed out after ${AUTH_TIMEOUT_MS}ms.`
      );
      if (error) {
        const isNoSession =
          error?.name === "AuthSessionMissingError" ||
          /auth session missing/i.test(error?.message || "");
        if (!isNoSession) {
          console.warn("[auth] getUser error:", error);
          setLoginLoading(false);
          syncLoginButtonLabel();
          setAuthStage(ui, { text: "Ошибка проверки пользователя", visible: true });
          toast(ui, "Ошибка проверки пользователя. Повторите попытку.");
          return;
        }
        authUser = null;
      } else {
        authUser = data?.user || null;
      }
    } catch (err) {
      if (err?.name !== "AbortError") {
        console.warn("[auth] getUser failed:", err);
      }
      setLoginLoading(false);
      syncLoginButtonLabel();
      setAuthStage(ui, { text: "Ошибка проверки пользователя", visible: true });
      if (err?.name === "AbortError") {
        toast(ui, "Таймаут проверки пользователя. Повторите попытку.");
        return;
      }
      toast(ui, "Ошибка проверки пользователя. Повторите попытку.");
      return;
    }

    const isLoggedIn = !!authUser;

    setLoginLoading(true, isLoggedIn ? "⏳ Выходим…" : "⏳ Входим…");
    logAuthStage(isLoggedIn ? "Запрос на выход" : "Запрос на вход");
    setAuthStage(ui, { text: isLoggedIn ? "Выходим…" : "Входим…", visible: true });

    if (isLoggedIn) {
      try {
        const { error } = await withTimeout(
          supabase.auth.signOut(),
          AUTH_TIMEOUT_MS,
          `[auth] signOut timed out after ${AUTH_TIMEOUT_MS}ms.`
        );
        if (error) {
          throw error;
        }
      } catch (err) {
        if (err?.name !== "AbortError") {
          console.warn("[auth] signOut failed:", err);
        }
        setLoginLoading(false);
        syncLoginButtonLabel();
        setAuthStage(ui, { text: "Ошибка выхода", visible: true });
        if (err?.name === "AbortError") {
          toast(ui, "Таймаут выхода. Повторите попытку.");
          return;
        }
        toast(ui, "Ошибка выхода. Повторите попытку.");
        return;
      }
      setLoginLoading(false);
      syncLoginButtonLabel();
      user = null;
      cloudReady = false;
      mode = "guest";
      cloudBlockReason = null;
      authInitTimedOut = false;
      authFlowInProgress = false;
      clearRetry();
      dataChoicePending = false;
      pendingSave = false;
      setModeInfo(ui, { mode, user, cloudReady, localSaveOk });
      updateNetBadge();
      setAuthStage(ui, { text: "Локально", visible: true });
      return;
    }

    const redirectTo = window.location.origin + window.location.pathname;

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });

    if (error) {
      setLoginLoading(false);
      syncLoginButtonLabel();
      setAuthStage(ui, { text: "Ошибка входа", visible: true });
      toast(ui, "Ошибка входа: " + (error.message || String(error)));
      return;
    }

    oauthStarted = true;
    oauthFallbackTimer = setTimeout(() => {
      const isStale = attemptId !== loginAttemptId;
      oauthFallbackTimer = null;
      if (isStale) return;
      loginActionInProgress = false;
      setLoginLoading(false);
      syncLoginButtonLabel();
      setAuthStage(ui, { text: "Ожидаем вход…", visible: true });
    }, 2500);
    return;
  } finally {
    if (!oauthStarted) {
      loginActionInProgress = false;
    }
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

  if (ui.commentSaveBtn && ui.commentModal) {
    ui.commentSaveBtn.addEventListener("click", () => {
      if (!commentModalGoalId) return closeCommentModal();
      const goalId = commentModalGoalId;
      const g = state.dailyGoals.find(x => x.id === goalId);
      if (!g) return closeCommentModal();
      const comment = (ui.commentInput?.value || "").trim();
      const isPartial = !!ui.commentPartialCheckbox?.checked;
      const keepGoal = isPartial;
      const statusLabel = isPartial
        ? (g.isDaily ? "Частично сделана ежедневная цель" : "Частично сделана цель")
        : (g.isDaily ? "Сделана ежедневная цель" : "Сделана цель");
      state = completeGoal(state, goalId, { comment, keepGoal, statusLabel });
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

  if (ui.deleteGoalConfirmBtn && ui.deleteGoalModal) {
    ui.deleteGoalConfirmBtn.addEventListener("click", () => {
      if (!deleteGoalId) return closeDeleteGoalModal();
      state = deleteGoal(state, deleteGoalId);
      state = markOpened(state);
      renderAll(ui, state);
      scheduleSave();
      closeDeleteGoalModal();
    });
  }

  if (ui.deleteGoalCancelBtn && ui.deleteGoalModal) {
    ui.deleteGoalCancelBtn.addEventListener("click", () => {
      closeDeleteGoalModal({ reason: "cancel" });
    });
  }


  if (ui.mandatoryGoalSaveBtn && ui.mandatoryGoalModal) {
    ui.mandatoryGoalSaveBtn.addEventListener("click", () => {
      handleMandatoryGoalSave();
    });
  }

  if (ui.mandatoryGoalCancelBtn && ui.mandatoryGoalModal) {
    ui.mandatoryGoalCancelBtn.addEventListener("click", () => {
      closeMandatoryGoalModal({ reason: "cancel" });
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
  if (ui.commentModal) {
    ui.commentModal.addEventListener("click", (e) => {
      if (e.target === ui.commentModal) {
        closeCommentModal();
      }
    });
  }

  if (ui.deleteGoalModal) {
    ui.deleteGoalModal.addEventListener("click", (e) => {
      if (e.target === ui.deleteGoalModal) {
        closeDeleteGoalModal({ reason: "backdrop" });
      }
    });
  }

  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (ui.mandatoryGoalPopover && !ui.mandatoryGoalPopover.hidden) {
      ui.mandatoryGoalPopover.hidden = true;
    }
    if (ui.mandatoryGoalModal?.classList.contains("show")) {
      closeMandatoryGoalModal({ reason: "escape" });
    }
    if (ui.deleteGoalModal?.classList.contains("show")) {
      closeDeleteGoalModal({ reason: "escape" });
    }
  });

  window.addEventListener("online", () => {
    logAuthStage("Network online: attempting sync.");
    updateNetBadge();
    const shouldForce = authInitTimedOut || cloudBlockReason === "auth-timeout";
    if (shouldForce) {
      runAuthInit({ force: true, reason: "online" });
      return;
    }
    if (user && isDirty) {
      persist();
    }
  });

  document.addEventListener("click", (e) => {
    if (!ui.mandatoryGoalPopover || ui.mandatoryGoalPopover.hidden) return;
    if (ui.mandatoryGoalPopover.contains(e.target)) return;
    if (ui.mandatoryGoalInfoBtn?.contains(e.target)) return;
    ui.mandatoryGoalPopover.hidden = true;
  });

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

function openCommentModal(goalId) {
  if (!ui.commentModal) return;
  commentModalGoalId = goalId;
  if (ui.commentInput) ui.commentInput.value = "";
  if (ui.commentPartialCheckbox) ui.commentPartialCheckbox.checked = false;
  ui.commentModal.hidden = false;
  ui.commentModal.classList.add("show");
  if (ui.commentInput) ui.commentInput.focus();
}

function closeCommentModal() {
  if (!ui.commentModal) return;
  ui.commentModal.classList.remove("show");
  ui.commentModal.hidden = true;
  commentModalGoalId = null;
  if (ui.commentPartialCheckbox) ui.commentPartialCheckbox.checked = false;
}

function openDeleteGoalModal(goalId) {
  if (!ui.deleteGoalModal) return;
  const goal = state?.dailyGoals.find((item) => item.id === goalId);
  deleteGoalId = goalId;
  deleteGoalReturnFocusEl = document.activeElement;
  if (ui.deleteGoalText) {
    ui.deleteGoalText.textContent = goal?.text ? `“${goal.text}”` : "Без названия";
  }
  ui.deleteGoalModal.hidden = false;
  ui.deleteGoalModal.classList.add("show");
  if (ui.deleteGoalConfirmBtn) ui.deleteGoalConfirmBtn.focus();
}

function closeDeleteGoalModal({ reason } = {}) {
  if (!ui.deleteGoalModal) return;
  ui.deleteGoalModal.classList.remove("show");
  ui.deleteGoalModal.hidden = true;
  deleteGoalId = null;
  if (reason === "backdrop" || reason === "escape" || reason === "cancel") {
    if (deleteGoalReturnFocusEl && typeof deleteGoalReturnFocusEl.focus === "function") {
      deleteGoalReturnFocusEl.focus();
    }
  }
  deleteGoalReturnFocusEl = null;
}

function openMandatoryGoalModal() {
  if (!ui.mandatoryGoalModal) return;
  mandatoryGoalReturnFocusEl = document.activeElement;
  const goal = state?.mandatoryGoal || {};
  if (ui.mandatoryGoalPopover) {
    ui.mandatoryGoalPopover.hidden = true;
  }
  if (ui.mandatoryGoalTitleInput) ui.mandatoryGoalTitleInput.value = goal.title || "";
  if (ui.mandatoryGoalMetricInput) ui.mandatoryGoalMetricInput.value = goal.metric || "";
  if (ui.mandatoryGoalWhyInput) ui.mandatoryGoalWhyInput.value = goal.why || "";
  if (ui.mandatoryGoalMinStepInput) ui.mandatoryGoalMinStepInput.value = goal.minStep || "";
  clearMandatoryGoalErrors();
  ui.mandatoryGoalModal.hidden = false;
  ui.mandatoryGoalModal.classList.add("show");
  document.body.classList.add("modalOpen");
  document.documentElement.classList.add("modalOpen");
  if (ui.mandatoryGoalTitleInput) ui.mandatoryGoalTitleInput.focus();
}

function closeMandatoryGoalModal({ reason } = {}) {
  if (!ui.mandatoryGoalModal) return;
  if (reason === "escape" || reason === "backdrop" || reason === "cancel") {
    clearMandatoryGoalErrors();
  }
  ui.mandatoryGoalModal.classList.remove("show");
  ui.mandatoryGoalModal.hidden = true;
  document.body.classList.remove("modalOpen");
  document.documentElement.classList.remove("modalOpen");
  if (mandatoryGoalReturnFocusEl && typeof mandatoryGoalReturnFocusEl.focus === "function") {
    mandatoryGoalReturnFocusEl.focus();
  }
  mandatoryGoalReturnFocusEl = null;
}

function clearMandatoryGoalErrors() {
  setMandatoryGoalFieldError(ui.mandatoryGoalTitleInput, ui.mandatoryGoalTitleError, false);
  setMandatoryGoalFieldError(ui.mandatoryGoalMetricInput, ui.mandatoryGoalMetricError, false);
  setMandatoryGoalFieldError(ui.mandatoryGoalWhyInput, ui.mandatoryGoalWhyError, false);
  if (ui.mandatoryGoalMinStepError) {
    ui.mandatoryGoalMinStepError.hidden = true;
  }
}

function setMandatoryGoalFieldError(inputEl, errorEl, hasError) {
  if (inputEl) inputEl.classList.toggle("inputError", hasError);
  if (errorEl) errorEl.hidden = !hasError;
}

function handleMandatoryGoalSave() {
  const title = sanitizeMandatoryGoalValue(ui.mandatoryGoalTitleInput?.value || "", 120);
  const metric = sanitizeMandatoryGoalValue(ui.mandatoryGoalMetricInput?.value || "", 120);
  const why = sanitizeMandatoryGoalValue(ui.mandatoryGoalWhyInput?.value || "", 800);
  const minStep = sanitizeMandatoryGoalValue(ui.mandatoryGoalMinStepInput?.value || "", 120);

  if (ui.mandatoryGoalTitleInput) ui.mandatoryGoalTitleInput.value = title;
  if (ui.mandatoryGoalMetricInput) ui.mandatoryGoalMetricInput.value = metric;
  if (ui.mandatoryGoalWhyInput) ui.mandatoryGoalWhyInput.value = why;
  if (ui.mandatoryGoalMinStepInput) ui.mandatoryGoalMinStepInput.value = minStep;

  const titleOk = Boolean(title);
  const metricOk = Boolean(metric);
  const whyOk = Boolean(why);

  setMandatoryGoalFieldError(ui.mandatoryGoalTitleInput, ui.mandatoryGoalTitleError, !titleOk);
  setMandatoryGoalFieldError(ui.mandatoryGoalMetricInput, ui.mandatoryGoalMetricError, !metricOk);
  setMandatoryGoalFieldError(ui.mandatoryGoalWhyInput, ui.mandatoryGoalWhyError, !whyOk);

  if (!titleOk || !metricOk || !whyOk) {
    return;
  }

  const now = Date.now();
  const existing = state?.mandatoryGoal || {};
  state.mandatoryGoal = {
    title,
    metric,
    why,
    minStep,
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };
  state = markOpened(state);
  renderAll(ui, state);
  scheduleSave();
  closeMandatoryGoalModal({ reason: "save" });
}

function sanitizeMandatoryGoalValue(value, maxLength) {
  const trimmed = String(value || "").trim();
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(0, maxLength);
}

function toggleMandatoryGoalPopover() {
  if (!ui.mandatoryGoalPopover) return;
  const willShow = ui.mandatoryGoalPopover.hidden;
  ui.mandatoryGoalPopover.hidden = !willShow;
  if (willShow) {
    setMandatoryGoalPopoverWidth();
  }
}

function setMandatoryGoalPopoverWidth() {
  if (!ui.mandatoryGoalPopover || !ui.mainCard) return;
  const summaryEl = ui.mandatoryGoalPopover.parentElement;
  if (!summaryEl) return;
  const summaryRect = summaryEl.getBoundingClientRect();
  const mainRect = ui.mainCard.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  const desiredWidth = Math.max(320, mainRect.right - summaryRect.left);
  const maxWidth = viewportWidth - summaryRect.left - 16;
  const width = Math.max(0, Math.min(desiredWidth, maxWidth));
  ui.mandatoryGoalPopover.style.width = `${width}px`;
}

let saveTimer = null;
function scheduleSave() {
  if (saving) return;
  if (authFlowInProgress && !authInitTimedOut) {
    pendingSave = true;
    markPendingSync();
    return;
  }
  if (dataChoicePending) return;
  if (saveTimer) clearTimeout(saveTimer);
  markPendingSync();
  saveTimer = setTimeout(() => persist(), 350);
}

function scheduleRetry(reason) {
  if (retryTimer) return;
  retryAttempt += 1;
  const delay = Math.min(RETRY_BASE_DELAY_MS * (2 ** (retryAttempt - 1)), RETRY_MAX_DELAY_MS);
  logAuthStage(`Запланирован повтор синка через ${delay}мс. Причина: ${reason}`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (!user || !isDirty || saving || authFlowInProgress || dataChoicePending) return;
    persist();
  }, delay);
}

function clearRetry() {
  retryAttempt = 0;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

async function persist() {
  if (saving) return;
  if (authFlowInProgress && !authInitTimedOut) {
    pendingSave = true;
    markPendingSync();
    return;
  }
  if (dataChoicePending) return;
  saving = true;
  saveInProgress = true;
  if (!user) {
    const localRes = saveGuestState(deviceId, activeArea, state);
    localSaveOk = !!localRes?.ok;
    setModeInfo(ui, { mode: "guest", user, cloudReady, localSaveOk });
    isDirty = !localRes?.ok;
    lastSaveOk = localRes?.ok || false;
    saving = false;
    saveInProgress = false;
    updateNetBadge();
    return { ok: !!localRes?.ok, mode: "guest" };
  }

  const localUserRes = saveUserStateLocal(user.id, activeArea, state);
  localSaveOk = !!localUserRes?.ok;
  const canAttemptRemote = cloudReady || authInitTimedOut;
  if (!canAttemptRemote) {
    mode = "local";
    setModeInfo(ui, { mode, user, cloudReady, localSaveOk });
    isDirty = !localSaveOk;
    lastSaveOk = localSaveOk;
    cloudBlockReason = cloudBlockReason || "cloud-not-ready";
    showSyncToastOnce("Не удалось синхронизировать. Проверьте вход и нажмите ‘Повторить’.");
    saving = false;
    saveInProgress = false;
    updateNetBadge();
    scheduleRetry(cloudBlockReason);
    return { ok: localSaveOk, mode: "local", reason: "cloud-not-ready" };
  }

  if (!cloudReady && authInitTimedOut) {
    logAuthStage("Cloud not ready after auth timeout: пытаемся сохранить в облако.");
  }

  const res = await saveRemoteState(supabase, user.id, activeArea, state);
  mode = "remote";
  setModeInfo(ui, { mode, user, cloudReady, localSaveOk });
  if (res.ok) {
    isDirty = false;
    lastSaveOk = true;
    cloudBlockReason = null;
    clearRetry();
  } else {
    isDirty = true;
    lastSaveOk = false;
    showOfflineNotice("Мы оффлайн, данные не сохранятся.");
    showSyncToastOnce("Не удалось синхронизировать. Проверьте вход и нажмите ‘Повторить’.");
    scheduleRetry(res.reason || "remote-save-failed");
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
    if (cloudBlockReason) {
      logAuthStage(`Cloud blocked: ${cloudBlockReason}`);
    }
    showSyncToastOnce("Не удалось синхронизировать. Проверьте вход и нажмите ‘Повторить’.");
  }
  updateNetBadge();
}

function updateNetBadge() {
  setOnlineBadge(ui, {
    isDirty,
    lastSaveOk,
    saveInProgress,
    localSaveOk,
    cloudReady,
    hasUser: !!user
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
  if (state?.mandatoryGoal?.title) return true;
  if (state?.mandatoryGoal?.metric) return true;
  if (state?.mandatoryGoal?.why) return true;
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

function pickLocalState(guestState, userLocalState) {
  const guestHas = hasMeaningfulState(guestState);
  const userHas = hasMeaningfulState(userLocalState);
  if (guestHas && userHas) {
    const guestLast = lastActionAt(guestState);
    const userLast = lastActionAt(userLocalState);
    if (userLast === guestLast) {
      return { state: guestState, source: "guest" };
    }
    return userLast > guestLast
      ? { state: userLocalState, source: "user" }
      : { state: guestState, source: "guest" };
  }
  if (guestHas) return { state: guestState, source: "guest" };
  if (userHas) return { state: userLocalState, source: "user" };
  return { state: null, source: "none" };
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
    mandatoryGoal: {
      title: String(normalized.mandatoryGoal?.title || ""),
      metric: String(normalized.mandatoryGoal?.metric || ""),
      why: String(normalized.mandatoryGoal?.why || ""),
      minStep: String(normalized.mandatoryGoal?.minStep || ""),
      createdAt: normalized.mandatoryGoal?.createdAt || null,
      updatedAt: normalized.mandatoryGoal?.updatedAt || null,
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

  sections.push(buildMandatoryGoalDiff(local, cloud));
  sections.push(buildGoalsDiff(local, cloud));
  sections.push(buildHistoryDiff(local, cloud));
  sections.push(buildActivityDiff(local, cloud));

  return sections.filter(section => section);
}

function buildMandatoryGoalDiff(local, cloud) {
  const localGoal = local.mandatoryGoal || {};
  const cloudGoal = cloud.mandatoryGoal || {};
  const fields = [
    { key: "title", label: "Цель" },
    { key: "metric", label: "Метрика" },
    { key: "why", label: "Почему важно" },
    { key: "minStep", label: "Минимальный шаг" },
  ];
  const diffs = fields
    .map((field) => {
      const localValue = String(localGoal[field.key] || "");
      const cloudValue = String(cloudGoal[field.key] || "");
      if (localValue === cloudValue) return null;
      return `${field.label}: облако “${cloudValue || "—"}” → локально “${localValue || "—"}”`;
    })
    .filter(Boolean);

  if (!diffs.length) return null;

  return {
    title: "Обязательная цель",
    items: diffs,
  };
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
      diffs.push({
        type: "text",
        label: "текст",
        from: other.text || "—",
        to: goal.text || "—",
      });
    }
    if (!!goal.isDaily !== !!other.isDaily) {
      diffs.push({
        type: "plain",
        label: "ежедневная",
        from: other.isDaily ? "да" : "нет",
        to: goal.isDaily ? "да" : "нет",
      });
    }
    if (!!goal.doneToday !== !!other.doneToday) {
      diffs.push({
        type: "plain",
        label: "выполнена сегодня",
        from: other.doneToday ? "да" : "нет",
        to: goal.doneToday ? "да" : "нет",
      });
    }
    if (diffs.length) {
      changed.push({
        type: "goal-change",
        title: `Изменено: ${goal.text || other.text || "Цель"}`,
        diffs,
      });
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



























