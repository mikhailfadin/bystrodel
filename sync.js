// ── Такт: облако — вход по почте и паролю, синхронизация задач и Фокус бара, работа без сети.
// Данные живут на устройстве (localStorage) и работают без интернета.
// Каждое сохранение сверяется с тем, что уже ушло в облако; изменённое и удалённое догоняет базу.
// С базы приходят изменения других устройств и мака; при споре побеждает более поздняя правка.

const SUPA_URL = "https://yqumtlykftuxswbhnfru.supabase.co";
const SUPA_KEY = "sb_publishable_swH79jNgc-iQc04BGmSldw_3n9na-Uy";

let sb = null, user = null;
const nowIso = () => new Date().toISOString();
const syncStatus = s => window.onSyncStatus?.(s);

// одна таблица: подписи записей, отправка изменённого и удалённого, загрузка чужих правок
function makeSync(o) {
  const blank = () => ({ lastPull: null, sent: {}, dead: {} });
  let st; try { st = Object.assign(blank(), JSON.parse(localStorage.getItem(o.ls))); } catch { st = blank(); }
  let sigs = {}, pushing = false, pulling = false, timer = null;
  const sig = x => JSON.stringify(o.fields.map(f => x[f] ?? null));
  const persist = () => { try { localStorage.setItem(o.ls, JSON.stringify(st)); } catch {} };
  const pending = () => o.list().filter(x => !x.sample && st.sent[x.id] !== sig(x));

  function reset() { sigs = {}; for (const x of o.list()) sigs[x.id] = sig(x); }

  function saved() {
    const t0 = nowIso(), ids = new Set();
    for (const x of o.list()) {
      ids.add(x.id);
      const s = sig(x);
      if (x.sample && sigs[x.id] !== undefined && sigs[x.id] !== s) delete x.sample; // пример поправили — теперь это задача
      if (sigs[x.id] !== s) { if (sigs[x.id] !== undefined || !x.updatedAt) x.updatedAt = t0; sigs[x.id] = s; }
    }
    for (const id of Object.keys(sigs)) {
      if (!ids.has(id)) { delete sigs[id]; if (st.sent[id] !== undefined) st.dead[id] = t0; }
    }
    persist();
    schedule();
  }

  function schedule() { clearTimeout(timer); timer = setTimeout(push, 400); }

  async function push() {
    if (!sb || !user || pushing || !navigator.onLine) { if (sb && user && !navigator.onLine) syncStatus("offline"); return; }
    const changed = pending(), dead = Object.entries(st.dead);
    if (!changed.length && !dead.length) { syncStatus("ok"); return; }
    pushing = true; syncStatus("syncing");
    try {
      const rows = changed.map(x => ({ id: x.id, user_id: user.id, ...o.toRow(x), deleted: false, updated_at: x.updatedAt || nowIso() }))
        .concat(dead.map(([id, at]) => ({ id, user_id: user.id, ...o.deadRow, deleted: true, updated_at: at })));
      const sent = new Map(changed.map(x => [x.id, sig(x)]));
      const { error } = await sb.from(o.table).upsert(rows, { onConflict: "id" });
      if (error) throw error;
      for (const [id, s] of sent) st.sent[id] = s;
      for (const [id] of dead) { delete st.dead[id]; delete st.sent[id]; }
      persist(); syncStatus("ok");
    } catch (e) { console.warn(`синхронизация ${o.table}: отправка`, e); syncStatus("error"); }
    pushing = false;
    if (pending().length) schedule();
  }

  async function pull() {
    if (!sb || !user || pulling || !navigator.onLine) return;
    pulling = true;
    try {
      const since = st.lastPull ? new Date(Date.parse(st.lastPull) - 5 * 60e3).toISOString() : null;
      const list = o.list();
      let touched = false;
      for (let from = 0; ; from += 1000) {
        let q = sb.from(o.table).select("*").order("updated_at", { ascending: true }).order("id", { ascending: true }).range(from, from + 999);
        if (since) q = q.gt("updated_at", since);
        const { data, error } = await q;
        if (error) throw error;
        for (const r of data) {
          const i = list.findIndex(x => x.id === r.id), local = list[i];
          const dirty = local && st.sent[local.id] !== sig(local);
          const newer = !local || !dirty || Date.parse(r.updated_at) >= Date.parse(local.updatedAt || 0);
          if (r.deleted) {
            if (local && newer) { list.splice(i, 1); delete sigs[r.id]; touched = true; }
            delete st.sent[r.id]; delete st.dead[r.id];
          } else if (!st.dead[r.id] && newer) {
            const x = { id: r.id, ...o.fromRow(r), updatedAt: r.updated_at };
            if (!local) { list.push(x); touched = true; }
            else { if (sig(local) !== sig(x)) touched = true; Object.assign(local, x); }
            st.sent[r.id] = sigs[r.id] = sig(x);
          }
          if (!st.lastPull || r.updated_at > st.lastPull) st.lastPull = r.updated_at;
        }
        if (data.length < 1000) break;
      }
      persist();
      if (touched) o.changed();
    } catch (e) { console.warn(`синхронизация ${o.table}: загрузка`, e); syncStatus("error"); }
    pulling = false;
  }

  return { reset, saved, push, pull };
}

