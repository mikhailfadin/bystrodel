// Быстродел — Mini App. Данные живут в Obsidian, здесь только окно к ним.
const SUPA_URL = "https://yqumtlykftuxswbhnfru.supabase.co";
const SUPA_KEY = "sb_publishable_swH79jNgc-iQc04BGmSldw_3n9na-Uy";
const TG = window.Telegram?.WebApp;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ORDER = ["Быстрые", "Актуальное", "В работе", "Новые", "Идеи", "Цели", "WIKI", "Контент", "Гипотезы", "Разобрать", "Когда-нибудь"];
const RANKS = [[0, "Авральщик"], [10, "Догоняющий"], [30, "Успевающий"], [70, "На шаг впереди"], [150, "Разгребатель"]];
const CHEERS = ["Разобрал всё, что взял", "Корзина пуста, и голова тоже", "Взял и сделал. Редкое дело", "Сегодня разгребли, завтра не копится"];
const today = () => new Date().toISOString().slice(0, 10);

let token = null, notes = [], settings = null;
const st = { tab: "work", minutes: 5, cur: null, curStep: null, left: 0, full: 0, timer: null, folds: {}, stepsOf: null };

/* ---------- сеть ---------- */
async function rest(path, { method = "GET", body, prefer } = {}) {
  const r = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPA_KEY, Authorization: `Bearer ${token}`,
      "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
  const text = await r.text();
  return text ? JSON.parse(text) : [];
}
const change = (note, op, value) => rest("bd_changes", { method: "POST", body: [{ note_id: note.id, op, value }] }).catch(e => toast("Не ушло в Obsidian: " + e.message));

async function auth(email, password) {
  const r = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: SUPA_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  if (!r.ok) throw new Error("почта или пароль не подошли");
  const data = await r.json();
  localStorage.setItem("bd-session", JSON.stringify({ ...data, saved_at: Date.now() }));
  token = data.access_token;
}
async function restore() {
  const raw = localStorage.getItem("bd-session");
  if (!raw) return false;
  const s = JSON.parse(raw);
  if (s.saved_at + (s.expires_in - 120) * 1000 > Date.now()) { token = s.access_token; return true; }
  const r = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST", headers: { apikey: SUPA_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: s.refresh_token })
  });
  if (!r.ok) { localStorage.removeItem("bd-session"); return false; }
  const data = await r.json();
  localStorage.setItem("bd-session", JSON.stringify({ ...data, saved_at: Date.now() }));
  token = data.access_token;
  return true;
}

/* ---------- данные ---------- */
async function load() {
  notes = await rest("bd_notes?deleted=is.false&select=*&order=updated_at.desc");
  const rows = await rest("bd_settings?select=*");
  settings = rows[0] || { limit_min: 15, streak: 0, streak_day: null, keys: [], signs: [] };
  st.minutes = 5;
  draw();
}
const basket = () => {
  const out = [];
  notes.forEach(n => {
    if (n.status === "сделано") return;
    const steps = (n.steps || []).map((s, i) => ({ ...s, i })).filter(s => s.basket && !s.done);
    if (steps.length) steps.forEach(s => out.push({ note: n, step: s }));
    else if (n.basket) out.push({ note: n, step: null });
  });
  return out;
};
const groupOf = n => {
  if (n.quick && n.status !== "сделано") return "Быстрые";
  if (["актуальное", "в работе", "когда-нибудь"].includes(n.status)) return n.status[0].toUpperCase() + n.status.slice(1);
  return { "идея": "Идеи", "цель": "Цели", "материал": "WIKI", "контент": "Контент", "гипотеза": "Гипотезы", "разобрать": "Разобрать" }[n.kind] || "Новые";
};
const rankOf = total => { let r = RANKS[0], nx = null; RANKS.forEach((x, i) => { if (total >= x[0]) { r = x; nx = RANKS[i + 1] || null } }); return { r, nx } };

