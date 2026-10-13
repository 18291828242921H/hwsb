"use strict";

/* =========================================================
   1. CONSTANTS
   ========================================================= */
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Each group is a colour family (hue). Subjects inside a group get different shades.
const GROUPS = {
  science: { label: "Sciences",          hue: 168 },
  math:    { label: "Maths & Computing", hue: 218 },
  lang:    { label: "Languages",         hue: 268 },
  hum:     { label: "Humanities",        hue: 34  },
  arts:    { label: "Arts & PE",         hue: 340 },
  other:   { label: "Other",             hue: 210, sat: 12 }
};

// reminders = how many days before the due date an item enters its "reminder window"
const TYPES = {
  homework: { label: "Homework", reminders: [2, 1]  },
  exam:     { label: "Exam",     reminders: [7, 1]  },
  project:  { label: "Project",  reminders: [14, 7] }
};

const STORE_KEY = "studyline-v1";

/* =========================================================
   2. HELPERS
   ========================================================= */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const uid = () => Math.random().toString(36).slice(2, 9);
const pad = (n) => String(n).padStart(2, "0");

// Dates are stored as "YYYY-MM-DD" strings and always handled in local time.
const toISO   = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromISO = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const today   = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
const dayIndex = (d) => (d.getDay() + 6) % 7;              // Monday = 0 ... Sunday = 6
const daysUntil = (iso) => Math.round((fromISO(iso) - today()) / 86400000);
const fmt     = (d) => d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const fmtLong = (d) => d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });

/* =========================================================
   3. STATE + STORAGE
   ========================================================= */
let state = load();

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (Array.isArray(s.subjects) && Array.isArray(s.periods) && Array.isArray(s.items)) return s;
    }
  } catch (err) { /* storage blocked or corrupt: start fresh */ }
  return { subjects: [], periods: [], items: [] };
}

function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (err) { /* ignore */ }
}

const subjectById = (id) => state.subjects.find((s) => s.id === id);

// UI state for the side drawer
const ui = { view: null, subjectId: null, day: null, type: "homework", fromAgenda: false };
let lastFocus = null;

/* =========================================================
   4. COLOUR SYSTEM  (same group = same hue, different shade)
   ========================================================= */
function subjectColors(subject) {
  const g = GROUPS[subject.group] || GROUPS.other;
  const siblings = state.subjects.filter((s) => s.group === subject.group);
  const idx = Math.max(0, siblings.findIndex((s) => s.id === subject.id));
  const sat = g.sat ?? 55;
  return {
    bg:   `hsl(${g.hue} ${sat}% ${Math.max(70, 93 - idx * 7)}%)`,
    edge: `hsl(${g.hue} ${sat}% ${Math.max(34, 52 - idx * 5)}%)`,
    ink:  `hsl(${g.hue} ${sat}% 20%)`
  };
}
const colorVars = (s) => {
  const c = subjectColors(s);
  return `--c-bg:${c.bg};--c-edge:${c.edge};--c-ink:${c.ink}`;
};
const groupOptions = (selected) => Object.entries(GROUPS).map(([k, g]) =>
  `<option value="${k}" ${k === selected ? "selected" : ""}>${g.label}</option>`).join("");

/* =========================================================
   5. SCHEDULE MATHS  (when is the next class?)
   ========================================================= */
const hasClassOn = (subjectId, date) =>
  state.periods.some((p) => p.subjectId === subjectId && p.day === dayIndex(date));

// The next `count` dates AFTER `after` on which this subject has a class.
function classDates(subjectId, after, count) {
  const days = new Set(state.periods.filter((p) => p.subjectId === subjectId).map((p) => p.day));
  const out = [];
  let d = addDays(after, 1);
  for (let i = 0; i < 120 && out.length < count; i++, d = addDays(d, 1)) {
    if (days.has(dayIndex(d))) out.push(d);
  }
  return out;
}

