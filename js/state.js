import { APP } from "./config.js";

export function nowMs() { return Date.now(); }

export function defaultState() {
  return {
    v: APP.VERSION,
    lastOpenAt: nowMs(),
    mandatoryGoal: {
      title: "",
      metric: "",
      why: "",
      minStep: "",
      createdAt: null,
      updatedAt: null,
    },
    dailyGoals: [{ id: uid(), text: "", doneToday: false, isDaily: false }],
    todayNote: "",
    // история: массив записей␊
    history: [], // {ts, type, payload}
  };
}

export function normalizeState(s) {
  const base = defaultState();
  const out = { ...base, ...(s || {}) };
  out.lastOpenAt = typeof out.lastOpenAt === "number" ? out.lastOpenAt : nowMs();

  // mandatory goal (with migration from stake)
  out.mandatoryGoal = { ...base.mandatoryGoal, ...(out.mandatoryGoal || {}) };
  const mandatoryHasData = Boolean(
    String(out.mandatoryGoal.title || "").trim() ||
    String(out.mandatoryGoal.metric || "").trim() ||
    String(out.mandatoryGoal.why || "").trim() ||
    String(out.mandatoryGoal.minStep || "").trim()
  );
  if (!mandatoryHasData && out.stake?.text) {
    out.mandatoryGoal = {
      ...out.mandatoryGoal,
      title: String(out.stake.text || ""),
      createdAt: out.stake.createdAt || nowMs(),
      updatedAt: out.stake.createdAt || nowMs(),
    };
  }
  out.mandatoryGoal.title = String(out.mandatoryGoal.title ?? "");
  out.mandatoryGoal.metric = String(out.mandatoryGoal.metric ?? "");
  out.mandatoryGoal.why = String(out.mandatoryGoal.why ?? "");
  out.mandatoryGoal.minStep = String(out.mandatoryGoal.minStep ?? "");
  if (mandatoryHasData && !out.mandatoryGoal.createdAt) out.mandatoryGoal.createdAt = nowMs();
  if (!out.mandatoryGoal.updatedAt && out.mandatoryGoal.createdAt) {
    out.mandatoryGoal.updatedAt = out.mandatoryGoal.createdAt;
  }

  // dailyGoals: по дефолту одна
   if (!Array.isArray(out.dailyGoals) || out.dailyGoals.length === 0) {
    out.dailyGoals = [{ id: uid(), text: "", doneToday: false, isDaily: false }];
  } else {
    out.dailyGoals = out.dailyGoals.map(g => ({
      id: g?.id || uid(),
      text: String(g?.text ?? ""),
      doneToday: !!g?.doneToday,
      isDaily: !!g?.isDaily,
    }));
  }

  out.todayNote = String(out.todayNote ?? "");
  out.history = Array.isArray(out.history) ? out.history : [];

  return out;
}

export function uid() {
  return Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
}

export function historyKey(entry) {
  const payload = entry?.payload || {};
  return [
    entry?.ts || "",
    entry?.type || "",
    payload.goalId || "",
    payload.text || "",
    payload.note || "",
  ].join("|");
}

export function deleteHistoryEntry(s, key) {
  const history = Array.isArray(s?.history) ? [...s.history] : [];
  const index = history.findIndex(entry => historyKey(entry) === key);
  if (index === -1) return s;
  history.splice(index, 1);
  return { ...s, history };
}

export function lastActionAt(s) {
  const history = Array.isArray(s?.history) ? s.history : [];
  if (history.length === 0) return s?.lastOpenAt || nowMs();
  const lastHistoryTs = history
    .filter(entry => entry?.type !== "delete_goal")
    .reduce((max, entry) => Math.max(max, entry?.ts || 0), 0);
  return lastHistoryTs || s?.lastOpenAt || nowMs();
}

export function isExpired(state, ttlMs) {
  return nowMs() - lastActionAt(state) > ttlMs;
}

export function markOpened(s) {
  return { ...s, lastOpenAt: nowMs() };
}

export function addGoal(s) {
  const goals = [...s.dailyGoals, { id: uid(), text: "", doneToday: false, isDaily: false }];
  return { ...s, dailyGoals: goals };
}

export function deleteGoal(s, goalId) {
  const g = s.dailyGoals.find(x => x.id === goalId);
  const goals = s.dailyGoals.filter(x => x.id !== goalId);
  const wasDoneToday = !!g?.doneToday;

  // Важное: удаление уходит в историю
  const history = [{
    ts: nowMs(),
    type: wasDoneToday ? "done_goal" : "delete_goal",
    payload: { text: g?.text || "", goalId }
  }, ...s.history];

  return { ...s, dailyGoals: goals.length ? goals : [{ id: uid(), text: "", doneToday: false, isDaily: false }], history };
}

export function completeGoal(s, goalId, { comment = "", keepGoal = false } = {}) {
  const g = s.dailyGoals.find(x => x.id === goalId);
  if (!g) return s;
  const entry = {
    ts: nowMs(),
    type: "done_goal",
    payload: {
      text: g.text || "",
      goalId,
      comment: String(comment ?? ""),
      isDaily: !!g.isDaily,
    },
  };

  let goals = s.dailyGoals;
  if (keepGoal) {
    goals = s.dailyGoals.map(goal => (
      goal.id === goalId ? { ...goal, doneToday: true } : goal
    ));
  } else {
    goals = s.dailyGoals.filter(goal => goal.id !== goalId);
    if (!goals.length) {
      goals = [{ id: uid(), text: "", doneToday: false, isDaily: false }];
    }
  }

  return { ...s, dailyGoals: goals, history: [entry, ...s.history] };
}

export function addHistorySave(s, options = {}) {
  const focusGoal = String(options.focusGoal || "");
  const entry = {
    ts: nowMs(),
    type: "save",
    payload: {
      note: s.todayNote || "",
      focusGoal,
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

  const todayKey = dayKey(Date.now());
  const todayCounted = map.has(todayKey);

  let streak = 0;
  const cur = new Date();

  // если сегодня не засчитан — начинаем с вчера
  if (!todayCounted) cur.setDate(cur.getDate() - 1);

  while (map.has(dayKey(cur.getTime()))) {
    streak++;
    cur.setDate(cur.getDate() - 1);
  }

  return { streak, todayCounted };
}














