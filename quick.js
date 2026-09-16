// ── Быстрые дела: всё из хранилища Obsidian, корзина на день, таймер 5/15 и серия.
// Заметки выгружает мост на маке (bd_notes), правки уходят очередью (bd_changes) и доезжают до Obsidian.

const Q = {
  notes: [], settings: null, loaded: false, loading: false, error: "", at: null,
  tab: "basket", q: "", open: {}, folds: {}, award: null, tick: null, poll: null, hidden: new Set(), sel: null,
};
const Q_ORDER = ["Быстрые", "Актуальное", "В работе", "Новые", "Не забыть", "Идеи", "Цели", "Полезные статьи", "Контент", "Гипотезы", "Разобрать", "Когда-нибудь"];
const Q_RANKS = [[0, "Авральщик"], [10, "Догоняющий"], [30, "Успевающий"], [70, "На шаг впереди"], [150, "Разгребатель"]];
const Q_CHEERS = ["Разобрал всё, что взял", "Список пуст, и голова тоже", "Взял и сделал. Редкое дело", "Сегодня разгребли — завтра не копится"];

const qe = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const qDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const qYesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return qDay(d); };
const qDoneDay = n => n.updated_at ? qDay(new Date(n.updated_at)) : "";
const qIsDone = n => n.status === "сделано" || n.status === "изучено";
const Q_STUDY_KINDS = ["материал", "исследование", "инструмент"];
const qIsArticle = n => Q_STUDY_KINDS.includes(n.kind) || String(n.folder || "").startsWith("WIKI");
const qStudy = n => qIsArticle(n) && !(n.steps || []).length;
const qPlural = (n, one, few, many) => n % 10 === 1 && n % 100 !== 11 ? one : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many);
const qStore = (k, v) => { try { v === undefined ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const qRead = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };

/* ---------- шаги в корзине: живут на устройстве до конца дня ---------- */
function qStepKeys() {
  const s = qRead("bd-steps-basket");
  return s && s.day === qDay() ? new Set(s.keys) : new Set();
}
function qSaveStepKeys(set) { qStore("bd-steps-basket", { day: qDay(), keys: [...set] }); }

/* ---------- облако ---------- */
async function qLoad(force) {
  if (typeof sb === "undefined" || !sb || !user) { Q.error = "login"; Q.loaded = true; return; }
  if (Q.loading || (Q.loaded && !force && Date.now() - Q.at < 20e3)) return;
  Q.loading = true;
  try {
    const [notes, set] = await Promise.all([
      sb.from("bd_notes").select("*").eq("deleted", false).order("updated_at", { ascending: false }),
      sb.from("bd_settings").select("*"),
    ]);
    if (notes.error) throw notes.error;
    const keys = qStepKeys();
    Q.notes = qOverlay((notes.data || []).filter(n => !Q.hidden.has(n.id)).map(n => ({ ...n, steps: (n.steps || []).map((s, i) => ({ ...s, basket: keys.has(`${n.id}:${i}`) && !s.done })) })));
    Q.settings = (set.data && set.data[0]) || { streak: 0, streak_day: null };
    Q.error = ""; Q.at = Date.now();
  } catch (e) {
    console.warn("быстрые дела: загрузка", e);
    Q.error = navigator.onLine ? "cloud" : "offline";
  }
  Q.loading = false; Q.loaded = true;
  render();
}
/* Мои правки держатся на устройстве, пока облако их не догонит: мост пишет в заметку не мгновенно,
   и без этого после обновления страницы сделанное «воскресает». */
function qMark(note, op, value) {
  const f = { status: "status", basket: "basket", minutes: "minutes" }[op];
  if (!f && op !== "step" && op !== "trash") return null;
  const p = qRead("bd-pending") || {}, cur = p[note.id] || {};
  if (f) cur[f] = value[f];
  if (op === "status" && (value.status === "сделано" || value.status === "изучено")) cur.doneAt = new Date().toISOString();
  if (op === "step" && value.done) cur.stepsDone = [...new Set([...(cur.stepsDone || []), value.index])];
  if (op === "trash") cur.trash = true;
  cur.at = Date.now(); p[note.id] = cur; qStore("bd-pending", p);
  return cur.at;
}
function qOverlay(notes) {
  const p = qRead("bd-pending") || {};
  let dirty = false;
  for (const [id, f] of Object.entries(p)) {
    const n = notes.find(x => x.id === id);
    if (!n || Date.now() - f.at > 30 * 60e3) { delete p[id]; dirty = true; continue; }
    const caught = !f.trash
      && (f.status === undefined || n.status === f.status)
      && (f.basket === undefined || n.basket === f.basket)
      && (f.minutes === undefined || n.minutes === f.minutes)
      && (f.stepsDone || []).every(i => n.steps?.[i]?.done);
    if (caught) { delete p[id]; dirty = true; continue; }
    if (f.status !== undefined) { n.status = f.status; if (f.doneAt) n.updated_at = f.doneAt; }
    if (f.basket !== undefined) n.basket = f.basket;
    if (f.minutes !== undefined) n.minutes = f.minutes;
    (f.stepsDone || []).forEach(i => { if (n.steps?.[i]) { n.steps[i].done = true; n.steps[i].basket = false; } });
  }
  if (dirty) qStore("bd-pending", p);
  return notes.filter(n => !(p[n.id] && p[n.id].trash));
}
function qChange(note, op, value) {
  if (!sb || !user) return;
  const at = qMark(note, op, value);
  sb.from("bd_changes").insert({ user_id: user.id, note_id: note.id, op, value })
    .then(({ error }) => {
      if (!error) return;
      const p = qRead("bd-pending") || {};
      if (at && p[note.id] && p[note.id].at === at) { delete p[note.id]; qStore("bd-pending", p); }
      toast("Не ушло в Obsidian — проверь связь и повтори");
    });
}

/* ---------- выборки ---------- */
function qBasket() {
  const out = [];
  Q.notes.forEach(n => {
    if (qIsDone(n)) return;
    const steps = (n.steps || []).map((s, i) => ({ ...s, i })).filter(s => s.basket && !s.done);
    if (steps.length) steps.forEach(s => out.push({ key: `${n.id}:${s.i}`, note: n, step: s }));
    else if (n.basket) out.push({ key: n.id, note: n, step: null });
  });
  return out;
}
const quickCount = () => Q.loaded ? qBasket().length : "";
const qGroup = n => {
  if (n.kind === "не забыть") return "Не забыть";
  if (n.quick) return "Быстрые";
  if (["актуальное", "в работе", "когда-нибудь"].includes(n.status)) return n.status[0].toUpperCase() + n.status.slice(1);
  if (qIsArticle(n)) return "Полезные статьи";
  return { "идея": "Идеи", "цель": "Цели", "материал": "Полезные статьи", "контент": "Контент", "гипотеза": "Гипотезы", "разобрать": "Разобрать" }[n.kind] || "Новые";
};
const qFind = key => {
  const [id, i] = String(key).split(":");
  const note = Q.notes.find(n => n.id === id);
  if (!note) return null;
  return { key, note, step: i === undefined ? null : { ...note.steps[+i], i: +i } };
};
const qAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return qDay(d); };
const qMonday = day => { const d = new Date(day + "T12:00:00"); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return qDay(d); };
const qFrozenDay = () => { const v = String((Q.settings || {}).frozen_week || ""); return v.length === 8 ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6)}` : null; };
const qFreezeFree = day => { const f = qFrozenDay(); return !f || qMonday(f) !== qMonday(day); };
function qStreak() {
  const s = Q.settings || {};
  const today = s.streak_day === qDay();
  const fresh = today || s.streak_day === qYesterday();
  const saved = !fresh && s.streak_day === qAgo(2) && qFreezeFree(qYesterday());
  return { n: fresh || saved ? (s.streak || 0) : 0, today, pending: saved, frozen: qFrozenDay(), free: qFreezeFree(qDay()) };
}
function qRank() {
  const total = Q.notes.filter(qIsDone).length + Q.notes.reduce((a, n) => a + (n.starts || 0), 0) + ((Q.settings || {}).total_done || 0);
  let cur = Q_RANKS[0], next = null;
  Q_RANKS.forEach((r, i) => { if (total >= r[0]) { cur = r; next = Q_RANKS[i + 1] || null; } });
  return { total, cur, next };
}

/* ---------- действия ---------- */
function qToggleBasket(note) {
  note.basket = !note.basket; note.basket_day = qDay();
  qChange(note, "basket", { basket: note.basket });
  render(); toast(note.basket ? `В работу: ${note.title}` : `Убрано из работы`);
}
function qToggleStep(note, i) {
  const s = note.steps[i]; if (!s || s.done) return;
  s.basket = !s.basket;
  const keys = qStepKeys(); s.basket ? keys.add(`${note.id}:${i}`) : keys.delete(`${note.id}:${i}`); qSaveStepKeys(keys);
  render(); toast(s.basket ? "Шаг в работе" : "Шаг убран");
}
function qMinutes(entry) {
  const m = entry.note.minutes === 15 ? 5 : 15;
  entry.note.minutes = m; qChange(entry.note, "minutes", { minutes: m }); render();
}
async function qCredit(note) {
  note.starts = (note.starts || 0) + 1;
  qChange(note, "start", { starts: note.starts });
  const s = Q.settings || (Q.settings = {});
  if (s.streak_day === qDay()) return;
  if (s.streak_day === qYesterday()) s.streak = (s.streak || 0) + 1;
  else if (s.streak_day === qAgo(2) && qFreezeFree(qYesterday())) {
    s.streak = (s.streak || 0) + 1;
    s.frozen_week = +qYesterday().replace(/-/g, "");
    toast("Вчерашний пропуск закрыт заморозкой — серия жива");
  } else s.streak = 1;
  s.streak_day = qDay();
  const { error } = await sb.from("bd_settings").upsert({ user_id: user.id, streak: s.streak, streak_day: s.streak_day, frozen_week: s.frozen_week || 0 });
  if (error) console.warn("быстрые дела: серия", error);
}
function qFinish(entry, { credit = true } = {}) {
  const { note, step } = entry;
  let line;
  if (step) {
    const real = note.steps[step.i];
    real.done = true; real.basket = false;
    const keys = qStepKeys(); keys.delete(entry.key); qSaveStepKeys(keys);
    qChange(note, "step", { index: step.i, done: true });
    const left = note.steps.filter(s => !s.done).length;
    if (!left) { note.status = "сделано"; note.updated_at = new Date().toISOString(); qChange(note, "status", { status: "сделано" }); }
    line = left ? `Шаг закрыт — осталось ${left} из ${note.steps.length}. Чекбокс отмечен в заметке` : `Задача «${note.title}» закрыта целиком`;
  } else {
    const status = qStudy(note) ? "изучено" : "сделано";
    note.status = status; note.basket = false; note.updated_at = new Date().toISOString();
    qChange(note, "status", { status });
    if (note.basket === false) qChange(note, "basket", { basket: false });
    line = status === "изучено" ? "Изучено, лежит в «Полезных статьях»" : "Сделано, отмечено в заметке";
  }
  if (credit) qCredit(note).then(() => render());
  return line;
}

/* ---------- удаление: заметка переезжает в папку «Корзина» хранилища, вернуть можно ---------- */
function qTrash(ids) {
  const gone = Q.notes.filter(n => ids.includes(n.id));
  if (!gone.length) return;
  gone.forEach(n => Q.hidden.add(n.id));
  Q.notes = Q.notes.filter(n => !Q.hidden.has(n.id));
  const t = qTimer();
  if (t && gone.some(n => String(t.key).split(":")[0] === n.id)) qStore("bd-timer");
  let undone = false;
  const send = setTimeout(() => { if (!undone) gone.forEach(n => qChange(n, "trash", {})); }, 3300);
  render();
  const label = gone.length === 1 ? `В корзине: ${gone[0].title}` : `В корзину ${gone.length} ${qPlural(gone.length, "заметка", "заметки", "заметок")}`;
  toastUndo(label, () => {
    undone = true; clearTimeout(send);
    gone.forEach(n => Q.hidden.delete(n.id));
    Q.notes = Q.notes.concat(gone).sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
    render();
  });
}

/* ---------- таймер: считает от времени окончания, переживает перезагрузку ---------- */
const qTimer = () => qRead("bd-timer");
function qStart(entry) {
  const min = entry.note.minutes === 15 ? 15 : 5;
  qStore("bd-timer", { key: entry.key, end: Date.now() + min * 60e3, full: min * 60, title: entry.step ? entry.step.t : entry.note.title, parent: entry.step ? entry.note.title : "", rang: false });
  Q.award = null; Q.timerFull = false;
  try { if (window.Notification && Notification.permission === "default") Notification.requestPermission(); } catch {}
  render();
}
function qBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, .35, .7].forEach(t => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(.0001, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(.25, ctx.currentTime + t + .02);
      g.gain.exponentialRampToValueAtTime(.0001, ctx.currentTime + t + .25);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + .3);
    });
  } catch {}
}
function qTick() {
  const t = qTimer();
  if (!t) { clearInterval(Q.tick); Q.tick = null; document.title = "Быстродел"; return; }
  const left = Math.max(0, Math.round((t.end - Date.now()) / 1000));
  const txt = `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(left % 60).padStart(2, "0")}`;
  const clock = document.getElementById("qClock");
  if (clock) {
    clock.textContent = txt;
    document.getElementById("qArc").setAttribute("stroke-dashoffset", (339.29 * (1 - left / t.full)).toFixed(2));
    document.querySelectorAll(".q-focus,.q-running,.q-runbar").forEach(x => x.classList.toggle("up", left === 0));
    const sub = document.getElementById("qClockSub"); if (sub) sub.textContent = left ? "осталось" : "время вышло";
    const more = document.getElementById("qMore"); if (more) more.hidden = left > 0;
  }
  document.title = left ? `${txt} · ${t.title}` : "Время вышло · Быстродел";
  if (!left && !t.rang) {
    t.rang = true; qStore("bd-timer", t); qBeep();
    try { if (window.Notification && Notification.permission === "granted") new Notification("Время вышло", { body: `${t.title}\nСделал? Ещё подход? Хватит?` }); } catch {}
    if (view.mode !== "quick") toast(`Время вышло: ${t.title}`);
  }
}
function qEnsureTick() { if (qTimer() && !Q.tick) { Q.tick = setInterval(qTick, 1000); qTick(); } }

/* ---------- отрисовка ---------- */
const QI = {
  check: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m3.5 8.5 3 3 6-7"/></svg>',
  x: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 3l8 8M11 3l-8 8"/></svg>',
  play: '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 1.8v8.4L10 6z" fill="currentColor"/></svg>',
  chev: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m4 5.5 3 3 3-3"/></svg>',
  book: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3.5c2-.8 3.8-.6 5.5.6 1.7-1.2 3.5-1.4 5.5-.6v9c-2-.8-3.8-.6-5.5.6-1.7-1.2-3.5-1.4-5.5-.6z"/><path d="M8 4.1v9"/></svg>',
  expand: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9"/></svg>',
  shrink: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 6.5h-4v-4M9.5 6.5l4-4M2.5 9.5h4v4M6.5 9.5l-4 4"/></svg>',
  minus: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 7h8"/></svg>',
  out: '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 3H3v8h8V8.5M8 2h4v4M12 2 6.5 7.5"/></svg>',
  bolt: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M9.2 1 3 9h4.3l-.8 6L13 7H8.6z" fill="currentColor"/></svg>',
};

const qObsidian = n => `obsidian://open?vault=Obsidian&file=${encodeURIComponent(String(n.path || "").replace(/\.md$/, ""))}`;
function qDetail(n) {
  const steps = n.steps || [];
  const text = (n.excerpt || "").trim();
  const long = text.length >= 1490;
  return `<div class="q-detail">
    ${text ? `<div class="q-text">${qe(text)}${long ? "…" : ""}</div>` : `<div class="q-text empty-t">В заметке нет текста — только название.</div>`}
    ${steps.length ? `<div class="q-steps">${steps.map((s, i) => `
      <button class="q-step${s.done ? " done" : ""}${s.basket ? " on" : ""}" data-q-step="${n.id}:${i}" ${s.done ? "disabled" : ""}>
        <span class="q-box">${s.done ? QI.check : s.basket ? QI.bolt : ""}</span><span>${qe(s.t)}</span>
      </button>`).join("")}<div class="q-hint">Нажми на шаг — он уйдёт в работу на сегодня</div></div>` : ""}
    <div class="q-detail-acts">
      <a class="q-link" href="${qObsidian(n)}">Открыть в Obsidian ${QI.out}</a>
      <span class="q-path">${qe(n.folder || "")}</span>
    </div>
  </div>`;
}
const qMiniRing = (cls = "") => `<div class="q-mini-ring ${cls}"><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="54" class="bg"/><circle id="qArc" cx="60" cy="60" r="54" class="fg" stroke-dasharray="339.29" stroke-dashoffset="0"/></svg><b id="qClock">--:--</b></div>`;
function qItemBasket(e) {
  const min = e.note.minutes === 15 ? 15 : 5;
  const open = Q.open["b:" + e.key];
  const t = qTimer(), run = t && t.key === e.key && !Q.timerFull;
  const study = !e.step && qStudy(e.note);
  const meta = run ? "идёт подход" : e.step ? `${qe(e.note.title)} · шаг ${e.step.i + 1} из ${e.note.steps.length}` : `${qe(qGroup(e.note))}${e.note.source ? " · " + qe(e.note.source) : ""}`;
  const acts = run
    ? `<button class="q-go" data-q-timer="done">${study ? QI.book : QI.check}<span>${study ? "Изучил" : "Сделал"}</span></button>
       <button class="q-ic" data-q-full title="Развернуть таймер">${QI.expand}</button>`
    : `<button class="q-ic" data-q-done="${e.key}" title="${study ? "Изучил — останется в «Полезных статьях»" : "Уже сделал — без таймера"}">${study ? QI.book : QI.check}</button>
       <button class="q-ic desk" data-q-drop="${e.key}" title="Убрать из «Сделать быстро» — останется во «Всё»">${QI.minus}</button>
       <button class="q-ic danger desk" data-q-trash="${e.note.id}" title="Удалить в корзину">${QI.x}</button>
       <button class="q-go" data-q-start="${e.key}">${QI.play}<span>Поехали</span></button>`;
  return `<div class="q-item${e.note.kind === "не забыть" ? " alarm" : ""}${open ? " open" : ""}${run ? " q-running" : ""}">
    <div class="q-swipe" data-note="${e.note.id}">
      <div class="q-under">
        <button class="q-under-b q-take" data-q-drop="${e.key}">${QI.minus}<span>Убрать</span></button>
        <button class="q-under-b q-del" data-q-trash="${e.note.id}">${QI.x}<span>Удалить</span></button>
      </div>
      <div class="q-line q-item-line">
        ${run ? qMiniRing() : `<div class="q-mins" title="Сколько минут на подход">${[5, 15].map(m => `<button class="${min === m ? "on" : ""}" data-q-setmin="${m}" data-key="${e.key}">${m}</button>`).join("")}<small>мин</small></div>`}
        <button class="q-t q-t-btn" data-q-open="b:${e.key}" title="Что за дело"><b>${qe(e.step ? e.step.t : e.note.title)}</b><span>${meta}</span></button>
        <div class="q-acts">${acts}</div>
      </div>
    </div>
    ${run ? `<div class="q-run-acts"><button class="q-soft sm" id="qMore" data-q-timer="more" hidden>Ещё 15 минут</button><button class="q-soft sm" data-q-timer="stop">Хватит на сегодня</button></div>` : ""}
    ${open ? qDetail(e.note) : ""}
  </div>`;
}
function qRunbar() {
  const t = qTimer();
  if (!t || Q.timerFull || !Q.loaded) return "";
  if (Q.tab === "basket" && !Q.award && qBasket().some(e => e.key === t.key)) return "";
  const en = qFind(t.key), study = en && !en.step && qStudy(en.note);
  return `<div class="q-runbar">${qMiniRing("sm")}<div class="q-t"><b>${qe(t.title)}</b><span>идёт подход</span></div>
    <button class="q-go" data-q-timer="done">${study ? QI.book : QI.check}<span>${study ? "Изучил" : "Сделал"}</span></button>
    <button class="q-ic" data-q-full title="Развернуть таймер">${QI.expand}</button></div>`;
}
function qItemPlain(n, { cls = "", meta = "" } = {}) {
  const steps = n.steps || [];
  const inB = steps.length ? steps.some(s => s.basket && !s.done) : n.basket;
  if (Q.sel) {
    const on = Q.sel.has(n.id), here = on && Q.selLast === n.id;
    return `<div class="q-row sel${on ? " chosen" : ""}${cls ? " " + cls : ""}">
      <div class="q-line">
        <button class="q-row-main" data-q-sel="${n.id}">
          <span class="q-box sel-box">${on ? QI.check : ""}</span>
          <span class="q-t"><b>${qe(n.title)}</b><span>${meta}</span></span>
        </button>
        ${here ? `<div class="q-sel-here">
          <span class="q-sel-n">${Q.sel.size}</span>
          <button class="q-soft sm" data-q-sel-take title="Взять выбранные в работу">${QI.bolt}<span>В работу</span></button>
          <button class="q-soft sm danger" data-q-sel-trash title="Удалить выбранные в корзину">${QI.x}<span>Удалить</span></button>
        </div>` : ""}
      </div>
    </div>`;
  }
  const open = Q.open[n.id];
  const pick = steps.length
    ? `<span class="q-pick static">${steps.filter(s => s.basket && !s.done).length ? "шаг в работе" : "шаги"}</span>`
    : n.status === "изучено" ? `<span class="q-pick static studied">изучено</span>`
    : `<button class="q-pick" data-q-toggle="${n.id}">${inB ? "В работе" : "В работу"}</button>`;
  const canStudy = qStudy(n) && n.status !== "изучено";
  return `<div class="q-row${inB ? " picked" : ""}${open ? " open" : ""}${cls ? " " + cls : ""}">
    <div class="q-swipe" data-note="${n.id}">
      <div class="q-under">
        ${canStudy ? `<button class="q-under-b q-study" data-q-done="${n.id}">${QI.book}<span>Изучил</span></button>` : ""}
        ${steps.length || n.status === "изучено" ? "" : `<button class="q-under-b q-take" data-q-toggle="${n.id}">${inB ? QI.minus : QI.bolt}<span>${inB ? "Из работы" : "В работу"}</span></button>`}
        <button class="q-under-b q-del" data-q-trash="${n.id}">${QI.x}<span>Удалить</span></button>
      </div>
      <div class="q-line">
        <button class="q-row-main" data-q-open="${n.id}">
          <span class="q-t"><b>${qe(n.title)}</b><span>${meta}</span></span>
          <span class="q-chev${open ? " open" : ""}">${QI.chev}</span>
        </button>
        <div class="q-row-side">${pick}${canStudy ? `<button class="q-ic desk" data-q-done="${n.id}" title="Изучил — останется в «Полезных статьях»">${QI.book}</button>` : ""}${n.kind === "не забыть" && n.status !== "сделано" ? `<button class="q-ic" data-q-done="${n.id}" title="Сделал">${QI.check}</button>` : ""}<button class="q-ic danger desk" data-q-trash="${n.id}" title="Удалить в корзину">${QI.x}</button></div>
      </div>
    </div>
    ${open ? qDetail(n) : ""}
  </div>`;
}
function qToolbar(list, search) {
  if (Q.sel) {
    const n = Q.sel.size;
    return `<div class="q-selbar">
      <span class="q-sel-n">${n ? `Выбрано ${n}` : "Отметь заметки"}</span>
      <button class="q-soft sm" data-q-sel-all>${list.length && list.every(x => Q.sel.has(x.id)) ? "Снять все" : "Все"}</button>
      <span class="q-sel-gap"></span>
      <button class="q-soft sm" data-q-sel-take ${n ? "" : "disabled"}>${QI.bolt}<span>В работу</span></button>
      <button class="q-soft sm danger" data-q-sel-trash ${n ? "" : "disabled"}>${QI.x}<span>В корзину</span></button>
      <button class="q-soft sm" data-q-sel-cancel>Готово</button>
    </div>`;
  }
  return `<div class="q-tools">${search ? `<div class="q-search"><input id="qSearch" placeholder="Найти в хранилище" autocomplete="off" value="${qe(Q.q)}"></div>` : `<span class="q-sel-gap"></span>`}
    <button class="q-soft sm" data-q-sel-start>Выбрать</button></div>`;
}
function qFocusHTML(t) {
  return `<div class="q-focus">
    <div class="q-focus-top">${t.parent ? `<span>${qe(t.parent)}</span>` : "<span>быстрое дело</span>"}<b>${qe(t.title)}</b>${(() => { const en = qFind(t.key); const x = en && (en.note.excerpt || "").trim(); return x ? `<details class="q-focus-text"${Q.focusText ? " open" : ""}><summary>Что за дело</summary><div class="q-text">${qe(x)}</div><a class="q-link" href="${qObsidian(en.note)}">Открыть в Obsidian ${QI.out}</a></details>` : ""; })()}</div>
    <div class="q-ring">
      <svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="54" class="bg"/><circle id="qArc" cx="60" cy="60" r="54" class="fg" stroke-dasharray="339.29" stroke-dashoffset="0"/></svg>
      <div><b id="qClock">--:--</b><span id="qClockSub">осталось</span></div>
    </div>
    <div class="q-focus-acts">
      ${(() => { const en = qFind(t.key), study = en && !en.step && qStudy(en.note); return `<button class="q-big" data-q-timer="done">${study ? QI.book : QI.check}<span>${study ? "Изучил" : "Сделал"}</span></button>`; })()}
      <button class="q-soft" id="qMore" data-q-timer="more" hidden>Ещё 15 минут</button>
      <button class="q-soft" data-q-timer="stop">Хватит на сегодня</button>
      <button class="q-soft" data-q-full>${QI.shrink}<span>Свернуть</span></button>
    </div>
    <p class="q-note">Подход засчитается в серию, даже если дело не закончено</p>
  </div>`;
}
function qAwardHTML(a) {
  const next = qBasket().length;
  return `<div class="q-done-bar">
    <span class="q-tick">${QI.check}</span>
    <div class="q-t"><b>${qe(a.title)}</b><span>${qe(a.line)} · серия ${a.streak} ${qPlural(a.streak, "день", "дня", "дней")}</span></div>
    ${next ? `<button class="q-go" data-q-next>${QI.play}<span>Дальше</span></button>` : ""}
    <button class="q-ic" data-q-home title="Закрыть">${QI.x}</button>
  </div>`;
}
function qBody() {
  if (!Q.loaded || (Q.loading && !Q.notes.length)) return '<div class="empty">Загружаю дела из хранилища…</div>';
  if (Q.error === "login") return '<div class="q-state"><b>Нужен вход</b><p>Дела из хранилища лежат в облаке — войди в аккаунт (значок человечка справа сверху).</p></div>';
  if (Q.error && !Q.notes.length) return `<div class="q-state"><b>${Q.error === "offline" ? "Нет интернета" : "Облако не ответило"}</b><p>Попробую снова через минуту.</p><button class="q-soft" data-q-reload>Повторить сейчас</button></div>`;
  const t = qTimer();
  if (t && Q.timerFull) return qFocusHTML(t);
  const award = Q.award ? qAwardHTML(Q.award) : "";

  const basket = qBasket();
  if (Q.tab === "basket") {
    if (basket.length) {
      const min = basket.reduce((a, e) => a + (e.note.minutes === 15 ? 15 : 5), 0);
      return award + `<div class="q-sum"><span>${basket.length} ${qPlural(basket.length, "дело", "дела", "дел")} · около ${min} мин</span><span class="q-sum-hint">Слева у дела выбери 5 или 15 минут</span></div>
        <div class="list">${basket.sort((a, b) => (t && b.key === t.key) - (t && a.key === t.key)).map(qItemBasket).join("")}</div>`;
    }
    const doneToday = Q.notes.filter(n => qIsDone(n) && qDoneDay(n) === qDay()).length;
    if (doneToday) return award + `<div class="q-state cleared"><div class="q-cheer">${Q_CHEERS[doneToday % Q_CHEERS.length]}</div>
      <p>Сегодня закрыто ${doneToday} ${qPlural(doneToday, "дело", "дела", "дел")} · серия ${qStreak().n} ${qPlural(qStreak().n, "день", "дня", "дней")}</p>
      <div class="q-focus-acts"><button class="q-soft" data-q-tab="all">Взять ещё из «Всё»</button></div></div>`;
    return `<div class="q-state"><b>Пока ничего не в работе</b><p>Набери дела на сегодня: из «Всё из хранилища» или попроси подобрать быстрые. У каждого дела выберешь 5 или 15 минут и нажмёшь «Поехали».</p>
      <div class="q-focus-acts"><button class="q-big" data-q-suggest>${QI.bolt}<span>Подобрать быстрые</span></button><button class="q-soft" data-q-tab="all">Открыть «Всё»</button></div></div>`;
  }
  if (Q.tab === "remember") {
    const list = Q.notes.filter(n => n.kind === "не забыть" && n.status !== "сделано");
    Q.visible = list;
    return (list.length ? qToolbar(list, false) : "") + `<div class="list">${list.map(n => qItemPlain(n, { cls: "alarm", meta: qe(n.source || "") })).join("") || '<div class="empty">Ничего не висит — всё, что было «не забыть», закрыто.</div>'}</div>`;
  }
  if (Q.tab === "done") {
    const all = Q.notes.filter(qIsDone).sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
    const day = all.filter(n => qDoneDay(n) === qDay());
    const item = n => `<div class="q-done"><span class="q-tick">${QI.check}</span><span class="q-t"><b>${qe(n.title)}</b><span>${n.status === "изучено" ? "изучено · " : ""}${qDoneDay(n)}</span></span></div>`;
    const block = (k, label, arr, def) => {
      const shown = Q.folds[k] ?? def;
      return `<button class="q-fold" data-q-fold="${k}" aria-expanded="${shown}"><span>${label}</span><span class="n">${arr.length}</span><span class="q-chev${shown ? " open" : ""}">${QI.chev}</span></button>
        ${shown ? `<div class="list">${arr.map(item).join("") || '<div class="empty">Пока пусто</div>'}</div>` : ""}`;
    };
    return block("today", "Сегодня", day, true) + block("all", "Всё сделанное", all, false);
  }
  const q = Q.q.trim().toLowerCase();
  const live = Q.notes.filter(n => n.status !== "сделано" && (!q || (n.title || "").toLowerCase().includes(q) || (n.excerpt || "").toLowerCase().includes(q)));
  const groups = Q_ORDER.map(g => {
    const list = live.filter(n => qGroup(n) === g);
    if (!list.length) return "";
    const shown = Q.folds["g:" + g] ?? true;
    const cls = g === "Идеи" ? "idea" : g === "Не забыть" ? "alarm" : "grey";
    return `<button class="q-fold ${cls}" data-q-fold="g:${g}" aria-expanded="${shown}"><span>${g}</span><span class="n">${list.length}</span><span class="q-chev${shown ? " open" : ""}">${QI.chev}</span></button>
      ${shown ? `<div class="list">${list.map(n => {
        const steps = n.steps || [];
        const meta = steps.length ? `${steps.filter(s => s.done).length} из ${steps.length} шагов${n.starts ? ` · ${n.starts} ${qPlural(n.starts, "подход", "подхода", "подходов")}` : ""}` : `${qe(n.source || "")}${n.minutes ? ` · ${n.minutes} мин` : ""}`;
        return qItemPlain(n, { cls, meta });
      }).join("")}</div>` : ""}`;
  }).join("");
  Q.visible = live;
  return qToolbar(live, true) + (groups || '<div class="empty">Ничего не нашлось</div>');
}
function qSide() {
  const st = qStreak(), { n, today } = st;
  const on = new Set(), ice = new Set();
  if (n) {
    let d = new Date((Q.settings.streak_day || qDay()) + "T12:00:00"), left = n;
    while (left > 0) { const k = qDay(d); if (k === st.frozen) ice.add(k); else { on.add(k); left--; } d.setDate(d.getDate() - 1); }
  }
  if (st.pending) ice.add(qYesterday());
  const cells = [...Array(14)].map((_, i) => {
    const k = qAgo(13 - i);
    return `<i class="${on.has(k) ? "on" : ice.has(k) ? "ice" : ""}${i === 13 ? " today" : ""}"${ice.has(k) ? ' title="Заморозка: пропуск не сжёг серию"' : ""}></i>`;
  }).join("");
  const iceLine = st.pending ? "вчера пропуск — сделай подход сегодня, заморозка спасёт серию" : st.free ? "❄ заморозка на этой неделе есть" : "❄ заморозка на этой неделе потрачена";
  const r = qRank();
  const pct = r.next ? Math.round(100 * (r.total - r.cur[0]) / (r.next[0] - r.cur[0])) : 100;
  const basket = qBasket();
  return `<div class="q-card q-streak">
      <div class="q-big-n"><b>${n}</b><span>${qPlural(n, "день", "дня", "дней")} подряд</span></div>
      <div class="q-chain" title="Клетка — день. Закрашена, если в этот день был хоть один подход">${cells}</div>
      <div class="q-chain-l"><span>2 недели назад</span><span>${today ? "сегодня есть" : "сегодня — ещё нет"}</span></div>
      <div class="q-ice${st.pending ? " warn" : ""}" title="Один пропущенный день в неделю не обнуляет серию">${iceLine}</div>
    </div>
    <div class="q-card q-rank">
      <div class="q-rank-h"><span>Звание</span><b>${r.cur[1]}</b></div>
      <div class="q-rank-bar"><i style="width:${pct}%"></i></div>
      <div class="q-rank-l"><span>${r.cur[1]}</span><span>${r.next ? `${r.next[1]} · ещё ${r.next[0] - r.total}` : "высшее звание"}</span></div>
    </div>
    ${qTimer() ? "" : `<div class="q-card q-mini">
      <button class="q-soft wide" data-q-suggest>${QI.bolt}<span>Подобрать быстрые</span></button>
      <div class="q-mini-l">${basket.length ? `В работе ${basket.length} · до ночи` : "Список обнуляется ночью"}</div>
    </div>`}`;
}
function renderQuick() {
  if ((!Q.loaded || (Q.error === "login" && typeof user !== "undefined" && user)) && !Q.loading) qLoad(true);
  if (!Q.poll) Q.poll = setInterval(() => { if (view.mode === "quick" && !document.hidden) qLoad(true); }, 60e3);
  qEnsureTick();

  $("h1Plain").hidden = false; $("h1Plain").textContent = "Быстрые дела";
  $("h1Lead").hidden = true; $("period").hidden = true; $("steps").hidden = true;
  $("barFill").parentElement.hidden = true; $("pct").hidden = true;
  const live = Q.notes.filter(n => n.status !== "сделано").length;
  $("dateLine").textContent = Q.loaded && !Q.error ? (isMobile() ? `${live} ${qPlural(live, "заметка", "заметки", "заметок")} в хранилище` : `Всё из хранилища · ${live} ${qPlural(live, "заметка", "заметки", "заметок")}`) : "Всё из хранилища";
  $("prog").textContent = "";
  $("board").classList.remove("week-mode");
  $("aim").hidden = isMobile(); $("aimInline").hidden = true; $("collapse").hidden = true; $("toTasks").hidden = !isMobile();
  document.querySelector(".main").classList.remove("bucket-view");
  document.querySelector(".main").classList.add("quick-view");
  $("carryBtn").hidden = true;
  sideCal._show(TODAY);

  const focused = document.activeElement?.id === "qSearch";
  const caret = focused ? document.activeElement.selectionStart : 0;
  const t = qTimer(), basket = Q.loaded ? qBasket() : [];
  const counts = {
    basket: basket.length,
    remember: Q.notes.filter(n => n.kind === "не забыть" && n.status !== "сделано").length,
    done: Q.notes.filter(n => qIsDone(n) && qDoneDay(n) === qDay()).length,
    all: Q.notes.filter(n => n.status !== "сделано").length,
  };
  const tabs = [["basket", "Сделать быстро", "Быстро"], ["remember", "Не забыть", "Не забыть"], ["done", "Сделано", "Сделано"], ["all", "Всё из хранилища", "Всё"]];
  $("board").innerHTML = `<div class="q${t && Q.timerFull ? " focusing" : ""}">
    <div class="q-main">
      ${t && Q.timerFull ? "" : `<div class="q-tabs">${tabs.map(([k, l, sh]) => `<button class="${Q.tab === k ? "on" : ""}${k === "remember" ? " alarm" : ""}" data-q-tab="${k}"><span class="l-full">${l}</span><span class="l-short">${sh}</span>${counts[k] ? `<span class="n">${counts[k]}</span>` : ""}</button>`).join("")}</div>`}
      <div class="q-body">${qRunbar()}${qBody()}</div>
    </div>
    <aside class="q-side">${Q.loaded && !Q.error ? qSide() : ""}</aside>
  </div>`;
  if (focused) { const s = $("qSearch"); s.focus(); s.setSelectionRange(caret, caret); }
  qTick();
}

