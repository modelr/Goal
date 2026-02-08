import { dayKey } from "./state.js";

const EXPORT_WARNING_THRESHOLD = 2000;
const CLEANUP_FALLBACK_MS = 60000;

const FILTER_OPTIONS = [
  { id: "all", label: "Все" },
  { id: "7", label: "7 дней" },
  { id: "30", label: "30 дней" },
  { id: "range", label: "Диапазон (с/по)" },
];

export function initHistoryExport({
  ui,
  getState,
  getActiveArea,
  getAreaLabel,
  toast,
}) {
  if (!ui?.historyPdfBtn) return;

  const modal = createExportModal();
  const modalState = bindModal(modal, toast);

  ui.historyPdfBtn.addEventListener("click", () => {
    modalState.open();
  });

  modalState.onConfirm(async ({ filterId, fromDate, toDate }) => {
    const state = getState() || {};
    const rawHistory = state.history;
    const history = Array.isArray(rawHistory) ? rawHistory : [];

    let filtered = history;
    if (history.length) {
      filtered = applyHistoryFilter(history, {
        filterId,
        fromDate,
        toDate,
      });

      if (!filtered.length) {
        toast("Нет записей за выбранный период.");
        return;
      }

      if (filtered.length > EXPORT_WARNING_THRESHOLD) {
        toast("Экспорт может занять время.");
      }
    }

    const areaId = getActiveArea();
    const areaLabel = getAreaLabel(areaId);
    const generatedAt = formatDateTime(new Date());
    const mandatoryGoal = state.mandatoryGoal || {};
    const principles = state.principles?.items || [];
    const html = buildHistoryPdfHtml(filtered, {
      areaId,
      areaLabel,
      generatedAt,
      mandatoryGoal,
      principles,
      summaryHistory: history,
    });

    openHistoryPdf(html, toast);
  });
}

function applyHistoryFilter(history, { filterId, fromDate, toDate }) {
  const sorted = [...history].sort((a, b) => (a?.ts || 0) - (b?.ts || 0));
  if (filterId === "all") return sorted;

  const now = new Date();
  let rangeStart = null;
  let rangeEnd = null;

  if (filterId === "7") {
    const start = startOfDay(addDays(now, -6));
    rangeStart = start;
    rangeEnd = endOfDay(now);
  }

  if (filterId === "30") {
    const start = startOfDay(addDays(now, -29));
    rangeStart = start;
    rangeEnd = endOfDay(now);
  }

  if (filterId === "range") {
    if (!fromDate || !toDate) {
      return [];
    }
    rangeStart = startOfDay(fromDate);
    rangeEnd = endOfDay(toDate);
  }

  if (!rangeStart || !rangeEnd) return [];

  const startMs = rangeStart.getTime();
  const endMs = rangeEnd.getTime();

  if (startMs > endMs) return [];

  return sorted.filter((entry) => {
    const ts = entry?.ts || 0;
    return ts >= startMs && ts <= endMs;
  });
}