/* ---------- отрисовка ---------- */
function drawStreak() {
  const streak = settings.streak || 0, doneToday = settings.streak_day === today();
  const chain = $("chain"); chain.innerHTML = "";
  for (let i = 0; i < 14; i++) {
    const d = document.createElement("i"), isToday = i === 13;
    const filled = isToday ? doneToday : i >= 13 - streak;
    d.className = "day" + (filled ? " on" : "") + (isToday ? " today" : "");
    chain.appendChild(d);
  }
  const total = notes.filter(n => n.status === "сделано").length + (settings.total_done || 0);
  const { r, nx } = rankOf(total);
  $("streakBig").textContent = streak;
  $("streakBig").nextElementSibling.textContent = streak % 10 === 1 && streak % 100 !== 11 ? "день подряд" : (streak % 10 > 1 && streak % 10 < 5 ? "дня подряд" : "дней подряд");
  $("rankName").textContent = r[1];
  $("rankFrom").textContent = r[1];
  $("rankTo").textContent = nx ? `${nx[1]} · ещё ${nx[0] - total}` : "высшее звание";
  $("rankFill").style.width = nx ? `${Math.round(100 * (total - r[0]) / (nx[0] - r[0]))}%` : "100%";
}
function row(title, { minutes, sub, cls = "", onclick }) {
  const b = document.createElement("button");
  b.className = "item " + (minutes ? "" : "plain ") + cls;
  b.innerHTML = (minutes ? `<span class="min">${st.minutes}<small>мин</small></span>` : "") +
    `<span><span class="t">${esc(title)}</span><span class="meta">${sub || ""}</span></span>`;
  b.onclick = onclick; return b;
}
function drawBasket() {
  const list = basket(), box = $("basketList"); box.innerHTML = "";
  $("basketEmpty").hidden = list.length > 0;
  $("cWork").textContent = list.length || "";
  const doneToday = notes.filter(n => n.status === "сделано" && (n.updated_at || "").slice(0, 10) === today());
  const cleared = !list.length && doneToday.length > 0;
  $("cleared").hidden = !cleared; $("emptyLine").hidden = cleared;
  $("toAll").textContent = cleared ? "Взять ещё из «Всё»" : "Набрать во «Всё»";
  if (cleared) {
    $("cheerLine").textContent = CHEERS[doneToday.length % CHEERS.length];
    const n = doneToday.length;
    $("cheerSub").textContent = `Сегодня закрыто ${n} ${n === 1 ? "дело" : (n < 5 ? "дела" : "дел")} · серия ${settings.streak || 0} дней`;
  }
  list.forEach(e => box.appendChild(row(e.step ? e.step.t : e.note.title, {
    minutes: true,
    sub: e.step ? `${esc(e.note.title)} · шаг ${e.step.i + 1} из ${e.note.steps.length}` : `${esc(e.note.source)} · оценка ${e.note.minutes} мин`,
    onclick: () => start(e)
  })));
}
function drawRemember() {
  const box = $("rememberList"); box.innerHTML = "";
  const list = notes.filter(n => n.kind === "не забыть" && n.status !== "сделано");
  if (!list.length) box.innerHTML = '<p class="empty">Пусто</p>';
  list.forEach(n => box.appendChild(row(n.title, { sub: esc(n.source), cls: "alarm", onclick: () => toggleBasket(n) })));
}
function drawDone() {
  const all = notes.filter(n => n.status === "сделано");
  const day = all.filter(n => (n.updated_at || "").slice(0, 10) === today());
  const item = n => `<div class="doneitem"><span class="check">✓</span><span><span class="t">${esc(n.title)}</span><span class="meta">${(n.updated_at || "").slice(0, 10)}</span></span></div>`;
  const block = (key, label, arr, open) => {
    const shown = st.folds[key] ?? open;
    return `<button class="fold" data-fold="${key}" aria-expanded="${shown}"><span>${label}</span>
      <span style="display:flex;gap:8px;align-items:center"><span class="n">${arr.length}</span><span class="arrow">▾</span></span></button>
      <div class="list" ${shown ? "" : "hidden"}>${arr.length ? arr.map(item).join("") : '<p class="empty">Пока пусто</p>'}</div>`;
  };
  $("doneList").innerHTML = block("today", "Сегодня", day, true) + block("all", "Всё сделанное", all, false);
  $("doneList").querySelectorAll("[data-fold]").forEach(b => b.onclick = () => {
    const k = b.dataset.fold; st.folds[k] = !(st.folds[k] ?? (k === "today")); drawDone();
  });
}
function drawAll() {
  const box = $("allList"); box.innerHTML = "";
  const q = ($("search").value || "").trim().toLowerCase();
  const live = notes.filter(n => n.status !== "сделано" && (!q || n.title.toLowerCase().includes(q)));
  ORDER.forEach(g => {
    const list = live.filter(n => groupOf(n) === g);
    if (!list.length) return;
    const head = document.createElement("div");
    head.className = "group" + (g === "Идеи" ? " idea" : "");
    head.innerHTML = `<span>${g}</span><span>${list.length}</span>`; box.appendChild(head);
    const l = document.createElement("div"); l.className = "list";
    list.forEach(n => {
      const steps = n.steps || [];
      const inB = steps.length ? steps.some(s => s.basket && !s.done) : n.basket;
      const sub = steps.length ? `${steps.filter(s => s.done).length} из ${steps.length} шагов${n.starts ? ` · ${n.starts} подходов` : ""}`
        : `${esc(n.source)} · ${n.minutes} мин`;
      const r = row(n.title, { sub, cls: (g === "Идеи" ? "idea " : "") + (inB ? "picked" : "grey"), onclick: () => steps.length ? openSteps(n) : toggleBasket(n) });
      l.appendChild(r);
    });
    box.appendChild(l);
  });
  if (!box.children.length) box.innerHTML = '<p class="empty">Ничего не нашлось</p>';
  const list = basket();
  $("basketbar").hidden = st.tab !== "all" || !list.length;
  $("basketInfo").textContent = `В корзине ${list.length} · ~${list.length * st.minutes} мин`;
}
const draw = () => { drawStreak(); drawBasket(); drawRemember(); drawDone(); drawAll(); };