// Today if it's that weekday, otherwise the next time it comes round.
function nextOccurrence(day) {
  let d = today();
  while (dayIndex(d) !== day) d = addDays(d, 1);
  return d;
}

const ctxDate = () => (ui.day == null ? today() : nextOccurrence(ui.day));

function dueOptions(subjectId, ctx) {
  const [n1, n2] = classDates(subjectId, ctx, 2);
  const opts = [];
  if (hasClassOn(subjectId, ctx)) opts.push({ key: "this", label: "This class", date: ctx });
  if (n1) opts.push({ key: "next",  label: "Next class",       date: n1 });
  if (n2) opts.push({ key: "after", label: "Class after that", date: n2 });
  opts.push({ key: "custom", label: "Custom date" });
  return opts;
}

function defaultMode(type, opts) {
  const has = (k) => opts.some((o) => o.key === k);
  if (type === "exam")    return has("this") ? "this" : has("next") ? "next" : "custom";
  if (type === "project") return "custom";
  return has("next") ? "next" : "custom";
}

/* =========================================================
   6. REMINDER ENGINE
   ========================================================= */
function itemStatus(item) {
  const left = daysUntil(item.due);
  const horizon = Math.max(...TYPES[item.type].reminders);
  let text, tone;
  if (left < 0)        { text = `${-left} day${-left === 1 ? "" : "s"} overdue`; tone = "late"; }
  else if (left === 0) { text = "Due today";    tone = "soon"; }
  else if (left === 1) { text = "Due tomorrow"; tone = "soon"; }
  else                 { text = `In ${left} days`; tone = left <= 3 ? "soon" : "calm"; }
  return { left, text, tone, triggered: left <= horizon };
}

const openItems = () => state.items.filter((i) => !i.done).sort((a, b) => a.due.localeCompare(b.due));
const reminderCount = () => openItems().filter((i) => itemStatus(i).triggered).length;

function reminderText(type) {
  const label = (n) => (n === 14 ? "2 weeks" : n === 7 ? "1 week" : n === 1 ? "1 day" : `${n} days`);
  return `Reminders: ${TYPES[type].reminders.map(label).join(", ")} before it's due.`;
}

function groupOf(left) {
  if (left < 0)  return "Overdue";
  if (left === 0) return "Today";
  if (left === 1) return "Tomorrow";
  if (left <= 7) return "This week";
  return "Later";
}

/* =========================================================
   7. RENDER: today strip, board, badge
   ========================================================= */
function renderToday() {
  const t = today();
  const classes = state.periods
    .filter((p) => p.day === dayIndex(t))
    .sort((a, b) => a.start.localeCompare(b.start));
  const soon = openItems().filter((i) => itemStatus(i).left <= 1);

  const chips = classes.map((p) => {
    const s = subjectById(p.subjectId);
    if (!s) return "";
    return `<button class="chip-btn" type="button" style="${colorVars(s)}"
              data-open-subject="${s.id}" data-open-day="${p.day}">
              ${esc(s.name)} <small>${p.start}</small></button>`;
  }).join("");

  $("#today").innerHTML = `
    <div><p class="eyebrow">Today</p><h1>${fmtLong(t)}</h1></div>
    <p class="today__due ${soon.length ? "has-due" : ""}">
      ${soon.length ? `${soon.length} item${soon.length === 1 ? "" : "s"} due tomorrow or sooner` : "Nothing due today or tomorrow"}
    </p>
    <div class="today__classes">${chips || `<span class="muted">No classes today</span>`}</div>`;
}

function classBlock(p) {
  const s = subjectById(p.subjectId);
  if (!s) return "";
  const open = state.items.filter((i) => i.subjectId === s.id && !i.done);
  const hw = open.filter((i) => i.type === "homework");
  const hwAlert = hw.some((i) => itemStatus(i).left <= 1);
  const exam = open.some((i) => i.type === "exam");

  const chips = [
    hw.length ? `<span class="chip ${hwAlert ? "chip--alert" : ""}">${hw.length} HW</span>` : "",
    exam ? `<span class="chip chip--exam">Exam</span>` : ""
  ].join("");

  return `<button class="class" type="button" style="${colorVars(s)}"
            data-open-subject="${s.id}" data-open-day="${p.day}">
            <span class="class__time">${p.start}–${p.end}</span>
            <span class="class__name">${esc(s.name)}</span>
            ${chips ? `<span class="class__chips">${chips}</span>` : ""}
          </button>`;
}