function buildHistoryPdfHtml(history, {
  areaId,
  areaLabel,
  generatedAt,
  mandatoryGoal,
  principles,
  summaryHistory,
}) {
  const groups = groupHistory(history);
  const dayKeys = Object.keys(groups).sort((a, b) => b.localeCompare(a));
  const total = history.length;
  const summary = getHistorySummary(summaryHistory || history);
  const sections = dayKeys.map((key) => renderDaySection(key, groups[key])).join("");

  return `
    <!doctype html>
    <html lang="ru">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>История проекта — PDF</title>
      <style>
        :root { color-scheme: light; }
        body { font-family: "Inter", "Segoe UI", system-ui, sans-serif; margin: 32px; color: #111827; }
        h1 { margin: 0 0 8px; font-size: 24px; }
        .meta { color: #6b7280; margin-bottom: 24px; }
        .metaRow { margin-bottom: 6px; }
        .sectionTitle { font-size: 20px; text-transform: none; letter-spacing: .08em; color: #6b7280; margin: 0 0 12px; }
        .section { margin-bottom: 24px; }
        .sectionContent { margin: 0; }
        .sectionContent + .sectionContent { margin-top: 8px; }
        .goalLabel { font-weight: 600; margin-right: 6px; }
        .summary { padding: 12px 14px; border: 1px solid #d1d5db; border-radius: 10px; background: #f9fafb; font-size: 18px; font-weight: 600; margin-bottom: 28px; }
        .historyTitle { margin-top: 8px; }
        .day { margin-bottom: 28px; }
        .day h2 { font-size: 14px; text-transform: uppercase; letter-spacing: normal; color: #inherit; margin: 0 0 12px; }
        .card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 12px 14px; margin-bottom: 10px; }
        .time { font-weight: 600; margin-bottom: 6px; }
        ul { margin: 0; padding-left: 18px; }
        li { margin-bottom: 6px; white-space: pre-line; }
        li:last-child { margin-bottom: 0; }
        .label { font-weight: 600; color: #4f46e5; margin-right: 6px; }
        .avoidBreak { break-inside: avoid; page-break-inside: avoid; }
        .noOrphan { break-after: avoid; page-break-after: avoid; }
        @media print { body { margin: 12mm; } }
      </style>
    </head>
    <body>
      <h1>История проекта</h1>
      <div class="meta">
        <div class="metaRow">Сфера: ${escapeHtml(areaLabel)} (${escapeHtml(areaId)})</div>
        <div class="metaRow">Сформировано: ${escapeHtml(generatedAt)}</div>
        <div class="metaRow">Записей в выгрузке: ${escapeHtml(total)}</div>
      </div>
      ${renderGoalSection(mandatoryGoal)}
      ${renderPrinciplesSection(principles)}
      ${renderSummary(summary)}
      <h2 class="sectionTitle historyTitle noOrphan">История</h2>
      ${sections}
      <script>
        window.addEventListener("load", () => {
          setTimeout(() => window.print(), 300);
        });
      </script>
    </body>
    </html>
  `;
}

function renderGoalSection(mandatoryGoal) {
  const title = String(mandatoryGoal?.title || "").trim();
  const metric = firstNonEmpty([
    mandatoryGoal?.metric,
    mandatoryGoal?.result,
    mandatoryGoal?.outcome,
    mandatoryGoal?.target,
  ]);
  const why = String(mandatoryGoal?.why || "").trim();
  const minStep = String(mandatoryGoal?.minStep || "").trim();
  const rows = [];

  if (title) {
    rows.push(`<p class="sectionContent">${escapeHtml(title)}</p>`);
  }
  if (metric) {
    rows.push(`<p class="sectionContent"><span class="goalLabel">Результат:</span>${escapeHtml(metric)}</p>`);
  }
  if (why) {
    rows.push(`<p class="sectionContent"><span class="goalLabel">Почему важно:</span>${escapeHtml(why)}</p>`);
  }
  if (minStep) {
    rows.push(`<p class="sectionContent"><span class="goalLabel">Минимальный шаг:</span>${escapeHtml(minStep)}</p>`);
  }

  const body = rows.length
    ? rows.join("")
    : `<p class="sectionContent">Цель не заполнена.</p>`;

  return `
    <section class="section avoidBreak">
      <h2 class="sectionTitle noOrphan">Моя цель</h2>
      ${body}
    </section>
  `;
}

