import { SUPABASE } from "./config.js";
import { nowMs } from "./state.js";

const DEVICE_KEY = "mr_device_id";
const GUEST_KEY_PREFIX = "goal_guest_";
const USER_KEY_PREFIX = "goal_user_";
const BACKUP_INDEX_PREFIX = "goal_backup_index_";
const REMOTE_TIMEOUT_MS = 8000;

export function getDeviceId() {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const uuid = typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
    localStorage.setItem(DEVICE_KEY, uuid);
    return uuid;
  } catch {
    return `${Math.random().toString(16).slice(2)}-${Date.now().toString(16)}`;
  }
}

export function guestStorageKey(deviceId) {
  return `${GUEST_KEY_PREFIX}${deviceId}`;
}

export function userStorageKey(userId) {
  return `${USER_KEY_PREFIX}${userId}`;
}

export function loadGuestState(deviceId) {
  return loadLocalState(guestStorageKey(deviceId));
}

export function loadUserStateLocal(userId) {
  return loadLocalState(userStorageKey(userId));
}

export function saveGuestState(deviceId, state, options = {}) {
  return saveLocalState(guestStorageKey(deviceId), state, options);
}

export function saveUserStateLocal(userId, state, options = {}) {
  return saveLocalState(userStorageKey(userId), state, options);
}

export async function loadRemoteState(supabase, userId) {
  if (!supabase || !userId) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
  try {
    const { data, error } = await supabase
      .from(SUPABASE.TABLE)
      .select("state, updated_at")
      .eq("user_id", userId)
      .maybeSingle()
      .abortSignal(controller.signal);

    if (error) {
      if (error?.name === "AbortError") {
        console.warn(`[storage] Remote load timed out after ${REMOTE_TIMEOUT_MS}ms.`);
      }
      return null;
    }
    return data || null;
  } catch (err) {
    if (err?.name === "AbortError") {
      console.warn(`[storage] Remote load timed out after ${REMOTE_TIMEOUT_MS}ms.`);
      return null;
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function saveRemoteState(supabase, userId, state, options = {}) {
  if (!supabase || !userId) return { ok: false, reason: "no-user" };
  const cached = loadUserStateLocal(userId);
  if (!options.skipGuard && shouldBlockEmptySave(state, cached)) {
    console.warn("[storage] Skip remote save: empty state would overwrite non-empty cache.");
    return { ok: false, reason: "empty-guard" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
  try {
    const payload = {
      user_id: userId,
      state,
      updated_at: new Date(nowMs()).toISOString(),
    };
    const { error } = await supabase
      .from(SUPABASE.TABLE)
      .upsert(payload, { onConflict: "user_id" })
      .abortSignal(controller.signal);

    if (error?.name === "AbortError") {
      console.warn(`[storage] Remote save timed out after ${REMOTE_TIMEOUT_MS}ms.`);
      return { ok: false, reason: "timeout" };
    }
    return { ok: !error, reason: error ? "remote-error" : null };
  } catch (err) {
    if (err?.name === "AbortError") {
      console.warn(`[storage] Remote save timed out after ${REMOTE_TIMEOUT_MS}ms.`);
      return { ok: false, reason: "timeout" };
    }
    return { ok: false, reason: "network" };
  } finally {
    clearTimeout(timer);
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