function renderBoard() {
  const board = $("#board");

  if (state.periods.length === 0) {
    board.style.setProperty("--cols", 1);
    board.innerHTML = `
      <div class="onboarding">
        <h2>Let's build your timetable</h2>
        <p>Add your subjects and classes once. Then tap any class to attach homework, exams and projects, and Studyline keeps track of what's due.</p>
        <div class="onboarding__actions">
          <button class="btn btn--primary" type="button" data-do="open-editor">Add my classes</button>
          <button class="btn" type="button" data-do="load-sample">Try a sample timetable</button>
        </div>
      </div>`;
    return;
  }

  const used = new Set(state.periods.map((p) => p.day));
  const visible = DAYS.map((_, i) => i).filter((i) => i < 5 || used.has(i));
  const todayIdx = dayIndex(today());
  board.style.setProperty("--cols", visible.length);

  board.innerHTML = visible.map((day) => {
    const list = state.periods.filter((p) => p.day === day).sort((a, b) => a.start.localeCompare(b.start));
    return `<div class="day ${day === todayIdx ? "is-today" : ""}">
      <h2 class="day__name">${DAYS[day]}</h2>
      ${list.map(classBlock).join("") || `<p class="day__empty">No classes</p>`}
    </div>`;
  }).join("");
}

function renderBadge() {
  const n = reminderCount();
  const badge = $("#badge");
  badge.textContent = n;
  badge.hidden = n === 0;
  $("#agendaBtn").setAttribute("aria-label", n ? `Upcoming work, ${n} reminder${n === 1 ? "" : "s"}` : "Upcoming work");
}

function renderAll() {
  renderToday();
  renderBoard();
  renderBadge();
  if (ui.view) renderDrawer();
  if ($("#editor").open) renderEditor();
}

/* =========================================================
   8. DRAWER: subject view + agenda view
   ========================================================= */
function itemCard(i) {
  const st = itemStatus(i);
  return `<article class="item ${i.done ? "is-done" : ""}" data-id="${i.id}">
    <div class="item__top">
      <span class="tag tag--${i.type}">${TYPES[i.type].label}</span>
      <span class="status status--${st.tone}">${i.done ? "Done" : st.text}</span>
    </div>
    <h4>${esc(i.title)}</h4>
    <p class="item__due">${fmtLong(fromISO(i.due))}</p>
    ${i.details ? `<p class="item__details">${esc(i.details)}</p>` : ""}
    <div class="item__actions">
      <button class="link" type="button" data-act="toggle">${i.done ? "Undo" : "Mark done"}</button>
      <button class="link link--danger" type="button" data-act="delete">Delete</button>
    </div>
  </article>`;
}