function renderPrinciplesSection(principles) {
  const items = normalizePrinciples(principles);
  const body = items.length
    ? `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
    : `<p class="sectionContent">Принципы не заполнены.</p>`;

  return `
    <section class="section avoidBreak">
      <h2 class="sectionTitle noOrphan">Принципы</h2>
      ${body}
    </section>
  `;
}

function renderSummary(summary) {
  return `
    <div class="summary avoidBreak">
      Для достижения цели понадобилось ${escapeHtml(summary.days)} дней и выполнено ${escapeHtml(summary.completed)} задач
    </div>
  `;
}

function normalizePrinciples(principles) {
  if (!Array.isArray(principles)) return [];
  return principles
    .map((item) => {
      if (typeof item === "string") return item;
      if (item?.text) return String(item.text);
      return "";
    })
    .map((item) => item.trim())
    .filter(Boolean);
}

function firstNonEmpty(values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function groupHistory(history) {
  const sorted = [...history].sort((a, b) => (a?.ts || 0) - (b?.ts || 0));
  return sorted.reduce((acc, entry) => {
    const ts = typeof entry?.ts === "number" ? entry.ts : null;
    if (ts === null) return acc;
    const key = dayKey(ts);
    if (!acc[key]) acc[key] = [];
    acc[key].push(entry);
    return acc;
  }, {});
}

function renderDaySection(dayKeyValue, entries) {
  const title = formatDateFromKey(dayKeyValue);
  const cards = entries.map((entry) => renderEntry(entry)).join("");
  return `
    <section class="day">
      <h2>${escapeHtml(title)}</h2>
      ${cards}
    </section>
  `;
}

function getHistorySummary(history) {
  if (!Array.isArray(history) || !history.length) {
    return { days: 0, completed: 0 };
  }

  let minTs = Infinity;
  let maxTs = -Infinity;
  let completed = 0;

  for (const entry of history) {
    const ts = typeof entry?.ts === "number" ? entry.ts : null;
    if (ts !== null) {
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
    }
    if (entry?.type === "done_goal") {
      completed += 1;
    }
  }

  if (!Number.isFinite(minTs) || !Number.isFinite(maxTs)) {
    return { days: 0, completed };
  }

  const start = startOfDay(new Date(minTs)).getTime();
  const end = startOfDay(new Date(maxTs)).getTime();
  const diffDays = Math.floor((end - start) / 86400000);
  return { days: diffDays + 1, completed };
}

function renderEntry(entry) {
  const time = formatTime(new Date(entry.ts));
  const lines = buildEntryLines(entry);
  const linesHtml = lines
    .map((line) => `<li><span class="label">${escapeHtml(line.label)}</span> ${escapeHtml(line.text)}</li>`)
    .join("");

  return `
    <div class="card">
      <div class="time">${escapeHtml(time)}</div>
      <ul>${linesHtml}</ul>
    </div>
  `;
}

function buildEntryLines(entry) {
  if (entry.type === "delete_goal") {
    return [{ label: "Удалена цель:", text: `«${entry.payload?.text || ""}»` }];
  }
  if (entry.type === "done_goal") {
    const text = entry.payload?.text || "";
    const comment = entry.payload?.comment || "";
    const isDaily = !!entry.payload?.isDaily;
    const statusLabel = (entry.payload?.statusLabel || "").trim();
    const label = statusLabel || (isDaily ? "Сделана ежедневная цель" : "Сделана цель");
    const lines = [{ label: `${label}:`, text: `«${text}»` }];
    if (comment) {
      lines.push({ label: "Комментарий:", text: comment });
    }
    return lines;
  }
  if (entry.type === "save") {
    const lines = [];
    if (entry.payload?.focusGoal) {
      lines.push({ label: "Задача:", text: entry.payload.focusGoal });
    }
    if (entry.payload?.note) {
      lines.push({ label: "Сделано сегодня:", text: entry.payload.note });
    }
    return lines.length ? lines : [{ label: "Сохранение:", text: "—" }];
  }
  if (entry.type === "save_principles") {
    const items = Array.isArray(entry.payload?.items) ? entry.payload.items : [];
    const text = items.length ? items.map(item => `- ${item}`).join("\n") : "—";
    return [{ label: "Принципы:", text }];
  }
  return [{ label: "Неизвестное событие:", text: entry.type || "—" }];
}

function openHistoryPdf(html, toast) {
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const pdfWindow = window.open(url, "_blank", "noopener");

  if (!pdfWindow) {
    toast("Разрешите всплывающие окна.");
    URL.revokeObjectURL(url);
    return;
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    URL.revokeObjectURL(url);
    clearTimeout(cleanupTimer);
    clearInterval(pollTimer);
  };

  const cleanupTimer = setTimeout(() => {
    cleanup();
  }, CLEANUP_FALLBACK_MS);

  const pollTimer = setInterval(() => {
    try {
      if (pdfWindow.closed) {
        cleanup();
      }
    } catch (err) {
      cleanup();
    }
  }, 1000);

  pdfWindow.addEventListener("afterprint", cleanup);
  pdfWindow.addEventListener("beforeunload", cleanup);
  pdfWindow.addEventListener("unload", cleanup);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDateTime(date) {
  return `${formatDate(date)} ${formatTime(date)}`;
}

function formatDate(date) {
  const d = typeof date === "string" ? new Date(date) : date;
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}.${month}.${year}`;
}

