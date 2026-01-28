import { APP, SUPABASE } from "./config.js";
import { defaultState, normalizeState, isExpired, markOpened, nowMs } from "./state.js";

export function loadLocal() {
  try {
    const raw = localStorage.getItem(APP.LOCAL_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveLocal(state) {
  localStorage.setItem(APP.LOCAL_KEY, JSON.stringify(state));
}

export function clearLocal() {
  localStorage.removeItem(APP.LOCAL_KEY);
}

/**
 * Стратегия "один источник правды":
 * - до логина: источник = localStorage
 * - после логина: источник = Supabase (local остаётся кэшем/фолбэком)
 *
 * Fault tolerance: если Supabase недоступен — работаем локально.
 */
export async function loadInitialState({ supabase }) {
  // 1) Локально
  let local = normalizeState(loadLocal());

  // TTL: если долго не открывали — очищаем локальные данные
  if (local && isExpired(local, APP.TTL_MS)) {
    local = defaultState();
  }
  local = markOpened(local);
  saveLocal(local);

  // 2) Если нет пользователя — сразу возвращаем local
  const user = await getUserSafe(supabase);
  if (!user) {
    return { state: local, mode: "local", user: null };
  }

  // 3) Есть пользователь -> пробуем Supabase
  const remote = await loadRemoteSafe(supabase, user.id);
  if (!remote) {
    // если в БД пусто — зальём локальное как первичное
    await saveRemoteSafe(supabase, user.id, local);
    return { state: local, mode: "remote", user };
  }

  // 4) Конфликт: выбираем "новее" по updatedAt (если нет — по lastOpenAt)
  const r = normalizeState(remote.state);
  const remoteTs = remote.updated_at ? new Date(remote.updated_at).getTime() : (r.lastOpenAt || 0);
  const localTs = local.lastOpenAt || 0;

  const winner = (localTs > remoteTs) ? local : r;
  // если победил local — синхронизируем наверх
  if (winner === local) await saveRemoteSafe(supabase, user.id, local);

  // кэшируем победителя локально
  saveLocal(winner);

  return { state: winner, mode: "remote", user };
}

export async function saveState({ supabase, userId, state }) {
  // всегда сохраняем локально (чтобы не терять данные при сбое сети)
  saveLocal(state);

  if (!userId) return { ok: true, mode: "local" };

  // и пытаемся сохранить в облако
  const ok = await saveRemoteSafe(supabase, userId, state);
  return { ok, mode: ok ? "remote" : "local" };
}

async function getUserSafe(supabase) {
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error) return null;
    return data?.user || null;
  } catch {
    return null;
  }
}

async function loadRemoteSafe(supabase, userId) {
  try {
    const { data, error } = await supabase
      .from(SUPABASE.TABLE)
      .select("state, updated_at")
      .eq("user_id", userId)
      .maybeSingle();

    if (error) return null;
    return data || null;
  } catch {
    return null;
  }
}

async function saveRemoteSafe(supabase, userId, state) {
  try {
    const payload = {
      user_id: userId,
      state,
      updated_at: new Date(nowMs()).toISOString(),
    };
    const { error } = await supabase
      .from(SUPABASE.TABLE)
      .upsert(payload, { onConflict: "user_id" });

    return !error;
  } catch {
    return false;
  }
}