function subjectView() {
  const s = subjectById(ui.subjectId);
  const opts = dueOptions(s.id, ctxDate());
  const mode = defaultMode(ui.type, opts);
  const nextClass = classDates(s.id, addDays(today(), -1), 1)[0];
  const items = state.items
    .filter((i) => i.subjectId === s.id)
    .sort((a, b) => (a.done - b.done) || a.due.localeCompare(b.due));

  return `
    <div class="subject-head" style="${colorVars(s)}">
      ${ui.fromAgenda ? `<button class="link" type="button" data-act="back">&larr; Upcoming</button>` : ""}
      <p class="eyebrow">${GROUPS[s.group].label}</p>
      <h2 id="drawerTitle">${esc(s.name)}</h2>
      <p class="muted">${nextClass ? `Next class: ${fmt(nextClass)}` : "No classes scheduled"}</p>
    </div>

    <section>
      <h3>Coming up</h3>
      ${items.length ? items.map(itemCard).join("") : `<p class="muted">Nothing yet. Add homework, an exam or a project below.</p>`}
    </section>

    <form id="itemForm" class="form" novalidate>
      <h3>Add to ${esc(s.name)}</h3>
      <div class="seg" role="radiogroup" aria-label="Type">
        ${Object.entries(TYPES).map(([k, t]) => `
          <label><input type="radio" name="type" value="${k}" ${k === ui.type ? "checked" : ""}><span>${t.label}</span></label>`).join("")}
      </div>
      <label class="field"><span>Title</span>
        <input name="title" maxlength="80" placeholder="e.g. Cell structure worksheet" autocomplete="off">
      </label>
      <label class="field"><span>Details</span>
        <textarea name="details" rows="3" placeholder="Pages, what to bring, what to revise…"></textarea>
      </label>
      <fieldset class="due">
        <legend>Due</legend>
        ${opts.map((o) => `
          <label class="due__opt"><input type="radio" name="due" value="${o.key}" ${o.key === mode ? "checked" : ""}>
            <span>${o.label}${o.date ? `<em>${fmt(o.date)}</em>` : ""}</span></label>`).join("")}
        <input type="date" name="customDate" min="${toISO(today())}" ${mode === "custom" ? "" : "hidden"} aria-label="Custom due date">
      </fieldset>
      <p id="reminderHint" class="form__hint">${reminderText(ui.type)}</p>
      <p id="formError" class="form__error" role="alert"></p>
      <button class="btn btn--primary" type="submit">Save</button>
    </form>`;
}

function agendaRow(i) {
  const s = subjectById(i.subjectId);
  if (!s) return "";
  const st = itemStatus(i);
  return `<li class="row" style="${colorVars(s)}" data-id="${i.id}">
    <button class="row__check" type="button" data-act="toggle" aria-label="Mark ${esc(i.title)} as done"></button>
    <button class="row__main" type="button" data-open-subject="${s.id}" data-from="agenda">
      <span class="row__title">${esc(i.title)}</span>
      <span class="row__meta">${esc(s.name)} · ${TYPES[i.type].label} · ${fmt(fromISO(i.due))}</span>
    </button>
    <span class="status status--${st.tone}">${st.text}</span>
    ${st.triggered ? `<span class="ping" title="Inside its reminder window"></span>` : ""}
  </li>`;
}

function agendaView() {
  const open = openItems();
  const order = ["Overdue", "Today", "Tomorrow", "This week", "Later"];
  const buckets = Object.fromEntries(order.map((k) => [k, []]));
  open.forEach((i) => buckets[groupOf(itemStatus(i).left)].push(i));

  const sections = order.filter((k) => buckets[k].length).map((k) => `
    <section class="group">
      <h3>${k} <span>${buckets[k].length}</span></h3>
      <ul class="rows">${buckets[k].map(agendaRow).join("")}</ul>
    </section>`).join("");

  return `
    <div class="subject-head neutral">
      <p class="eyebrow">Upcoming</p>
      <h2 id="drawerTitle">Everything due</h2>
      <p class="muted">${open.length} open · ${reminderCount()} in reminder window</p>
    </div>
    ${sections || `<p class="empty-note">Nothing due. Tap a class to add homework, an exam or a project.</p>`}`;
}

function renderDrawer() {
  if (ui.view === "subject" && !subjectById(ui.subjectId)) return hideDrawer();
  $("#drawerBody").innerHTML = ui.view === "subject" ? subjectView() : agendaView();
}

function showDrawer() {
  lastFocus = document.activeElement;
  $("#drawer").classList.add("is-open");
  $("#drawer").setAttribute("aria-hidden", "false");
  $("#scrim").hidden = false;
  $("#drawerClose").focus();
}

function hideDrawer() {
  $("#drawer").classList.remove("is-open");
  $("#drawer").setAttribute("aria-hidden", "true");
  $("#scrim").hidden = true;
  ui.view = null;
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}

