// stats: the core app. stats + timers, the list, adding a stat, the stat page, yes / no page,
// export / import. loads first; demo.js, settings.js, welcome.js and start.js build on it.

const KEY = "stats.v1";
const OLD_KEY = "tally.v1"; // data saved before the rename
const SEEN_KEY = "stats.seen";
const $ = (id) => document.getElementById(id);

// counted stat: { id, name, kind: "counter", created, count, highest, deleted?, log }
// timed stat:   { id, name, kind: "timer", created, elapsed, since, highest, deleted?, log }
//   elapsed = ms banked from earlier runs, since = when the current run started (null = paused),
//   highest = longest it has run, in ms
// the log only holds resets and deletes; deleted stats are kept (hidden) so their history survives in backups
let stats = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY) ?? localStorage.getItem(OLD_KEY);
    const data = JSON.parse(raw) || [];
    return Array.isArray(data) ? data.map(normalize) : [];
  } catch {
    return [];
  }
}

// accepts any saved/imported shape, including older versions that logged every tap
function normalize(s) {
  const timer = s.kind === "timer";
  const all = (Array.isArray(s.log) ? s.log : [])
    .map((e, i) =>
      typeof e === "number"
        ? { action: "add", time: new Date(e).toISOString(), count: i + 1 }
        : e && typeof e === "object" && e.action
          ? timer
            ? { action: String(e.action), time: String(e.time || ""), elapsed: Number(e.elapsed) || 0, ...(e.action === "addtime" ? { added: Math.max(0, Number(e.added) || 0) } : {}) }
            : { action: String(e.action), time: String(e.time || ""), count: Number(e.count) || 0 }
          : null
    )
    .filter(Boolean);
  const created = s.created ? String(s.created) : (all[0] && all[0].time) || new Date().toISOString();
  // kept: resets, deletes and restores (taps and pauses aren't logged)
  // (timed stats also keep "addtime": time added by hand)
  // (count / elapsed are only read above, for older files' highest; the kept entries don't carry them)
  const log = all
    .filter((e) => ["reset", "delete", "restore"].includes(e.action) || (timer && e.action === "addtime"))
    .map((e) => (e.action === "addtime" ? { action: e.action, time: e.time, added: e.added } : { action: e.action, time: e.time }));
  const stat = { id: s.id || String(Math.random()), name: String(s.name || "untitled"), kind: timer ? "timer" : "counter", created };
  if (timer) {
    stat.elapsed = Math.max(0, Number(s.elapsed) || 0);
    stat.since = s.since && !isNaN(Date.parse(s.since)) ? String(s.since) : null;
    stat.highest = Math.max(Number(s.highest) || 0, stat.elapsed);
  } else {
    stat.count = Math.max(0, Number(s.count) || 0);
    // older files: work out highest from the full tap history before dropping it
    stat.highest = Math.max(Number(s.highest) || 0, stat.count, ...all.map((e) => e.count || 0));
  }
  if (s.deleted) stat.deleted = String(s.deleted);
  // the latest +1 / −1 (counted) or pause / resume (timed), if there's been one
  const lastOk = timer ? ["pause", "resume", "addtime"] : ["add", "subtract"];
  if (s.last && lastOk.includes(s.last.action) && !isNaN(Date.parse(s.last.time))) {
    stat.last = { action: s.last.action, time: String(s.last.time) };
    if (s.last.action === "addtime") stat.last.added = Math.max(0, Number(s.last.added) || 0);
  }
  else if (!timer) {
    // older files logged every tap: their newest +1 / −1 becomes "last"
    const tap = all.filter((e) => e.action === "add" || e.action === "subtract").at(-1);
    if (tap && !isNaN(Date.parse(tap.time))) stat.last = { action: tap.action, time: tap.time };
  }
  stat.log = log;
  return stat;
}

// a timed stat's running total in ms (banked time + the current run)
const timeOf = (s) => s.elapsed + (s.since ? Math.max(0, Date.now() - Date.parse(s.since)) : 0);

// 45s · 12m 5s · 1h 30m · 3d 6h · 1y 12d — always rounded down, never "2d 30h" or "1h 75m"
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

// what a stat shows: the count, or the formatted time
const valueOf = (s) => (s.kind === "timer" ? fmtTime(timeOf(s)) : s.count);

const visible = () => stats.filter((s) => !s.deleted);

