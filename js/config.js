export const APP = {
  VERSION: 1,
  LOCAL_KEY: "goal_state_v1",
  TTL_MS: 48 * 60 * 60 * 1000, // 48 часов
  DEBUG: true,
};

export const SUPABASE = {
  // Вставь свои значения:
  URL: "https://YOUR_PROJECT.supabase.co",
  ANON_KEY: "YOUR_ANON_KEY",
  TABLE: "goal_states",
};