/* ---------- свайп влево на телефоне: «В работу» и «Удалить», длинный свайп — сразу в корзину ---------- */
let qSw = null;
function qSwipeClose(anim = true) {
  const line = Q.swOpen; Q.swOpen = null;
  if (!line) return;
  line.style.transition = anim ? "transform .2s ease" : "none"; line.style.transform = "";
  setTimeout(() => { if (Q.swOpen !== line) line.parentElement.classList.remove("swiping"); }, anim ? 220 : 0);
}
$("board").addEventListener("touchstart", e => {
  if (!isMobile() || view.mode !== "quick" || Q.sel || e.touches.length > 1) return;
  const line = e.target.closest(".q-line"); if (!line || !line.closest(".q-swipe")) { if (Q.swOpen && !e.target.closest(".q-under")) qSwipeClose(); return; }
  if (Q.swOpen && Q.swOpen !== line) qSwipeClose();
  const under = line.parentElement.querySelector(".q-under");
  qSw = { line, under, x: e.touches[0].clientX, y: e.touches[0].clientY, base: Q.swOpen === line ? -under.offsetWidth : 0, dx: 0, lock: null };
}, { passive: true });
$("board").addEventListener("touchmove", e => {
  if (!qSw) return;
  const dx = e.touches[0].clientX - qSw.x, dy = e.touches[0].clientY - qSw.y;
  if (!qSw.lock && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) qSw.lock = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
  if (qSw.lock !== "x") return;
  e.preventDefault();
  qSw.line.parentElement.classList.add("swiping");
  let x = Math.min(0, qSw.base + dx);
  if (qSw.base + dx > 0) x = Math.min(24, (qSw.base + dx) * 0.25);
  qSw.dx = x;
  qSw.line.style.transition = "none"; qSw.line.style.transform = `translateX(${x}px)`;
  qSw.line.parentElement.classList.toggle("q-far", x < -qSw.line.offsetWidth * 0.55);
}, { passive: false });
$("board").addEventListener("touchend", () => {
  const sw = qSw; qSw = null;
  if (!sw || sw.lock !== "x") return;
  Q.swipedAt = Date.now();
  const w = sw.line.offsetWidth, open = sw.under.offsetWidth;
  sw.line.parentElement.classList.remove("q-far");
  sw.line.style.transition = "transform .2s ease";
  if (sw.dx < -w * 0.55) {
    sw.line.style.transform = `translateX(${-w}px)`;
    const id = sw.line.parentElement.dataset.note;
    setTimeout(() => qTrash([id]), 180);
    Q.swOpen = null;
  } else if (sw.dx < -44) {
    sw.line.style.transform = `translateX(${-open}px)`; Q.swOpen = sw.line;
  } else {
    sw.line.style.transform = ""; if (Q.swOpen === sw.line) Q.swOpen = null;
    setTimeout(() => { if (Q.swOpen !== sw.line) sw.line.parentElement.classList.remove("swiping"); }, 220);
  }
}, { passive: true });

