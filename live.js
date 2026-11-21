// live view: someone's shared stats, read-only, updating the moment they change them.
// opened as live.html?u=<username> (the link from the app's cloud page). anyone with the link can watch.
// timers tick here on their own (from elapsed + since), so only starts, pauses, taps etc. come over the wire.

const SB_URL = "https://ocgnkpvoligvygakairp.supabase.co";
const SB_KEY = "sb_publishable_dHSVpNuTOtU-R9FKxJjJlw_ZcRY8jEu"; // public by design; row-level security guards the data
const REFRESH = 60 * 1000; // ms: a full reload now and then too, in case an update was missed (deletes, a dropped connection)
const $ = (id) => document.getElementById(id);

// same formatting as the app (app.js)
const timeOf = (s) => (Number(s.elapsed) || 0) + (s.since ? Math.max(0, Date.now() - Date.parse(s.since)) : 0);
function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(s / 86400);
  if (d < 365) return `${d}d ${Math.floor((s % 86400) / 3600)}h`;
  return `${Math.floor(d / 365)}y ${d % 365}d`;
}
const valueOf = (s) => (s.kind === "timer" ? fmtTime(timeOf(s)) : s.count);

const shown = new Map(); // stat id → stat
let timerEls = [];

// live: no word, the eye blinks instead. anything else (connecting…, offline, …) is said in words
function setState(text) {
  const live = text === "live";
  $("liveState").textContent = live ? "" : text;
  document.querySelector(".viewing-label").classList.toggle("is-live", live);
}

// the list, like the app's: name greyed on the left, the number on the right. deleted stats aren't shown
function render() {
  const list = $("list");
  list.innerHTML = "";
  timerEls = [];
  const live = [...shown.values()].filter((s) => !s.deleted).sort((a, b) => String(a.created).localeCompare(String(b.created)));
  document.documentElement.classList.toggle("empty", live.length === 0);
  for (const stat of live) {
    const row = document.createElement("div");
    row.className = "row";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = stat.name;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = valueOf(stat);
    if (stat.kind === "timer") {
      count.classList.add("timer");
      count.classList.toggle("paused", !stat.since);
      timerEls.push([count, stat]);
    }
    row.append(name, count);
    list.append(row);
  }
}
setInterval(() => {
  for (const [el, stat] of timerEls) if (stat.since) el.textContent = valueOf(stat);
}, 500);

(async function start() {
  const username = (new URLSearchParams(location.search).get("u") || "").toLowerCase();
  if (!username || !window.supabase) return setState(window.supabase ? "no link" : "offline");
  const db = window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

  // whose stats: the username in the link points at a user
  const { data: share, error } = await db.from("shares").select("user_id").eq("username", username).maybeSingle();
  if (error) return setState("couldn't load");
  if (!share) return setState("not shared (anymore)");
  const uid = share.user_id;

  // everything, now (and again every minute, and whenever the page comes back into view)
  const loadAll = async () => {
    const { data, error } = await db.from("stats").select("id,data").eq("user_id", uid);
    if (error) return setState("couldn't load");
    shown.clear();
    for (const r of data) shown.set(r.id, r.data);
    render();
  };
  await loadAll();
  setInterval(loadAll, REFRESH);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") loadAll();
  });

  // then every change as it happens
  db.channel(`live-${uid}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "stats", filter: `user_id=eq.${uid}` }, (change) => {
      if (change.eventType === "DELETE") shown.delete(change.old.id);
      else shown.set(change.new.id, change.new.data);
      render();
    })
    .subscribe((status) => {
      if (status === "SUBSCRIBED") setState("live");
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setState("reconnecting…");
      else if (status === "CLOSED") setState("disconnected");
    });
})();
