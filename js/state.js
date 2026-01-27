import { APP } from "./config.js";

export function nowMs() { return Date.now(); }

export function defaultState() {
  return {
    v: APP.VERSION,
    lastOpenAt: nowMs(),
    stake: { text: "", done: false, createdAt: null, doneAt: null },
    dailyGoals: [{ id: uid(), text: "", doneToday: false }],
    todayNote: "",
    // история: массив записей
    history: [], // {ts, type, payload}
  };
}

export function normalizeState(s) {
  const base = defaultState();
  const out = { ...base, ...(s || {}) };
  out.lastOpenAt = typeof out.lastOpenAt === "number" ? out.lastOpenAt : nowMs();

  // stake
  out.stake = { ...base.stake, ...(out.stake || {}) };

  // dailyGoals: по дефолту одна
  if (!Array.isArray(out.dailyGoals) || out.dailyGoals.length === 0) {
    out.dailyGoals = [{ id: uid(), text: "", doneToday: false }];
  } else {
    out.dailyGoals = out.dailyGoals.map(g => ({
      id: g?.id || uid(),
      text: String(g?.text ?? ""),
      doneToday: !!g?.doneToday,
    }));
  }

  out.todayNote = String(out.todayNote ?? "");
  out.history = Array.isArray(out.history) ? out.history : [];

  return out;
}

export function uid() {
  return Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
}

export function isExpired(lastOpenAt, ttlMs) {
  return nowMs() - (lastOpenAt || 0) > ttlMs;
}

export function markOpened(s) {
  return { ...s, lastOpenAt: nowMs() };
}

export function addGoal(s) {
  const goals = [...s.dailyGoals, { id: uid(), text: "", doneToday: false }];
  return { ...s, dailyGoals: goals };
}

export function deleteGoal(s, goalId) {
  const g = s.dailyGoals.find(x => x.id === goalId);
  const goals = s.dailyGoals.filter(x => x.id !== goalId);

  // Важное: удаление уходит в историю
  const history = [{
    ts: nowMs(),
    type: "delete_goal",
    payload: { text: g?.text || "", goalId }
  }, ...s.history];

  return { ...s, dailyGoals: goals.length ? goals : [{ id: uid(), text: "", doneToday: false }], history };
}

export function computeProgress(s) {
  const total = s.dailyGoals.length;
  const done = s.dailyGoals.filter(g => g.doneToday).length;
  return { done, total, pct: total ? Math.round((done/total)*100) : 0 };
}

export function addHistorySave(s) {
  const prog = computeProgress(s);
  const entry = {
    ts: nowMs(),
    type: "save",
    payload: {
      stake: s.stake?.text || "",
      stakeDone: !!s.stake?.done,
      done: prog.done,
      total: prog.total,
      note: s.todayNote || "",
      goals: s.dailyGoals.map(g => ({ text: g.text || "", doneToday: !!g.doneToday })),
    }
  };
  return { ...s, history: [entry, ...s.history] };
}

export function daysMapFromHistory(history) {
  // засчитываем день, если есть ЛЮБАЯ запись в этот день
  const map = new Set();
  for (const e of (history || [])) {
    const d = dayKey(e.ts);
    map.add(d);
  }
  return map;
}

export function dayKey(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const da = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${da}`;
}

export function computeStreak(history) {
  const map = daysMapFromHistory(history);
  let streak = 0;
  let cur = new Date();
  // считаем подряд назад
  while (true) {
    const key = dayKey(cur.getTime());
    if (!map.has(key)) break;
    streak++;
    cur.setDate(cur.getDate()-1);
  }
  return { streak, todayCounted: map.has(dayKey(Date.now())) };
}