// every change goes through here so the log, count and highest stay in step
function record(stat, action) {
  if (stat.kind === "timer") {
    const time = new Date().toISOString();
    const total = timeOf(stat);
    stat.highest = Math.max(stat.highest, total);
    if (action === "pause") {
      stat.elapsed = total;
      stat.since = null;
    } else if (action === "resume") {
      stat.since = time;
    } else if (action === "reset") {
      stat.elapsed = 0;
      if (stat.since) stat.since = time; // keeps running from zero if it was running
    } else if (action === "delete") {
      stat.elapsed = total;
      stat.since = null;
      stat.deleted = time;
    }
    // pausing / resuming isn't logged, only resets and deletes; the latest pause / resume is kept in "last"
    if (action === "pause" || action === "resume") stat.last = { action, time };
    if (action === "reset" || action === "delete") stat.log.push({ action, time });
    save();
    return;
  }
  if (action === "add") stat.count++;
  else if (action === "subtract") stat.count--;
  else if (action === "reset") stat.count = 0;
  const time = new Date().toISOString();
  if (action === "delete") stat.deleted = time;
  stat.highest = Math.max(stat.highest, stat.count);
  // taps (add / subtract) aren't logged, only the latest one is kept in "last"; resets and deletes are logged
  if (action === "add" || action === "subtract") stat.last = { action, time };
  if (action === "reset" || action === "delete") stat.log.push({ action, time });
  save();
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(stats));
  } catch {}
  if (typeof cloudQueue === "function") cloudQueue(); // logged in: copy the change up to the cloud (cloud.js loads last)
}

// first-timers see an i instead of the star until they've read the guide or imported
function isNew() {
  try {
    return !localStorage.getItem(SEEN_KEY) && visible().length === 0;
  } catch {
    return false;
  }
}
function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {}
  $("intro").hidden = true;
  $("star").hidden = false;
  document.documentElement.classList.remove("fresh"); // off-white → dark
  updateBar();
}

