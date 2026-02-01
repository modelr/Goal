import { SUPABASE } from "./config.js";

export function createSupabaseClient() {
  if (!window.supabase) throw new Error("Supabase SDK not loaded");

  const url = SUPABASE.URL || "";
  const key = SUPABASE.ANON_KEY || "";

  // режем кейс "заглушки", чтобы не было Failed to fetch
  if (
    !url.startsWith("http") ||
    url.includes("YOUR_PROJECT") ||
    !key ||
    key === "YOUR_ANON_KEY" ||
    key.length < 20
  ) {
    throw new Error("Supabase не настроен (URL/KEY)");
  }

  return window.supabase.createClient(url, key, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
    },
  });
}