/* ---------- клики ---------- */
$("board").addEventListener("click", e => {
  if (view.mode !== "quick") return;
  if (Date.now() - (Q.swipedAt || 0) < 350) return;
  if (Q.swOpen && !e.target.closest(".q-under")) { qSwipeClose(); return; }
  Q.swOpen = null;
  const b = e.target.closest("button"); if (!b) return;
  const d = b.dataset;
  if (d.qFull !== undefined) { Q.timerFull = !Q.timerFull; return render(); }
  if (d.qTab) { Q.tab = d.qTab; Q.award = null; Q.sel = null; return render(); }
  if (d.qTrash) return qTrash([d.qTrash]);
  if (d.qSelStart !== undefined) { Q.sel = new Set(); Q.open = {}; return render(); }
  if (d.qSelCancel !== undefined) { Q.sel = null; return render(); }
  if (d.qSel) {
    if (Q.sel.has(d.qSel)) { Q.sel.delete(d.qSel); Q.selLast = [...Q.sel].pop() || null; }
    else { Q.sel.add(d.qSel); Q.selLast = d.qSel; }
    return render();
  }
  if (d.qSelAll !== undefined) {
    const list = Q.visible || [];
    const all = list.length && list.every(x => Q.sel.has(x.id));
    list.forEach(x => all ? Q.sel.delete(x.id) : Q.sel.add(x.id));
    return render();
  }
  if (d.qSelTrash !== undefined) { const ids = [...Q.sel]; Q.sel = null; return qTrash(ids); }
  if (d.qSelTake !== undefined) {
    const picked = Q.notes.filter(n => Q.sel.has(n.id) && !(n.steps || []).length && !n.basket);
    const withSteps = Q.notes.filter(n => Q.sel.has(n.id) && (n.steps || []).length).length;
    picked.forEach(n => { n.basket = true; n.basket_day = qDay(); qChange(n, "basket", { basket: true }); });
    Q.sel = null; render();
    return toast(`В работу: ${picked.length}${withSteps ? ` · у ${withSteps} есть шаги — шаги бери по одному` : ""}`);
  }
  if (d.qReload !== undefined) { Q.error = ""; return qLoad(true); }
  if (d.qFold) { Q.folds[d.qFold] = !(Q.folds[d.qFold] ?? (d.qFold !== "all")); return render(); }
  if (d.qOpen) { Q.open[d.qOpen] = !Q.open[d.qOpen]; return render(); }
  if (d.qToggle) { const n = Q.notes.find(x => x.id === d.qToggle); return n && qToggleBasket(n); }
  if (d.qStep) { const [id, i] = d.qStep.split(":"); const n = Q.notes.find(x => x.id === id); return n && qToggleStep(n, +i); }
  if (d.qSetmin) {
    const en = qFind(d.key), m = +d.qSetmin;
    if (!en || en.note.minutes === m) return;
    en.note.minutes = m; qChange(en.note, "minutes", { minutes: m }); return render();
  }
  if (d.qStart) { const en = qFind(d.qStart); return en && qStart(en); }
  if (d.qDrop) {
    const en = qFind(d.qDrop); if (!en) return;
    return en.step ? qToggleStep(en.note, en.step.i) : qToggleBasket(en.note);
  }
  if (d.qDone) {
    const en = qFind(d.qDone); if (!en) return;
    const line = qFinish(en, { credit: false });
    render(); return toast(line);
  }
  if (d.qSuggest !== undefined) {
    const pick = Q.notes.filter(n => n.quick && n.status !== "сделано" && !n.basket && !(n.steps || []).length).slice(0, 3);
    pick.forEach(n => { n.basket = true; n.basket_day = qDay(); qChange(n, "basket", { basket: true }); });
    Q.tab = "basket"; render();
    return toast(pick.length ? `В работу ${pick.length} ${qPlural(pick.length, "быстрое дело", "быстрых дела", "быстрых дел")}` : "Быстрых дел нет — загляни во «Всё»");
  }
  if (d.qTimer) {
    const t = qTimer(); if (!t) return render();
    const en = qFind(t.key);
    if (d.qTimer === "more") {
      qStore("bd-timer", { ...t, end: Date.now() + 15 * 60e3, full: 15 * 60, rang: false });
      if (en) qCredit(en.note);
      render(); return toast("Второй подход пошёл");
    }
    qStore("bd-timer"); clearInterval(Q.tick); Q.tick = null; document.title = "Быстродел"; Q.timerFull = false;
    if (!en) return render();
    if (d.qTimer === "stop") {
      qCredit(en.note).then(render);
      render(); return toast(`Подход засчитан: ${t.title}`);
    }
    const line = qFinish(en);
    const s = qStreak();
    Q.award = { title: t.title, line, streak: Math.max(s.n, s.today ? s.n : s.n + 1) };
    return render();
  }
  if (d.qNext !== undefined) { Q.award = null; const list = qBasket(); return list.length ? qStart(list[0]) : render(); }
  if (d.qHome !== undefined) { Q.award = null; Q.tab = "basket"; return render(); }
});
$("board").addEventListener("toggle", e => { if (e.target.classList?.contains("q-focus-text")) Q.focusText = e.target.open; }, true);
$("board").addEventListener("input", e => {
  if (e.target.id !== "qSearch") return;
  Q.q = e.target.value; render();
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && Q.sel && view.mode === "quick") { Q.sel = null; render(); } }, true);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { qTick(); if (view.mode === "quick") qLoad(); } });
qEnsureTick();
setTimeout(() => { if (typeof user !== "undefined" && user && !Q.loaded) qLoad(); }, 4000);
try { if (localStorage.getItem("bd-view") === "quick") go("quick", "quick"); } catch {}
