import { createSupabaseClient } from "./supabaseClient.js";
import {
  defaultState, normalizeState, addGoal, deleteGoal,
  markOpened, completeGoal,
  lastActionAt, deleteHistoryEntry
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
  saveUserStateLocal
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
import { APP, AREAS } from "./config.js";

const ui = bindUI();
const supabase = safeCreateSupabase();
let state = null;
let user = null;
let mode = "guest";
let cloudReady = false;
let isDirty = false;
let lastSaveOk = null;
let localSaveOk = null;
let saveInProgress = false;
let commentModalGoalId = null;
let deleteGoalId = null;
let dataChoiceResolve = null;
let dataChoicePromise = null;
let mandatoryGoalReturnFocusEl = null;
let deleteGoalReturnFocusEl = null;
const THEME_KEY = "goal-theme";


const DEFAULT_AREA = "business";
const AUTH_STATUS_HIDE_DELAY_MS = 500;
let authListenerAttached = false;
let dataChoicePending = false;
let conflictResolving = false;
let syncInProgress = false;
let loginActionInProgress = false;
let activeArea = normalizeArea(loadActiveArea() || DEFAULT_AREA);
const deviceId = getDeviceId();
let saveTimer = null;

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
    connectAndCompare({ reason: "tab-visible" });
  });

  await connectAndCompare({ reason: "boot" });

  updateNetBadge();

  startHistorySizer(ui);
  window.addEventListener("resize", () => syncHistoryHeight(ui));

  if (supabase && !authListenerAttached) {
    authListenerAttached = true;
    supabase.auth.onAuthStateChange(async (event, session) => {
      setLoginLoading(false);
      if (event === "SIGNED_OUT") {
        handleSignedOut();
        return;
      }

      user = session?.user || null;
      syncLoginButtonLabel();
      const shouldInit = ["SIGNED_IN", "INITIAL_SESSION"].includes(event);
      if (shouldInit) {
        await connectAndCompare({ reason: `auth-change:${event}` });
        if (event === "SIGNED_IN") {
          toast(ui, "Вошли, данные синхронизированы");
        }
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
  const { error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });

  if (error) {
    toast(ui, "Ошибка входа: " + (error.message || String(error)));
  }

  history.replaceState(null, "", window.location.origin + window.location.pathname);
  return true;
}

async function connectAndCompare({ reason = "" } = {}) {
  if (!supabase) {
    if (!state) {
      loadGuestStateForArea();
    }
    cloudReady = false;
    syncLoginButtonLabel();
    setModeInfo(ui, { mode, user, cloudReady, localSaveOk });
    updateNetBadge();
    return;
  }
  if (syncInProgress) return;
  syncInProgress = true;
  setAuthStage(ui, { text: "Проверяем сессию…", visible: true, showRetry: false });
  updateNetBadge();

  try {
    await handleAuthRedirect();
    const sessionUser = await getSessionUser();
    user = sessionUser;
    cloudReady = !!user && navigator.onLine;
    syncLoginButtonLabel();

    if (user) {
      setAuthStage(ui, { text: "Загружаем данные…", visible: true, showRetry: false });
      await syncOnConnect();
      mode = "remote";
    } else {
      mode = "guest";
      loadGuestStateForArea();
    }
  } catch (err) {
    console.error(err);
  } finally {
    cloudReady = !!user && navigator.onLine;
    setModeInfo(ui, { mode, user, cloudReady, localSaveOk });
    updateNetBadge();
    if (state) {
      renderAll(ui, state);
      scrollToTop();
    }
    setTimeout(() => {
      setAuthStage(ui, { text: "Проверяем сессию…", visible: false });
    }, AUTH_STATUS_HIDE_DELAY_MS);
    syncInProgress = false;
  }
}

function handleSignedOut() {
  user = null;
  cloudReady = false;
  mode = "guest";
  dataChoicePending = false;
  isDirty = false;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  loadGuestStateForArea();
  syncLoginButtonLabel();
  setModeInfo(ui, { mode, user, cloudReady, localSaveOk });
  updateNetBadge();
  if (state) {
    renderAll(ui, state);
    scrollToTop();
  }
  setTimeout(() => {
    setAuthStage(ui, { text: "Проверяем сессию…", visible: false });
  }, AUTH_STATUS_HIDE_DELAY_MS);
}

function loadGuestStateForArea() {
  const guestRaw = loadGuestState(deviceId, activeArea);
  const guestState = guestRaw ? normalizeState(guestRaw) : defaultState();
  state = markOpened(normalizeState(guestState));
  mode = "guest";
  isDirty = false;
  localSaveOk = true;
  lastSaveOk = true;
}

async function syncOnConnect() {
  if (!user) return;
  const canUseCloud = navigator.onLine;
  const localRaw = loadUserStateLocal(user.id, activeArea);
  const localState = localRaw ? normalizeState(localRaw) : null;
  const remote = canUseCloud ? await loadRemoteState(supabase, user.id, activeArea) : null;
  const remoteState = remote?.state ? normalizeState(remote.state) : null;
  const localHas = hasMeaningfulState(localState);
  const remoteHas = hasMeaningfulState(remoteState);
  const hasDiff = canUseCloud && (localHas || remoteHas) && !statesEqual(localState, remoteState);

  if (hasDiff && !conflictResolving) {
    dataChoicePending = true;
    const diffSections = buildDiffSummary(localState, remoteState);
    renderDiffList(ui, diffSections);
    showDataChoiceModal(ui);
    const choice = await waitForDataChoice();
    hideDataChoiceModal(ui);
    dataChoicePending = false;
    await applyDataChoice({ choice, localState, remoteState });
    return;
  }

  const finalState = remoteHas
    ? remoteState
    : localHas
      ? localState
      : defaultState();
  state = markOpened(normalizeState(finalState));
  const localRes = saveUserStateLocal(user.id, activeArea, state, { skipGuard: true });
  localSaveOk = !!localRes?.ok;
  isDirty = !localSaveOk;
  lastSaveOk = localSaveOk;
}

async function switchArea(newArea) {
  const targetArea = normalizeArea(newArea);
  if (targetArea === activeArea) return;
  if (dataChoicePending || syncInProgress) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (isDirty || saveInProgress) {
    await persist();
  }

  setActiveArea(targetArea);
  toast(ui, `Переключаемся на: ${areaLabel(targetArea)}…`);

  if (user) {
    if (navigator.onLine) {
      await syncOnConnect();
    } else {
      const localRaw = loadUserStateLocal(user.id, targetArea);
      const nextState = localRaw ? normalizeState(localRaw) : defaultState();
      state = markOpened(normalizeState(nextState));
      localSaveOk = true;
      lastSaveOk = false;
      isDirty = false;
    }
    mode = "remote";
  } else {
    loadGuestStateForArea();
  }

  cloudReady = !!user && navigator.onLine;
  setModeInfo(ui, { mode, user, cloudReady, localSaveOk });
  updateNetBadge();
  renderAll(ui, state);
  scrollToTop();
}

function waitForDataChoice() {
  if (dataChoicePromise) return dataChoicePromise;
  dataChoicePromise = new Promise((resolve) => {
    if (dataChoiceResolve) {
      console.warn("[conflict] overriding dataChoiceResolve");
    }
    dataChoiceResolve = (choice) => {
      dataChoiceResolve = null;
      dataChoicePromise = null;
      resolve(choice);
    };
  });
  return dataChoicePromise;
}

function setConflictResolving(nextValue) {
  conflictResolving = nextValue;
}

function setDataChoiceButtonsState({ disabled, label } = {}) {
  const buttons = [ui.dataChoiceCloudBtn, ui.dataChoiceLocalBtn].filter(Boolean);
  buttons.forEach((btn) => {
    if (!btn.dataset.originalText) {
      btn.dataset.originalText = btn.textContent || "";
    }
    if (disabled && label) {
      btn.textContent = label;
    } else if (!disabled) {
      btn.textContent = btn.dataset.originalText;
    }
    btn.disabled = !!disabled;
  });
}

async function applyDataChoice({ choice, localState, remoteState }) {
  if (conflictResolving) return null;
  if (!choice) return null;
  const nextSource = choice === "cloud" ? remoteState : localState;
  if (!nextSource) return null;
  setConflictResolving(true);
  setDataChoiceButtonsState({ disabled: true, label: "Применяем…" });

  try {
    const nextState = markOpened(normalizeState(nextSource));
    state = nextState;
    const localRes = saveLocalSnapshot(nextState);
    localSaveOk = !!localRes?.ok;
    isDirty = !localSaveOk;
    lastSaveOk = localSaveOk;

    if (user && navigator.onLine) {
      const res = await saveRemoteState(supabase, user.id, activeArea, nextState, { skipGuard: true });
      lastSaveOk = res.ok;
      if (!res.ok) {
        isDirty = true;
      }
    } else if (user) {
      lastSaveOk = false;
    }

    return { ok: true, state };
  } finally {
    setConflictResolving(false);
    setDataChoiceButtonsState({ disabled: false });
  }
}

async function getSessionUser() {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) return null;
    return data?.session?.user || null;
  } catch (err) {
    console.warn("[auth] getSession failed:", err);
    return null;
  }
}