// calls onLong after a hold: the hold time in settings (0.5s by default), or a fixed ms if given; swallows the click that follows
function onLongPress(el, onLong, ms) {
  let timer = null;
  let fired = false;
  el.addEventListener("pointerdown", () => {
    fired = false;
    timer = setTimeout(() => {
      fired = true;
      if (navigator.vibrate) navigator.vibrate(20);
      onLong();
    }, ms ?? settings.hold);
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) {
    el.addEventListener(ev, () => clearTimeout(timer));
  }
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  el.addEventListener("click", (e) => {
    if (fired) {
      e.stopImmediatePropagation();
      fired = false;
    }
  }, true);
}

// two taps closer together than this count as a double tap
const DOUBLE_TAP_MS = 300;

// a timed row in the list, anywhere on it. holding it (the hold time) always opens the stat page, like counted stats.
// tapping it pauses / resumes, depending on the pause setting:
//   timerPause: "off" (only on the stat page) | "tap" | "double" (a single tap does nothing)
function timerGesture(el, stat) {
  let holdTimer = null, tapTimer = null, taps = 0, down = false, opened = false;
  const open = () => {
    opened = true;
    clearTimeout(tapTimer);
    taps = 0;
    if (navigator.vibrate) navigator.vibrate(20);
    openEdit(stat);
  };
  el.addEventListener("pointerdown", () => {
    down = true;
    opened = false;
    holdTimer = setTimeout(open, settings.hold);
  });
  el.addEventListener("pointerup", () => {
    if (!down) return;
    down = false;
    clearTimeout(holdTimer);
    if (opened) return;
    if (settings.timerPause === "tap") return toggleTimer(stat);
    if (settings.timerPause !== "double") return; // "off"
    taps++;
    if (taps === 2) {
      clearTimeout(tapTimer);
      taps = 0;
      return toggleTimer(stat);
    }
    tapTimer = setTimeout(() => (taps = 0), DOUBLE_TAP_MS); // too slow for a double tap: start over
  });
  for (const ev of ["pointerleave", "pointercancel"]) {
    el.addEventListener(ev, () => {
      down = false;
      clearTimeout(holdTimer);
    });
  }
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  // the click that follows opening the stat page shouldn't land on it
  el.addEventListener("click", (e) => {
    if (opened) {
      e.stopImmediatePropagation();
      opened = false;
    }
  }, true);
}

function show(dialog) {
  dialog.showModal();
  document.activeElement.blur(); // no focus ring on the first button
  if (dialog.id === "helpDialog") runDemo();
}

// stats from a file being looked at (read-only); null = showing your own
let viewing = null;

// running timers tick on screen (the list and the open popup)
let timerEls = [];
setInterval(() => {
  for (const [el, stat] of timerEls) if (stat.since) el.textContent = valueOf(stat);
  if (editing && editing.kind === "timer" && editing.since) $("editCount").textContent = valueOf(editing);
  if (editing && settings.showAge) showEditAge(); // the age ticks over each minute while the page is open
}, 500);

function render() {
  const list = $("list");
  list.innerHTML = "";
  // your live stats, then (if "deleted" is on in settings → info) the deleted ones at the bottom
  const shown = viewing
    ? viewing.filter((s) => !s.deleted)
    : [...visible(), ...(settings.showDeleted ? stats.filter((s) => s.deleted) : [])];
  document.documentElement.classList.toggle("empty", shown.length === 0);
  document.body.classList.toggle("viewing", !!viewing);
  $("viewLabel").hidden = !viewing;
  $("viewBack").hidden = !viewing;
  if (viewing) {
    $("star").hidden = true;
    $("intro").hidden = true;
  }
  // the off-white first-visit page pauses while viewing someone's file
  document.documentElement.classList.toggle("fresh", !viewing && isNew());
  updateBar();

  timerEls = [];
  for (const stat of shown) {
    const row = document.createElement("div");
    row.className = "row";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = stat.name;
    const timer = stat.kind === "timer";
    const deleted = !viewing && !!stat.deleted;
    const count = document.createElement(viewing || timer || deleted ? "span" : "button");
    count.className = "count";
    count.textContent = valueOf(stat);
    if (timer) {
      count.classList.add("timer");
      count.classList.toggle("paused", !stat.since);
      if (!deleted) timerEls.push([count, stat]);
    }
    row.append(name, count);
    list.append(row);
    if (viewing) continue; // look, don't touch
    if (deleted) {
      // greyed, a trash can by the name; tap to open it (restore or delete for good)
      row.classList.add("deleted", "tappable");
      name.insertAdjacentHTML("beforeend", ' <svg class="ic del-ic" aria-label="deleted"><use href="#i-trash" /></svg>');
      row.addEventListener("click", () => openEdit(stat));
      continue;
    }
    if (timer) {
      // anywhere on the row: pause / resume, or open the stat page (see timerGesture)
      row.classList.add("tappable");
      timerGesture(row, stat);
      continue;
    }
    count.setAttribute("aria-label", `Add one to ${stat.name}`);

    // tap the number: +1
    count.addEventListener("click", () => {
      record(stat, "add");
      count.textContent = stat.count;
      if (navigator.vibrate) navigator.vibrate(10);
    });
    // hold anywhere on the row: popup with −, reset and delete
    onLongPress(row, () => openEdit(stat));
  }
}

$("viewBack").onclick = () => {
  viewing = null;
  const first = isNew();
  $("star").hidden = first;
  $("intro").hidden = !first;
  if (first) playIntro();
  render();
};

// first visit: a black screen with just the # in the middle.
//   tap the #   → "stats" types out after it ("#stats"); tap that → the first-timer guide
//   hold the #  → "welcomeback" types out instead; tap that → the cloud / import page (startDialog)
//   hold again  → switches between the two
// the line is centred, so the # slides left as the text grows
let introTyping = 0; // bumps on every (re)type, so an older one still running stops
// italic: the new text types out in italics ("stats"); switched once the old text is gone, so it never italicises that
async function retypeIntro(text, wait = 70, italic = false) {
  const run = ++introTyping;
  const el = $("introRest");
  const step = () => new Promise((ok) => setTimeout(ok, wait));
  while (el.textContent.length) {
    if (run !== introTyping) return;
    el.textContent = el.textContent.slice(0, -1);
    await step();
  }
  el.classList.toggle("italic", italic);
  for (const ch of text) {
    if (run !== introTyping) return;
    el.textContent += ch;
    await step();
  }
}
let introPlayed = false;
function playIntro() {
  if (introPlayed) return;
  introPlayed = true;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  $("introHash").classList.add("pop"); // the # arrives with a little swell
}
// null = just "#"; "first" = "#stats"; "back" = "#welcomeback"
let introMode = null;
function setIntro(mode) {
  introMode = mode;
  $("introHelp").setAttribute("aria-label", mode === "back" ? "welcome back" : "stats");
  retypeIntro(mode === "back" ? "welcomeback" : "stats", 55, mode !== "back"); // "stats" in italics, "welcomeback" not
}
onLongPress($("introHelp"), () => setIntro(introMode === "back" ? "first" : "back"), 600);
$("introHelp").onclick = () => {
  if (!introMode) return setIntro("first");
  if (introMode === "back") return show($("startDialog"));
  helpFromMenu = false;
  $("helpDialog").classList.add("first"); // the first-timer version
  show($("helpDialog"));
  playPoweredBy(); // "powered by Claude Code" at its bottom types itself out (welcome.js)
};
// first-timer guide → "add": the add-to-home-screen links. exit goes back to the guide
$("helpAdd").onclick = () => show($("addHomeDialog"));
$("addHomeBack").onclick = () => $("addHomeDialog").close();
$("startImport").onclick = () => {
  $("startDialog").close();
  $("importFile").click();
};
$("startBack").onclick = () => $("startDialog").close();

// star opens the name field (just a cursor); holding it opens the menu
$("star").addEventListener("click", () => {
  $("star").hidden = true;
  $("composer").hidden = false;
  $("newbox").focus();
});
// the + always opens the menu after 0.4s, whatever the hold setting (that one is for stats)
const MENU_HOLD = 400;
let menuOpenedAt = 0;
onLongPress($("star"), () => {
  menuOpenedAt = Date.now();
  show($("menuDialog"));
}, MENU_HOLD);
// the menu is a full page: tapping any empty space (not one of its buttons) goes back to the list.
// (not in the first moment after it opens, so lifting the finger from the hold doesn't close it straight away)
$("menuDialog").addEventListener("click", (e) => {
  if (e.target.closest("button") || Date.now() - menuOpenedAt < 400) return;
  $("menuDialog").close();
});

function closeNew() {
  $("newbox").value = "";
  $("composer").hidden = true;
  $("star").hidden = false;
}
// # = counted stat, clock = timed stat (starts counting now)
function create(kind) {
  const name = $("newbox").value.trim();
  if (!name) {
    $("newbox").focus();
    return;
  }
  const now = new Date().toISOString();
  const base = { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), name, kind, created: now };
  stats.push(
    kind === "timer"
      ? { ...base, elapsed: 0, since: now, highest: 0, log: [] }
      : { ...base, count: 0, highest: 0, log: [] }
  );
  save();
  render();
  closeNew();
}
$("makeCounter").onclick = () => create("counter");
$("makeTimer").onclick = () => create("timer");
// tapping # / clock shouldn't steal focus (keeps the keyboard up on phones)
for (const b of [$("makeCounter"), $("makeTimer")]) b.addEventListener("pointerdown", (e) => e.preventDefault());
$("newbox").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("newbox").blur(); // just closes the keyboard; pick # or clock next
  if (e.key === "Escape") closeNew();
});
// tapping anywhere else cancels
document.addEventListener("pointerdown", (e) => {
  if (!$("composer").hidden && !$("composer").contains(e.target)) closeNew();
});