function openSubject(subjectId, day, fromAgenda) {
  const wasOpen = !!ui.view;
  Object.assign(ui, { view: "subject", subjectId, day, fromAgenda: !!fromAgenda });
  renderDrawer();
  if (!wasOpen) showDrawer();
}

function openAgenda() {
  const wasOpen = !!ui.view;
  ui.view = "agenda";
  renderDrawer();
  if (!wasOpen) showDrawer();
}

/* =========================================================
   9. DRAWER EVENTS
   ========================================================= */
const drawerBody = $("#drawerBody");

drawerBody.addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]");
  if (!act) return;
  const id = act.closest("[data-id]")?.dataset.id;

  if (act.dataset.act === "toggle") {
    const item = state.items.find((i) => i.id === id);
    if (item) { item.done = !item.done; save(); renderAll(); }
  } else if (act.dataset.act === "delete") {
    state.items = state.items.filter((i) => i.id !== id);
    save(); renderAll();
  } else if (act.dataset.act === "back") {
    ui.view = "agenda"; renderDrawer();
  }
});

drawerBody.addEventListener("change", (e) => {
  const form = $("#itemForm");
  if (!form) return;

  if (e.target.name === "type") {
    ui.type = e.target.value;
    const opts = dueOptions(ui.subjectId, ctxDate());
    const radio = form.querySelector(`input[name="due"][value="${defaultMode(ui.type, opts)}"]`);
    if (radio) radio.checked = true;
    $("#reminderHint").textContent = reminderText(ui.type);
  }
  if (e.target.name === "type" || e.target.name === "due") {
    const mode = form.querySelector('input[name="due"]:checked')?.value;
    form.elements.customDate.hidden = mode !== "custom";
  }
});

drawerBody.addEventListener("submit", (e) => {
  if (e.target.id !== "itemForm") return;
  e.preventDefault();

  const f = new FormData(e.target);
  const type = f.get("type");
  const title = f.get("title").trim();
  const mode = f.get("due");
  const err = $("#formError");

  let due;
  if (mode === "custom") due = f.get("customDate");
  else due = toISO(dueOptions(ui.subjectId, ctxDate()).find((o) => o.key === mode).date);

  if (!title) { err.textContent = "Add a short title."; return; }
  if (!due)   { err.textContent = "Pick a due date.";   return; }

  state.items.push({
    id: uid(), subjectId: ui.subjectId, type, title,
    details: f.get("details").trim(), due, done: false
  });
  ui.type = type;
  save();
  renderAll();
});

/* =========================================================
   10. EDITOR: subjects + classes
   ========================================================= */
const editor = $("#editor");

function setEditorError(msg) { $("#editorError").textContent = msg; }

// Two-tap confirmation: first tap arms the button, second tap does it.
function confirmTap(btn, label, action) {
  const reset = () => {
    delete btn.dataset.armed;
    if (btn.dataset.label) { btn.textContent = btn.dataset.label; delete btn.dataset.label; }
  };
  if (btn.dataset.armed) {
    clearTimeout(btn._timer);
    reset();
    action();
    return;
  }
  btn.dataset.armed = "1";
  btn.dataset.label = btn.textContent;
  btn.textContent = label;
  btn._timer = setTimeout(reset, 3000);
}

