export const APP = {
  VERSION: 1,
  LOCAL_KEY: "goal_app_v4_cache", // <-- как в одностраничнике
  TTL_MS: 36 * 60 * 60 * 1000,
  DEBUG: true,
};

export const AREAS = [
  { id: "business", label: "Финансы" },
  { id: "health", label: "Здоровье" },
  { id: "relationships", label: "Отношения" },
];

export const SUPABASE = {
  URL: "https://uivsrhkdlybqyvwkdbwr.supabase.co",
  ANON_KEY: "sb_publishable_wetDio_DGN89fiXTYx8heQ_mRCdfWgX",
  TABLE: "goal_state", // важно: имя должно совпадать с реальной таблицей в Supabase
};