function formatTime(date) {
  const d = typeof date === "string" ? new Date(date) : date;
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function formatDateFromKey(key) {
  const [year, month, day] = key.split("-");
  return `${day}.${month}.${year}`;
}

function formatDateForInput(date) {
  const d = typeof date === "string" ? new Date(date) : date;
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${year}-${month}-${day}`;
}

function addDays(date, delta) {
  const next = new Date(date);
  next.setDate(next.getDate() + delta);
  return next;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function createExportModal() {
  const existing = document.getElementById("historyExportModal");
  if (existing) return existing;

  const backdrop = document.createElement("div");
  backdrop.className = "modalBackdrop";
  backdrop.id = "historyExportModal";
  backdrop.hidden = true;

  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="historyExportTitle">
      <h3 id="historyExportTitle">Экспорт истории в PDF</h3>
      <p class="muted">Выберите период выгрузки.</p>
      <div class="modalRow historyExportOptions">
        ${FILTER_OPTIONS.map(
          (option) => `
            <label class="checkboxRow historyExportOption">
              <input type="radio" name="historyExportFilter" value="${option.id}" />
              <span>${option.label}</span>
            </label>
          `
        ).join("")}
      </div>
      <div class="modalRow historyExportRange" data-role="historyExportRange">
        <label class="modalField">
          <span class="modalLabel">С даты</span>
          <input class="input" type="date" data-role="historyExportFrom" />
        </label>
        <label class="modalField">
          <span class="modalLabel">По дату</span>
          <input class="input" type="date" data-role="historyExportTo" />
        </label>
      </div>
      <div class="row">
        <button class="btn purple" type="button" data-role="historyExportConfirm">Выгрузить</button>
        <button class="btn" type="button" data-role="historyExportCancel">Отмена</button>
      </div>
    </div>
  `;

  document.body.appendChild(backdrop);
  return backdrop;
}

function bindModal(modal, toast) {
  const rangeRow = modal.querySelector("[data-role='historyExportRange']");
  const fromInput = modal.querySelector("[data-role='historyExportFrom']");
  const toInput = modal.querySelector("[data-role='historyExportTo']");
  const confirmBtn = modal.querySelector("[data-role='historyExportConfirm']");
  const cancelBtn = modal.querySelector("[data-role='historyExportCancel']");
  const radioInputs = Array.from(modal.querySelectorAll("input[name='historyExportFilter']"));

  let confirmHandler = null;

  const selectFilter = (value) => {
    radioInputs.forEach((input) => {
      input.checked = input.value === value;
    });
    const showRange = value === "range";
    rangeRow.classList.toggle("is-active", showRange);
    if (showRange) {
      const today = new Date();
      const fromDate = startOfDay(addDays(today, -6));
      if (!fromInput.value) {
        fromInput.value = formatDateForInput(fromDate);
      }
      if (!toInput.value) {
        toInput.value = formatDateForInput(today);
      }
    }
  };

  selectFilter("all");

  radioInputs.forEach((input) => {
    input.addEventListener("change", () => {
      selectFilter(input.value);
    });
  });

  const open = () => {
    modal.hidden = false;
    modal.classList.add("show");
    document.body.classList.add("modalOpen");
    document.documentElement.classList.add("modalOpen");
    selectFilter(getSelectedFilter(radioInputs));
  };

  const close = () => {
    modal.classList.remove("show");
    modal.hidden = true;
    document.body.classList.remove("modalOpen");
    document.documentElement.classList.remove("modalOpen");
  };

  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      close();
    }
  });

  cancelBtn.addEventListener("click", () => close());

  confirmBtn.addEventListener("click", () => {
    const filterId = getSelectedFilter(radioInputs);
    const fromDate = fromInput.value ? new Date(`${fromInput.value}T00:00:00`) : null;
    const toDate = toInput.value ? new Date(`${toInput.value}T00:00:00`) : null;

    if (filterId === "range" && (!fromDate || !toDate)) {
      toast("Заполните диапазон дат.");
      return;
    }

    if (filterId === "range" && fromDate && toDate && fromDate > toDate) {
      toast("Дата начала не может быть позже даты окончания.");
      return;
    }

    close();
    if (confirmHandler) {
      confirmHandler({ filterId, fromDate, toDate });
    }
  });

  return {
    open,
    close,
    onConfirm: (handler) => {
      confirmHandler = handler;
    },
  };
}

function getSelectedFilter(radioInputs) {
  const selected = radioInputs.find((input) => input.checked);
  return selected?.value || "all";

}



