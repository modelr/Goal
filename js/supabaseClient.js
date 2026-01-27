import { SUPABASE } from "./config.js";

export function createSupabaseClient() {
  if (!window.supabase) throw new Error("Supabase SDK not loaded");
  if (!SUPABASE.URL || !SUPABASE.ANON_KEY) throw new Error("Supabase config missing");
  return window.supabase.createClient(SUPABASE.URL, SUPABASE.ANON_KEY);
}
