import { SUPABASE } from "./config.js";
import { nowMs } from "./state.js";

const ACTIVE_AREA_KEY = "goal_active_area";
const LOCAL_KEY_PREFIX = "goal_local_";
const BACKUP_INDEX_PREFIX = "goal_backup_index_";
const REMOTE_TIMEOUT_MS = 8000;

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

export function loadActiveArea() {
  try {
    return localStorage.getItem(ACTIVE_AREA_KEY);
  } catch {
    return null;
  }
}

export function saveActiveArea(area) {
  try {
    localStorage.setItem(ACTIVE_AREA_KEY, area);
  } catch {}
}

export function localStorageKey(area) {
  return `${LOCAL_KEY_PREFIX}${area}`;
}

export function loadLocalStateForArea(area) {
  return loadLocalState(localStorageKey(area));
}

export function saveLocalStateForArea(area, state, options = {}) {
  return saveLocalState(localStorageKey(area), state, options);
}

export async function loadRemoteState(supabase, userId, area) {
  if (!supabase || !userId || !area) return null;

  const controller = new AbortController();

  try {
    let q = supabase
      .from(SUPABASE.TABLE)
      .select("state, updated_at")
      .eq("user_id", userId)
      .eq("area", area)
      .maybeSingle();

    // abortSignal есть не во всех сборках/версиях
    if (typeof q.abortSignal === "function") {
      q = q.abortSignal(controller.signal);
    }

    // Гарантируем, что промис не "повиснет" даже если abortSignal не поддерживается
    const { data, error } = await withTimeout(
      q,
      REMOTE_TIMEOUT_MS,
      `[storage] Remote load timed out after ${REMOTE_TIMEOUT_MS}ms.`
    ).catch((err) => {
      // пробуем прервать fetch, если поддерживается
      try { controller.abort(); } catch {}
      throw err;
    });

    if (error) return null;
    return data ?? null;
  } catch (err) {
    if (err?.name === "AbortError") {
      console.warn(err?.message || `[storage] Remote load timed out after ${REMOTE_TIMEOUT_MS}ms.`);
      return null;
    }
    console.warn("[storage] Remote load failed:", err);
    return null;
  }
}

export async function saveRemoteState(supabase, userId, area, state, options = {}) {
  if (!supabase || !userId || !area) return { ok: false, reason: "no-user" };

  const cached = loadLocalStateForArea(area);
  if (!options.skipGuard && shouldBlockEmptySave(state, cached)) {
    console.warn("[storage] Skip remote save: empty state would overwrite non-empty cache.");
    return { ok: false, reason: "empty-guard" };
  }

  const controller = new AbortController();

  try {
    const payload = {
      user_id: userId,
      area,
      state,
      updated_at: new Date(nowMs()).toISOString(),
    };

    let q = supabase
      .from(SUPABASE.TABLE)
      .upsert(payload, { onConflict: "user_id,area" });

    if (typeof q.abortSignal === "function") {
      q = q.abortSignal(controller.signal);
    }

    const { error } = await withTimeout(
      q,
      REMOTE_TIMEOUT_MS,
      `[storage] Remote save timed out after ${REMOTE_TIMEOUT_MS}ms.`
    ).catch((err) => {
      try { controller.abort(); } catch {}
      throw err;
    });

    if (error) return { ok: false, reason: "remote-error" };
    return { ok: true, reason: null };
  } catch (err) {
    if (err?.name === "AbortError") {
      console.warn(err?.message || `[storage] Remote save timed out after ${REMOTE_TIMEOUT_MS}ms.`);
      return { ok: false, reason: "timeout" };
    }
    console.warn("[storage] Remote save failed:", err);
    return { ok: false, reason: "network" };
  }
}

export function backupState(scope, state) {
  if (!state || !scope) return null;
  const key = `goal_backup_${scope}_${Date.now()}`;
  try {
    localStorage.setItem(key, JSON.stringify({ state, createdAt: nowMs() }));
  } catch (err) {
    console.warn("[storage] Failed to create backup:", err);
    return null;
  }

  const indexKey = `${BACKUP_INDEX_PREFIX}${scope}`;
  const index = loadBackupIndex(indexKey);
  index.push(key);
  while (index.length > 2) {
    const oldest = index.shift();
    if (oldest) {
      try { localStorage.removeItem(oldest); } catch {}
    }
  }
  try {
    localStorage.setItem(indexKey, JSON.stringify(index));
  } catch {}
  return key;
}

function loadBackupIndex(indexKey) {
  try {
    const raw = localStorage.getItem(indexKey);
    const parsed = JSON.parse(raw || "[]");
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    return [];
  }
}

function loadLocalState(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed || null;
  } catch {
    return null;
  }
}

function saveLocalState(key, state, options = {}) {
  if (!key) return { ok: false, reason: "no-key" };
  const existing = loadLocalState(key);
  if (!options.skipGuard && shouldBlockEmptySave(state, existing)) {
    console.warn("[storage] Skip save: empty state would overwrite non-empty storage.", { key });
    return { ok: false, reason: "empty-guard" };
  }
  try {
    localStorage.setItem(key, JSON.stringify(state));
    return { ok: true };
  } catch (err) {
    console.warn("[storage] Failed to save state:", err);
    return { ok: false, reason: "storage-error" };
  }
}

function shouldBlockEmptySave(newState, existingState) {
  return !isMeaningfulState(newState) && isMeaningfulState(existingState);
}

function isMeaningfulState(state) {
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