const taskSync = makeSync({
  table: "tasks", ls: "takt-sync-v1",
  fields: ["title", "date", "time", "prio", "done", "doneAt", "pos", "carry"],
  list: () => tasks,
  toRow: t => ({ title: t.title, date: t.date, time: t.time || "", prio: !!t.prio, done: !!t.done, done_at: t.doneAt || null, pos: t.pos | 0, carry: t.carry | 0 }),
  deadRow: { title: "", date: "inbox", time: "", prio: false, done: false, done_at: null, pos: 0, carry: 0 },
  fromRow: r => ({ title: r.title, date: r.date, time: r.time || "", prio: r.prio, done: r.done, doneAt: r.done_at, pos: r.pos, carry: r.carry }),
  changed: () => { save(); render(); },
});

const entrySync = makeSync({
  table: "entries", ls: "takt-sync-entries-v1",
  fields: ["at", "kind", "text", "taskId", "closed"],
  list: () => entries,
  toRow: e => ({ at: e.at, kind: e.kind, text: e.text, task_id: e.taskId || null, closed: !!e.closed, source: "takt" }),
  deadRow: { at: "", kind: "task", text: "", task_id: null, closed: false, source: "takt" },
  fromRow: r => ({ at: r.at, kind: r.kind, text: r.text, taskId: r.task_id || null, closed: r.closed }),
  changed: () => { saveEntries(); paintFocus(); },
});

// вызываются приложением после каждого сохранения
function onTasksSaved() { taskSync.saved(); }
function onEntriesSaved() { entrySync.saved(); }
async function pushPending() { await taskSync.push(); await entrySync.push(); }
async function pullChanges() { await taskSync.pull(); await entrySync.pull(); }

// первый вход на устройстве: примеры убираем, своё отправляем, облачное забираем
async function firstSync() {
  const before = tasks.length;
  tasks = tasks.filter(t => !t.sample);
  if (tasks.length !== before) { taskSync.reset(); save(); }
  await pushPending();
  await pullChanges();
  render(); paintFocus();
}

function subscribeLive() {
  sb.channel("takt-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "tasks", filter: `user_id=eq.${user.id}` }, () => taskSync.pull())
    .on("postgres_changes", { event: "*", schema: "public", table: "entries", filter: `user_id=eq.${user.id}` }, () => entrySync.pull())
    .subscribe();
}

async function initCloud() {
  taskSync.reset(); entrySync.reset();
  if (!window.supabase || SUPA_URL.startsWith("__")) { window.onAuthChange?.(null, "нет облака"); return; }
  sb = window.supabase.createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  const { data } = await sb.auth.getSession();
  user = data.session?.user || null;
  window.onAuthChange?.(user);
  sb.auth.onAuthStateChange(async (_e, session) => {
    const was = user;
    user = session?.user || null;
    window.onAuthChange?.(user);
    if (user && !was) { await firstSync(); subscribeLive(); }
  });
  if (user) { await firstSync(); subscribeLive(); }
  window.addEventListener("online", () => { pushPending(); pullChanges(); });
  window.addEventListener("offline", () => syncStatus("offline"));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { pushPending(); pullChanges(); } });
  setInterval(() => { pushPending(); pullChanges(); }, 60e3);
}

async function cloudSignIn(email, password) { return sb ? sb.auth.signInWithPassword({ email, password }) : { error: { message: "облако недоступно" } }; }
async function cloudSignUp(email, password) {
  return sb ? sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } }) : { error: { message: "облако недоступно" } };
}
async function cloudSignOut() { if (sb) await sb.auth.signOut(); }
async function cloudChangePassword(password) { return sb ? sb.auth.updateUser({ password }) : { error: { message: "облако недоступно" } }; }