function renderEditor() {
  // subjects
  $("#subjectList").innerHTML = state.subjects.length
    ? state.subjects.map((s) => `
        <li class="srow" data-id="${s.id}">
          <span class="swatch" style="${colorVars(s)}"></span>
          <span class="srow__name">${esc(s.name)}</span>
          <select class="srow__group" data-act="regroup" aria-label="Group for ${esc(s.name)}">${groupOptions(s.group)}</select>
          <button class="link link--danger" type="button" data-act="del-subject">Remove</button>
        </li>`).join("")
    : `<li class="muted">No subjects yet. Add your first one below.</li>`;

  // subject <select> in the class form (keep the current choice)
  const sel = $("#periodForm [name=subject]");
  const keep = sel.value;
  sel.innerHTML = state.subjects.length
    ? state.subjects.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")
    : `<option value="">Add a subject first</option>`;
  if (keep && subjectById(keep)) sel.value = keep;

  // classes, grouped by day
  const html = DAYS.map((name, d) => {
    const list = state.periods.filter((p) => p.day === d).sort((a, b) => a.start.localeCompare(b.start));
    if (!list.length) return "";
    return `<div class="dayblock"><h4>${name}</h4><ul class="plain-list">
      ${list.map((p) => `
        <li class="prow" data-id="${p.id}">
          <span>${p.start}–${p.end}</span>
          <strong>${esc(subjectById(p.subjectId)?.name ?? "Unknown")}</strong>
          <button class="link link--danger" type="button" data-act="del-period">Remove</button>
        </li>`).join("")}
    </ul></div>`;
  }).join("");
  $("#periodList").innerHTML = html || `<p class="muted">No classes yet.</p>`;
}

$("#subjectForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const name = f.get("name").trim();
  const group = f.get("group");

  if (!name) return setEditorError("Give the subject a name.");
  if (state.subjects.some((s) => s.name.toLowerCase() === name.toLowerCase()))
    return setEditorError(`"${name}" is already in your list.`);

  state.subjects.push({ id: uid(), name, group });
  save();
  e.target.reset();
  e.target.elements.group.value = group;
  setEditorError("");
  renderAll();
});

$("#periodForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const day = Number(f.get("day"));
  const start = f.get("start");
  const end = f.get("end");
  const subjectId = f.get("subject");

  if (!subjectId) return setEditorError("Add a subject first.");
  if (!start || !end || end <= start) return setEditorError("The end time must be after the start time.");

  const clash = state.periods.find((p) => p.day === day && start < p.end && end > p.start);
  if (clash) {
    return setEditorError(`That overlaps with ${subjectById(clash.subjectId)?.name} (${clash.start}–${clash.end}).`);
  }

  state.periods.push({ id: uid(), day, start, end, subjectId });
  save();
  setEditorError("");
  e.target.elements.start.value = end;   // handy: next class usually starts when this one ends
  e.target.elements.end.value = "";
  renderAll();
});

editor.addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]");
  if (!act) return;
  const id = act.closest("[data-id]")?.dataset.id;

  if (act.dataset.act === "del-subject") {
    confirmTap(act, "Tap again to remove", () => {
      state.subjects = state.subjects.filter((s) => s.id !== id);
      state.periods = state.periods.filter((p) => p.subjectId !== id);
      state.items = state.items.filter((i) => i.subjectId !== id);
      save(); renderAll();
    });
  } else if (act.dataset.act === "del-period") {
    state.periods = state.periods.filter((p) => p.id !== id);
    save(); renderAll();
  }
});

editor.addEventListener("change", (e) => {
  if (e.target.dataset.act !== "regroup") return;
  const s = subjectById(e.target.closest("[data-id]").dataset.id);
  if (s) { s.group = e.target.value; save(); renderAll(); }
});

/* ----- backup & restore ----- */
$("#backupFill").addEventListener("click", () => {
  const box = $("#backupBox");
  box.value = JSON.stringify(state, null, 2);
  box.select();
  $("#backupMsg").textContent = "Copy this text and keep it somewhere safe.";
});

$("#backupRestore").addEventListener("click", () => {
  try {
    const s = JSON.parse($("#backupBox").value);
    if (!(Array.isArray(s.subjects) && Array.isArray(s.periods) && Array.isArray(s.items))) throw new Error("shape");
    state = s;
    save();
    renderAll();
    $("#backupMsg").textContent = "Restored.";
  } catch (err) {
    $("#backupMsg").textContent = "That doesn't look like a Studyline backup.";
  }
});

/* =========================================================
   11. SAMPLE DATA
   ========================================================= */
