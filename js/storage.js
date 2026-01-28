import { APP, SUPABASE } from "./config.js";
import { defaultState, normalizeState, isExpired, markOpened, nowMs } from "./state.js";

export function clearLocal() {
  try { localStorage.removeItem(APP.LOCAL_KEY); } catch {}
}

/**
 * Стратегия "один источник правды":
 * - источник = Supabase
 *
 * Локальное хранилище не используется для состояния.
 */
export async function loadInitialState({ supabase }) {
  clearLocal();

  // 1) Если нет пользователя — дефолтное состояние (без локального кэша)
  const user = await getUserSafe(supabase);
  if (!user) {
    return { state: markOpened(defaultState()), mode: "offline", user: null };
  }

  // 2) Есть пользователь -> пробуем Supabase
  const remote = await loadRemoteSafe(supabase, user.id);
  if (!remote) {
    // если в БД пусто — создаём дефолт и сохраняем
    const fresh = markOpened(defaultState());
    await saveRemoteSafe(supabase, user.id, fresh);
    return { state: fresh, mode: "remote", user };
  }

  const r = normalizeState(remote.state);
  if (isExpired(r, APP.TTL_MS)) {
    const fresh = markOpened(defaultState());
    await saveRemoteSafe(supabase, user.id, fresh);
    return { state: fresh, mode: "remote", user };
  }

  return { state: markOpened(r), mode: "remote", user };
}

export async function saveState({ supabase, userId, state }) {
  if (!userId) return { ok: false, mode: "offline", reason: "no-user" };

  const ok = await saveRemoteSafe(supabase, userId, state);
  return { ok, mode: ok ? "remote" : "offline" };
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