// popup for one stat. counted: tap the number to add, − to subtract. timed: pause / play
let editing = null;
function showEditValue() {
  const timer = editing.kind === "timer";
  $("editCount").textContent = valueOf(editing);
  $("editCount").classList.toggle("timer", timer);
  $("editCount").classList.toggle("paused", timer && !editing.since);
  $("editCount").setAttribute("aria-label", timer ? (editing.since ? "Pause" : "Resume") : "Add one");
  // a deleted stat's page: just look, restore it, or delete it for good
  const gone = !!editing.deleted;
  $("editDialog").classList.toggle("is-deleted", gone);
  $("resetBtn").hidden = gone;
  $("deleteBtn").hidden = gone;
  $("minusBtn").hidden = timer || gone;
  $("addTimeBtn").hidden = !timer || gone;
  $("restoreBtn").hidden = !gone;
  $("purgeBtn").hidden = !gone;
  showEditMeta();
}
// "2026-11-18 14:05": 24h, always UTC (but not labelled), so it reads the same wherever you are
// pass seconds = true for "…14:05:09" (used by "last", where taps can be seconds apart)
function fmtUtc(iso, seconds = false) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const pad = (n) => String(n).padStart(2, "0");
  const secs = seconds ? `:${pad(d.getUTCSeconds())}` : "";
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${secs}`;
}
// the greyed lines under the buttons: when it was made, how often it's been reset (each optional in settings)
function showEditMeta() {
  const resets = editing.log.filter((e) => e.action === "reset").length;
  // the wording stays normal, the values are bold
  $("editCreated").innerHTML = `created <b>${fmtUtc(editing.created)}</b>`;
  $("editCreated").hidden = !settings.showCreated;
  $("editResets").textContent = resets === 0 ? "never reset" : `reset ${resets} time${resets === 1 ? "" : "s"}`;
  $("editResets").hidden = !settings.showResets;
  // deleted stats always say when they went
  $("editDeleted").textContent = editing.deleted ? `deleted ${fmtUtc(editing.deleted)}` : "";
  $("editDeleted").hidden = !editing.deleted;
  showEditAge();
  // last action: "last +1 · …", "last −1 · …", "paused · …", "resumed · …" (nothing yet → no line)
  // last action: + / − for counted stats, the play / pause icons for timed ones
  const icon = (id) => `<svg class="ic meta-ic"><use href="#${id}" /></svg>`;
  const marks = { add: "+", subtract: "−", pause: icon("i-pause"), resume: icon("i-play") };
  const mark = (l) => (l.action === "addtime" ? `+${fmtHms(l.added || 0)}` : marks[l.action]); // added by hand: "+7h 30m"
  const last = editing.last;
  $("editLast").innerHTML = last ? `last <b>${mark(last)}</b> · <b>${fmtUtc(last.time, true)}</b>` : "";
  $("editLast").hidden = !settings.showLast || !last;
  // show logs: newest first, an icon per action (same as its button: reset arrow, red trash, undo arrow) · time
  const logIcons = { reset: icon("i-reset"), delete: `<span class="danger">${icon("i-trash")}</span>`, restore: icon("i-restore") };
  const log = $("editLog");
  log.innerHTML = "";
  for (const e of [...editing.log].reverse()) {
    const li = document.createElement("li");
    const mark = e.action === "addtime" ? `+${fmtHms(e.added || 0)}` : logIcons[e.action] || e.action;
    li.innerHTML = `${mark} · ${fmtUtc(e.time)}`;
    li.setAttribute("aria-label", `${e.action}, ${fmtUtc(e.time)}`);
    log.append(li);
  }
  if (!editing.log.length) log.innerHTML = "<li>no resets, deletes or restores yet</li>";
  log.hidden = !settings.showLogs;
}
// stat age: how long since it was made. years, days, hours, minutes (no seconds), from the first unit that isn't 0
function fmtAge(ms) {
  const m = Math.floor(Math.max(0, ms) / 60000);
  const parts = [
    [Math.floor(m / 525600), "y"],
    [Math.floor((m % 525600) / 1440), "d"],
    [Math.floor((m % 1440) / 60), "h"],
    [m % 60, "m"],
  ];
  const first = parts.findIndex(([n]) => n > 0);
  return parts.slice(first === -1 ? 3 : first).map(([n, u]) => `${n}${u}`).join(" ");
}
function showEditAge() {
  const born = Date.parse(editing.created);
  $("editAge").innerHTML = isNaN(born) ? "" : `active since <b>${fmtAge(Date.now() - born)}</b>`;
  $("editAge").hidden = !settings.showAge || isNaN(born);
}
function openEdit(stat) {
  editing = stat;
  $("editName").textContent = stat.name;
  $("editName").hidden = false;
  $("editNameInput").hidden = true;
  showEditValue();
  show($("editDialog"));
}

// rename: tap the name and it becomes a text field. Enter / tapping away saves, Esc cancels,
// an empty name keeps the old one. the id never changes, so its history and backups still line up
$("editName").onclick = () => {
  if (!editing || editing.deleted) return; // restore it first to rename it
  const input = $("editNameInput");
  input.value = editing.name;
  $("editName").hidden = true;
  input.hidden = false;
  input.focus();
  input.select();
};
function finishRename(keep) {
  const input = $("editNameInput");
  if (input.hidden) return;
  const name = input.value.trim();
  if (keep && editing && name && name !== editing.name) {
    editing.name = name;
    save();
    render(); // the list behind updates too
    $("editName").textContent = name;
  }
  input.hidden = true;
  $("editName").hidden = false;
  renameEnded = Date.now();
}
let renameEnded = 0;
$("editNameInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") finishRename(true);
  if (e.key === "Escape") {
    e.preventDefault(); // just cancel the rename, don't close the stat page
    finishRename(false);
  }
});
$("editNameInput").addEventListener("blur", () => finishRename(true));
// timed: pause / resume (not logged, only resets and deletes are)
function toggleTimer(stat) {
  if (!stat || stat.kind !== "timer") return;
  record(stat, stat.since ? "pause" : "resume");
  render();
  if (editing === stat) showEditValue();
  if (navigator.vibrate) navigator.vibrate(10);
}
function change(delta) {
  if (!editing || editing.kind === "timer") return;
  if (delta > 0) record(editing, "add");
  else if (editing.count > 0) record(editing, "subtract");
  else return;
  render(); // keep the list behind the popup in sync
  $("editCount").textContent = editing.count;
  showEditMeta(); // "last +1 / −1" updates straight away
  if (navigator.vibrate) navigator.vibrate(10);
}
// counted: tap adds. timed: tap or double tap (the pause setting) pauses / resumes
let lastTimeTap = 0;
$("editCount").onclick = () => {
  if (!editing || editing.deleted) return; // a deleted stat is look-only
  if (editing.kind !== "timer") return change(1);
  // "off" only turns off tapping in the list; here a tap still pauses
  if (settings.timerPause !== "double") return toggleTimer(editing);
  const now = Date.now();
  if (now - lastTimeTap < DOUBLE_TAP_MS) {
    lastTimeTap = 0;
    toggleTimer(editing);
  } else {
    lastTimeTap = now;
  }
};
$("minusBtn").onclick = () => change(-1);

// the yes / no page (reset, delete, replacing stats on import). no onYes = just a message with a back button
let onYes = null;
let onNo = null; // optional: 👎 does something of its own (tapping away still just cancels)
// html = true: the text is our own markup (e.g. a <b> word), regular weight so the bold part stands out
// words: ["keep", "delete"] shows those instead of 👍 / 👎 (then the second one is the red, destructive one)
function ask(text, yes = null, html = false, no = null, words = null) {
  onYes = yes;
  onNo = no;
  $("confirmText")[html ? "innerHTML" : "textContent"] = text;
  $("confirmText").classList.toggle("rich", html);
  $("yesBtn").hidden = !yes;
  $("noIcon").setAttribute("href", yes ? "#i-down" : "#i-exit");
  $("zeroDialog").classList.toggle("worded", !!words);
  $("yesWord").textContent = words ? words[0] : "";
  $("noWord").textContent = words ? words[1] : "";
  $("yesBtn").setAttribute("aria-label", words ? words[0] : "Yes");
  $("noBtn").setAttribute("aria-label", words ? words[1] : "No");
  show($("zeroDialog"));
}
$("noBtn").onclick = () => {
  const no = onNo;
  $("zeroDialog").close();
  if (no) no();
};
// tapping any empty space on the yes / no page closes it (cancel: no 👎 action)
$("zeroDialog").addEventListener("click", (e) => {
  if (!e.target.closest("button")) $("zeroDialog").close();
});
$("yesBtn").onclick = () => {
  const yes = onYes;
  $("zeroDialog").close();
  if (yes) yes();
};
$("resetBtn").onclick = () => {
  const stat = editing;
  if (!stat) return;
  ask(`reset "${stat.name}"?`, () => {
    record(stat, "reset");
    render();
    if (editing === stat) showEditValue();
  });
};
$("deleteBtn").onclick = () => {
  const stat = editing;
  if (!stat) return;
  ask(`delete "${stat.name}"?`, () => {
    record(stat, "delete");
    render();
    $("editDialog").close();
  });
};
// deleted stat → restore (asks first): back in the list as it was (a timed stat stays paused), and the page turns live
$("restoreBtn").onclick = () => {
  const stat = editing;
  if (!stat || !stat.deleted) return;
  ask(`restore "${stat.name}"?`, () => {
    delete stat.deleted;
    const time = new Date().toISOString();
    stat.created = time; // restored = a fresh start: created (and so "active since") count from now
    stat.log.push({ action: "restore", time });
    save();
    render();
    if (editing === stat) showEditValue();
    if (navigator.vibrate) navigator.vibrate(10);
  });
};
// deleted stat → delete for good: gone from localStorage entirely, history and all
$("purgeBtn").onclick = () => {
  const stat = editing;
  if (!stat || !stat.deleted) return;
  ask(`permanently delete "${stat.name}"? this can't be undone.`, () => {
    stats = stats.filter((s) => s !== stat);
    save();
    $("editDialog").close();
    render();
  });
};
// timed stat → +: add time by hand (hours / minutes / seconds, no days or years). goes onto the total,
// running or paused, and is logged ("addtime") so a hand-added top-up is never mistaken for tracked time
const addFields = () => [$("addH"), $("addM"), $("addS")];
// exactly what was entered, units that aren't 0: "7h 30m 45s", "45s" (unlike fmtTime, never drops the seconds)
function fmtHms(ms) {
  const s = Math.round(ms / 1000);
  const parts = [[Math.floor(s / 3600), "h"], [Math.floor((s % 3600) / 60), "m"], [s % 60, "s"]].filter(([n]) => n > 0);
  return parts.length ? parts.map(([n, u]) => `${n}${u}`).join(" ") : "0s";
}
function addedMs() {
  const [h, m, s] = addFields().map((el) => Math.max(0, Math.floor(Number(el.value) || 0)));
  return ((Math.min(h, 99) * 60 + Math.min(m, 59)) * 60 + Math.min(s, 59)) * 1000;
}
function updateAddTime() {
  // each box is as wide as what's in it (1 or 2 digits), so the whole row re-centres as you type
  for (const el of addFields()) el.style.width = `${Math.max(1, el.value.length) + 0.1}ch`;
  const ms = addedMs();
  $("addTimeYes").classList.toggle("dim", ms === 0);
  $("addTimeText").innerHTML = ms
    ? `add <b>${fmtHms(ms)}</b> to "${editing.name.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)}"?`
    : `add time to "${editing.name.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)}"`;
}
$("addTimeBtn").onclick = () => {
  if (!editing || editing.kind !== "timer" || editing.deleted) return;
  for (const el of addFields()) el.value = "";
  updateAddTime();
  show($("addTimeDialog"));
};
for (const el of addFields()) {
  el.addEventListener("input", () => {
    // keep each box in range as you type (hours ≤ 99, minutes / seconds ≤ 59)
    const max = Number(el.max);
    if (Number(el.value) > max) el.value = max;
    if (el.value.length > 2) el.value = el.value.slice(0, 2);
    updateAddTime();
  });
  el.addEventListener("keydown", (e) => e.key === "Enter" && $("addTimeYes").click());
}
$("addTimeNo").onclick = () => $("addTimeDialog").close();
$("addTimeYes").onclick = () => {
  const stat = editing;
  const ms = addedMs();
  if (!stat || stat.kind !== "timer" || !ms) return;
  stat.elapsed += ms;
  stat.highest = Math.max(stat.highest, timeOf(stat));
  const time = new Date().toISOString();
  stat.log.push({ action: "addtime", time, added: ms });
  stat.last = { action: "addtime", time, added: ms }; // counts as the last action too
  save();
  render();
  $("addTimeDialog").close();
  if (editing === stat) showEditValue();
  if (navigator.vibrate) navigator.vibrate(10);
};