function loadSample() {
  const mk = (name, group) => ({ id: uid(), name, group });
  const S = {
    bio: mk("Biology", "science"), chem: mk("Chemistry", "science"), phys: mk("Physics", "science"),
    math: mk("Mathematics", "math"), cs: mk("Computer Science", "math"),
    eng: mk("English", "lang"), fr: mk("French", "lang"),
    hist: mk("History", "hum"), geo: mk("Geography", "hum"),
    art: mk("Art", "arts"), pe: mk("PE", "arts")
  };
  const slots = [["08:30", "09:15"], ["09:25", "10:10"], ["10:30", "11:15"], ["11:25", "12:10"], ["13:00", "13:45"]];
  const week = [
    ["math", "bio", "eng", "phys", "art"],
    ["chem", "math", "hist", "cs", "pe"],
    ["bio", "eng", "math", "fr", "geo"],
    ["phys", "chem", "cs", "hist", "eng"],
    ["math", "geo", "pe", "bio", "fr"]
  ];
  const periods = week.flatMap((row, day) => row.map((key, i) => ({
    id: uid(), day, start: slots[i][0], end: slots[i][1], subjectId: S[key].id
  })));

  state = { subjects: Object.values(S), periods, items: [] };

  const t = today();
  const add = (subject, type, title, details, due) =>
    state.items.push({ id: uid(), subjectId: subject.id, type, title, details, due: toISO(due), done: false });

  add(S.bio,  "homework", "Cell structure worksheet", "Label the organelles on p.42 and write one function for each.", classDates(S.bio.id, t, 1)[0]);
  add(S.math, "homework", "Quadratics: set B", "Questions 1–12. Show your working.", addDays(t, 1));
  add(S.eng,  "homework", "Read chapter 6", "Be ready to discuss the narrator's motives.", addDays(t, 3));
  add(S.chem, "exam",     "Bonding test", "Ionic and covalent bonding, chapters 4–5.", addDays(t, 8));
  add(S.hist, "project",  "Industrial Revolution poster", "A3 poster. Five sources minimum.", addDays(t, 15));

  save();
  renderAll();
}

/* =========================================================
   12. GLOBAL EVENTS + INIT
   ========================================================= */
document.addEventListener("click", (e) => {
  const open = e.target.closest("[data-open-subject]");
  if (open) {
    const day = open.dataset.openDay;
    openSubject(open.dataset.openSubject, day === undefined ? null : Number(day), open.dataset.from === "agenda");
    return;
  }
  const action = e.target.closest("[data-do]")?.dataset.do;
  if (action === "open-editor") { renderEditor(); editor.showModal(); }
  if (action === "load-sample") loadSample();
});

$("#agendaBtn").addEventListener("click", () => (ui.view === "agenda" ? hideDrawer() : openAgenda()));
$("#drawerClose").addEventListener("click", hideDrawer);
$("#scrim").addEventListener("click", hideDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && ui.view) hideDrawer(); });

$("#editBtn").addEventListener("click", () => { renderEditor(); editor.showModal(); });
$("#editorClose").addEventListener("click", () => editor.close());
$("#doneBtn").addEventListener("click", () => editor.close());

$("#sampleBtn").addEventListener("click", (e) => {
  if (state.periods.length) confirmTap(e.target, "Tap again to replace", loadSample);
  else loadSample();
});
$("#clearBtn").addEventListener("click", (e) =>
  confirmTap(e.target, "Tap again to erase all", () => {
    state = { subjects: [], periods: [], items: [] };
    save(); hideDrawer(); renderAll();
  }));

// Dates change at midnight, so re-render whenever the tab comes back into view.
document.addEventListener("visibilitychange", () => { if (!document.hidden) renderAll(); });

function init() {
  $("#subjectForm [name=group]").innerHTML = groupOptions("science");
  $("#periodForm [name=day]").innerHTML = DAYS.map((d, i) => `<option value="${i}">${d}</option>`).join("");
  renderAll();
}
init();