/* ---------- действия ---------- */
function toast(m) { const t = $("toast"); t.textContent = m; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => t.hidden = true, 2600); }
const buzz = kind => TG?.HapticFeedback?.impactOccurred?.(kind || "light");
function toggleBasket(n) {
  n.basket = !n.basket; n.basket_day = today();
  change(n, "basket", { basket: n.basket }); buzz();
  draw(); toast(n.basket ? `«${n.title}» — в корзине` : `«${n.title}» убрано`);
}
function openSteps(n) {
  st.stepsOf = n;
  $("sheetTitle").textContent = n.title;
  $("sheetSub").textContent = `${(n.steps || []).filter(s => s.done).length} из ${n.steps.length} шагов${n.starts ? ` · ${n.starts} подходов` : ""} · шаги лежат в заметке`;
  const box = $("sheetSteps"); box.innerHTML = "";
  n.steps.forEach((s, i) => {
    const b = document.createElement("button");
    b.className = "step" + (s.done ? " done" : "") + (s.basket ? " inbasket" : "");
    b.innerHTML = `<span class="box">${s.done ? "✓" : ""}</span><span>${esc(s.t)}</span>`;
    b.onclick = () => { if (s.done) return; s.basket = !s.basket; buzz(); openSteps(n); draw(); };
    box.appendChild(b);
  });
  $("sheet").hidden = false;
}
function setTab(tab) {
  st.tab = tab; $("sheet").hidden = true;
  ["work", "remember", "done", "all", "crit", "focus", "award"].forEach(k => $("v-" + k).hidden = k !== tab);
  $("tabbar").hidden = false; $("screen").classList.remove("focus", "timeup");
  document.querySelectorAll("#tabbar button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === tab));
  draw();
}
function overlay(name) {
  ["work", "remember", "done", "all", "crit", "focus", "award"].forEach(k => $("v-" + k).hidden = k !== name);
  $("tabbar").hidden = name === "focus" || name === "award";
  $("basketbar").hidden = true; $("sheet").hidden = true;
  $("screen").classList.toggle("focus", name === "focus");
  $("screen").classList.remove("timeup");
}
const fmt = s => String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
function tick() {
  $("clock").textContent = fmt(Math.max(0, st.left));
  $("arc").setAttribute("stroke-dashoffset", (326.73 * (1 - Math.max(0, st.left) / st.full)).toFixed(2));
  if (st.left <= 0) { clearInterval(st.timer); $("screen").classList.add("timeup"); $("clockSub").textContent = "время вышло"; buzz("heavy"); }
}
const run = () => { clearInterval(st.timer); st.timer = setInterval(() => { st.left--; tick(); }, 1000); };
function start(entry) {
  st.cur = entry.note; st.curStep = entry.step;
  st.full = st.minutes * 60; st.left = st.full;
  $("fparent").textContent = entry.step ? entry.note.title : "быстрое дело";
  $("ftitle").textContent = entry.step ? entry.step.t : entry.note.title;
  $("clockSub").textContent = "осталось";
  overlay("focus"); tick(); run();
}
async function credit() {
  st.cur.starts = (st.cur.starts || 0) + 1;
  change(st.cur, "start", { starts: st.cur.starts });
  if (settings.streak_day !== today()) {
    settings.streak = (settings.streak || 0) + 1; settings.streak_day = today();
    await rest("bd_settings", { method: "POST", body: [{ streak: settings.streak, streak_day: settings.streak_day }], prefer: "resolution=merge-duplicates" }).catch(() => { });
  }
}
/* ---------- тема ---------- */
const THEMES = ["auto", "light", "dark"];
function applyTheme() {
  const mode = localStorage.getItem("bd-theme") || "auto";
  const root = document.documentElement;
  if (mode === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
  const dark = mode === "dark" || (mode === "auto" && (TG?.colorScheme === "dark" || matchMedia("(prefers-color-scheme: dark)").matches));
  const btn = $("themeBtn");
  if (btn) { btn.textContent = mode === "auto" ? "A" : (dark ? "☾" : "☀︎"); btn.title = { auto: "Тема как в системе", light: "Светлая тема", dark: "Тёмная тема" }[mode]; }
  const bg = getComputedStyle(root).getPropertyValue("--screen").trim();
  TG?.setBackgroundColor?.(bg); TG?.setHeaderColor?.(bg);
}

/* ---------- запуск ---------- */
function wire() {
  document.querySelectorAll("#tabbar button").forEach(b => b.onclick = () => setTab(b.dataset.tab));
  document.querySelectorAll("[data-min]").forEach(b => b.onclick = () => {
    st.minutes = +b.dataset.min;
    document.querySelectorAll("[data-min]").forEach(x => x.setAttribute("aria-pressed", x === b));
    drawBasket(); drawAll();
  });
  $("toAll").onclick = () => setTab("all");
  $("suggest").onclick = () => {
    const pick = notes.filter(n => n.quick && n.status !== "сделано" && !n.basket).slice(0, 3);
    pick.forEach(n => { n.basket = true; change(n, "basket", { basket: true }); });
    draw(); toast(pick.length ? "Агент положил быстрые дела" : "Быстрых дел нет — загляни во «Всё»");
  };
  $("goWork").onclick = () => setTab("work");
  $("themeBtn").onclick = () => {
    const now = localStorage.getItem("bd-theme") || "auto";
    localStorage.setItem("bd-theme", THEMES[(THEMES.indexOf(now) + 1) % THEMES.length]);
    applyTheme(); buzz();
  };
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  $("search").oninput = drawAll;
  $("critBtn").onclick = () => {
    // тот же значок закрывает настройки — возвращаемся туда, где были
    if ($("v-crit").hidden) { st.back = st.tab; overlay("crit"); }
    else setTab(st.back || "work");
  };
  $("critBack").onclick = () => setTab(st.back || "work");
  $("sheet").onclick = e => { if (e.target === $("sheet")) $("sheet").hidden = true; };
  $("sheetClose").onclick = () => $("sheet").hidden = true;
  $("demoBtn")?.remove();
  $("moreBtn").onclick = async () => {
    await credit(); st.minutes = 15;
    document.querySelectorAll("[data-min]").forEach(x => x.setAttribute("aria-pressed", x.dataset.min === "15"));
    st.full = 15 * 60; st.left = st.full;
    $("screen").classList.remove("timeup"); $("clockSub").textContent = "осталось"; tick(); run();
    toast("Второй подход пошёл");
  };
  $("stopBtn").onclick = async () => {
    clearInterval(st.timer); await credit();
    const name = st.curStep ? st.curStep.t : st.cur.title;
    setTab("work"); toast(`«${name}» начат, подход засчитан`);
  };
  $("doneBtn").onclick = async () => {
    clearInterval(st.timer); await credit();
    let text;
    if (st.curStep) {
      const real = st.cur.steps[st.curStep.i];
      real.done = true; real.basket = false; st.curStep.done = true;
      change(st.cur, "step", { index: st.curStep.i, done: true });
      const left = st.cur.steps.filter(s => !s.done).length;
      if (!left) { st.cur.status = "сделано"; st.cur.updated_at = new Date().toISOString(); change(st.cur, "status", { status: "сделано" }); }
      text = left ? `Шаг закрыт · осталось ${left} из ${st.cur.steps.length}\nЧекбокс отмечен в заметке`
        : `Задача «${st.cur.title}» закрыта целиком\nКарточка ушла в «✅ Готово»`;
    } else {
      st.cur.status = "сделано"; st.cur.basket = false; st.cur.updated_at = new Date().toISOString();
      change(st.cur, "status", { status: "сделано" });
      text = "Дело закрыто · в заметке «сделано»\nКарточка ушла в «✅ Готово»";
    }
    buzz("medium");
    $("awardText").textContent = `Серия ${settings.streak} ${settings.streak % 10 === 1 && settings.streak % 100 !== 11 ? "день" : (settings.streak % 10 > 1 && settings.streak % 10 < 5 ? "дня" : "дней")} подряд\n${text}`;
    overlay("award"); draw();
  };
  $("againBtn").onclick = () => { const list = basket(); list.length ? start(list[0]) : setTab("work"); };
  $("homeBtn").onclick = () => setTab("work");
  $("enter").onclick = async () => {
    try {
      $("gateMsg").textContent = "Проверяю…";
      await auth($("mail").value.trim(), $("pass").value);
      $("gate").hidden = true; $("screen").hidden = false;
      await load(); setTab("work");
    } catch (e) { $("gateMsg").textContent = e.message; }
  };
}
(async () => {
  TG?.ready?.(); TG?.expand?.();
  applyTheme();
  wire();
  const ok = await restore().catch(() => false);
  if (!ok) { $("screen").hidden = true; $("gate").hidden = false; return; }
  try { await load(); setTab("work"); }
  catch (e) { $("screen").hidden = true; $("gate").hidden = false; $("gateMsg").textContent = "Нужно войти заново"; }
})();