// full screen, so "outside" is any empty space: anything that isn't a button (or the rename field) goes back.
// mid-rename, the first tap on empty space just finishes the rename
$("editDialog").addEventListener("click", (e) => {
  if (e.target.closest("button, input, .edit-log")) return; // the log list scrolls; tapping it shouldn't close the page
  // the tap that ended a rename (the field loses focus first, then this click lands) stays on the page
  if (!$("editNameInput").hidden) return finishRename(true);
  if (Date.now() - renameEnded < 500) return;
  $("editDialog").close();
});
// Esc / back gesture mid-rename: keep the new name (done here, before the page goes, not left to the close event)
$("editDialog").addEventListener("cancel", () => finishRename(true));
$("editDialog").onclose = () => {
  finishRename(true);
  editing = null;
  render();
};

// tapping outside a dialog closes it
for (const d of document.querySelectorAll("dialog")) {
  d.addEventListener("click", (e) => {
    if (e.target !== d) return;
    const r = d.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) d.close();
  });
}

// how to use: the ? in settings (or on the first visit's intro)
// opened from settings: tapping any empty space on the guide goes back to settings
let helpFromMenu = false;
$("helpBtn").onclick = () => {
  helpFromMenu = true;
  hideTip();
  $("settingsDialog").close();
  $("helpDialog").classList.remove("first"); // the full version, with the cloud and live view
  show($("helpDialog"));
  $("helpDialog").scrollTop = 0;
};
// 👍 or tapping empty space: back to settings if it was opened from there, otherwise (first visit) to the list
const leaveHelp = () => {
  $("helpDialog").close();
  if (helpFromMenu) show($("settingsDialog"));
};
$("helpDone").onclick = leaveHelp;
// guide → import / export in the icon row: what it's for (full screen). back or tapping anywhere returns to the guide
$("dataInfoBtn").onclick = () => show($("dataInfoDialog"));
$("dataInfoBack").onclick = () => $("dataInfoDialog").close();
$("dataInfoDialog").addEventListener("click", (e) => {
  if (e.target.closest("button") !== $("dataInfoBack")) $("dataInfoDialog").close();
});
// first visit: "continue offline" → closes the guide onto the empty + page
$("helpOffline").onclick = leaveHelp;
$("helpDialog").addEventListener("click", (e) => {
  if (!helpFromMenu || e.target.closest("button, a")) return;
  leaveHelp();
});
$("helpDialog").addEventListener("close", markSeen);