function wireEvents() {
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

    try {
      setLoginLoading(true, "⏳ Проверяем…");
      setAuthStage(ui, { text: "Проверяем сессию…", visible: true });

      const { data, error } = await supabase.auth.getUser();
      const isNoSession =
        error?.name === "AuthSessionMissingError" ||
        /auth session missing/i.test(error?.message || "");
      if (error && !isNoSession) {
        throw error;
      }

      const authUser = error ? null : data?.user || null;
      const isLoggedIn = !!authUser;

      setLoginLoading(true, isLoggedIn ? "⏳ Выходим…" : "⏳ Входим…");

      if (isLoggedIn) {
        const { error: signOutError } = await supabase.auth.signOut();
        if (signOutError) {
          throw signOutError;
        }
        handleSignedOut();
        return;
      }

      const redirectTo = window.location.origin + window.location.pathname;
      const { error: signInError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo },
      });
      if (signInError) {
        throw signInError;
      }
    } catch (err) {
      console.warn("[auth] login action failed:", err);
      toast(ui, "Ошибка входа. Повторите попытку.");
    } finally {
      loginActionInProgress = false;
      setLoginLoading(false);
      setTimeout(() => {
        setAuthStage(ui, { text: "Проверяем сессию…", visible: false });
      }, AUTH_STATUS_HIDE_DELAY_MS);
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
      if (conflictResolving) return;
      if (dataChoiceResolve) {
        dataChoiceResolve("cloud");
      }
    });
  }
  if (ui.dataChoiceLocalBtn) {
    ui.dataChoiceLocalBtn.addEventListener("click", () => {
      if (conflictResolving) return;
      if (dataChoiceResolve) {
        dataChoiceResolve("local");
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

function saveLocalSnapshot(nextState) {
  if (user) {
    return saveUserStateLocal(user.id, activeArea, nextState, { skipGuard: true });
  }
  return saveGuestState(deviceId, activeArea, nextState, { skipGuard: true });
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

function scheduleSave() {
  if (dataChoicePending) return;
  isDirty = true;
  updateNetBadge();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persist(), 350);
}

async function persist() {
  if (saveInProgress) return;
  if (dataChoicePending) return;
  saveInProgress = true;
  updateNetBadge();

  const snapshot = markOpened(normalizeState(state));
  state = snapshot;

  const localRes = saveLocalSnapshot(snapshot);
  localSaveOk = !!localRes?.ok;
  isDirty = !localSaveOk;

  if (user && navigator.onLine) {
    const res = await saveRemoteState(supabase, user.id, activeArea, snapshot);
    lastSaveOk = res.ok;
    if (!res.ok) {
      isDirty = true;
    }
  } else if (user) {
    lastSaveOk = false;
  } else {
    lastSaveOk = localSaveOk;
  }

  cloudReady = !!user && navigator.onLine;
  setModeInfo(ui, { mode, user, cloudReady, localSaveOk });
  saveInProgress = false;
  updateNetBadge();
  return { ok: lastSaveOk, localOk: localSaveOk };
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