// import / export page: import, export, or full app reset (asks yes / no first)
$("exportBtn").onclick = () => {
  $("menuDialog").close();
  $("exportChoices").hidden = false;
  $("exportConfirm").hidden = true;
  show($("exportDialog"));
};
// cancel / no step back to the menu instead of closing everything
const backToMenu = () => {
  $("exportDialog").close();
  show($("menuDialog"));
};
$("exportCancel").onclick = backToMenu;
// no to the full app reset: back to the import / export choices
$("exportNo").onclick = () => {
  $("exportConfirm").hidden = true;
  $("exportChoices").hidden = false;
  document.activeElement.blur();
};
$("exportClear").onclick = () => {
  $("exportChoices").hidden = true;
  $("exportConfirm").hidden = false;
  document.activeElement.blur();
};
$("exportOnly").onclick = () => {
  $("exportDialog").close();
  exportBackup();
};

// wipes everything this app keeps in localStorage (stats, settings, cloud login, first-visit flags), then
// starts over as a first visit. only this app's keys: the rest of the site shares localStorage.
// used by the full app reset. disconnecting from the cloud (cloud.js) passes keepSeen: the first-visit flags
// stay, so it comes back to the normal + screen (empty), not the welcome
function wipeLocal(keepSeen = false) {
  const keep = keepSeen ? [SEEN_KEY, WELCOME_KEY] : [];
  try {
    const mine = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if ((k.startsWith("stats.") || k.startsWith("tally.")) && !keep.includes(k)) mine.push(k);
    }
    for (const k of mine) localStorage.removeItem(k);
  } catch {}
  location.reload();
}
$("exportYes").onclick = () => {
  $("exportDialog").close();
  wipeLocal();
};

// backup files use 3-letter keys; the app works with the full names. where the first three letters clash,
// it's the first letter + the start of the next word (showCreated → scr, timerPause → tpa)
const SHORT_KEYS = {
  _readme: "_re", exported: "exp", stats: "sta", settings: "set",
  id: "id", name: "nam", kind: "kin", created: "cre", count: "cou", elapsed: "ela", since: "sin",
  highest: "hig", deleted: "del", last: "las", log: "log", action: "act", time: "tim", added: "add",
  theme: "the", font: "fon", hold: "hol", timerPause: "tpa",
  showCreated: "scr", showResets: "sre", showDeleted: "sde", showAge: "sag", showLogs: "slo", showLast: "sla",
};
const LONG_KEYS = Object.fromEntries(Object.entries(SHORT_KEYS).map(([k, v]) => [v, k]));
// renames every object key found in the map, all the way down; anything else is left as it is
function renameKeys(value, map) {
  if (Array.isArray(value)) return value.map((v) => renameKeys(v, map));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [map[k] ?? k, renameKeys(v, map)]));
}

// returns true once the file has been shared or downloaded
async function exportBackup() {
  // written with the file's own 3-letter keys (see SHORT_KEYS); stats and settings are renamed into them.
  // JSON has no comments, so the explanation lives in a "_re" (readme) field (ignored on import)
  const backup = {
    _re: {
      exp: "JSON file creation time",
      sta: "all stats (&deleted)",
      set: "your settings (rw)",
      id: "unique random-generated ID",
      nam: "mutable",
      kin: "counter|timer",
      cre: "stat creation time",
      cou: "(counter)",
      ela: "(timer)",
      sin: "(timer)",
      hig: "",
      del: "delete marker",
      las: "add|subtract|pause|resume|addtime",
      log: "act = reset|delete|restore|addtime; tim = [new Date().toISOString()]ms; add = ms added (addtime only).",
    },
    exp: new Date().toISOString(),
    sta: renameKeys(stats, SHORT_KEYS),
    set: renameKeys(settings, SHORT_KEYS),
  };
  const json = JSON.stringify(backup, null, 2);
  // local date and time, e.g. stats-2026-11-18_14-05-32.json (no colons: not allowed in filenames)
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const filename = `stats-${stamp}.json`;
  const file = new File([json], filename, { type: "application/json" });
  // share sheet works best on phones (save to Files, email, etc.)
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return true;
    } catch (err) {
      if (err.name === "AbortError") return false;
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return true;
}

// import: a backup loads as yours (it asks first if you already have stats). an old read-only copy (readOnly: true,
// from when the app could export those) opens in viewing mode instead
$("importBtn").onclick = () => {
  $("exportDialog").close();
  $("importFile").click();
};
$("importFile").onchange = async () => {
  const file = $("importFile").files[0];
  $("importFile").value = "";
  if (!file) return;
  try {
    // short keys back to the full names (older files already use full names and pass through unchanged)
    const parsed = renameKeys(JSON.parse(await file.text()), LONG_KEYS);
    // new backups are { _readme, exported, stats }; old ones are a bare array
    const data = Array.isArray(parsed) ? parsed : parsed && parsed.stats;
    if (!Array.isArray(data)) throw new Error();
    const incoming = data.map(normalize);
    // old read-only copies are only for looking at
    const readOnly = !Array.isArray(parsed) && parsed.readOnly === true;
    if (readOnly) {
      viewing = incoming; // never saved, gone when you go back
      render();
      return;
    }
    const shown = incoming.filter((s) => !s.deleted).length;
    const withSettings = parsed.settings && typeof parsed.settings === "object";
    const load = () => {
      stats = incoming;
      save();
      // the backup's settings too: stored, then read back through loadSettings so anything odd falls back to defaults
      if (withSettings) {
        try {
          localStorage.setItem(SETTINGS_KEY, JSON.stringify(parsed.settings));
        } catch {}
        settings = loadSettings();
        saveSettings();
      }
      render();
      markSeen();
    };
    const what = withSettings ? `${shown} stat(s) and the settings` : `${shown} stat(s)`;
    if (visible().length) ask(`replace your current stats with ${what} from the file?`, load);
    else load();
  } catch {
    ask("that file doesn't look like a stats backup.");
  }
};
