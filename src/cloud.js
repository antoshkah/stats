// the cloud (Supabase): cloud-only. your stats and settings live in your account, and the device keeps nothing but
// the login. logged out, the app is the # screen; logging in (or opening the app logged in) downloads the cloud's
// copy into memory, and until that's in, nothing can be changed (so an empty list can never be sent up over yours).
// - every change is an upload a moment later. the connection dropped? the change waits in memory ("pending") and
//   goes up when it's back, before anything is downloaded (closing the app before then loses it).
// - opening the app, coming back to it, and once a minute: the cloud's copy comes down (other devices' changes).
// - stats left on a device from before the app went cloud-only: the first login uploads them (or, if the cloud has
//   stats too, asks which copy wins), then they're cleared off the device.
// talks to Supabase's REST API with plain fetch (no library), so nothing extra loads.
// also: sharing a live view (live.html, a read-only page anyone with the link can watch).
//
// tables (see the SQL in the setup): stats (user_id, id, data, updated_at), settings (user_id, data, updated_at),
// shares (id, user_id, username). row-level security: you only change your own rows; you read all of yours; a shared
// user's stats can be read by anyone, except the ones hidden from the live view (supabase/hide-from-view.sql)

// the publishable key is meant to be public; what protects the data is row-level security
const SB_URL = "https://ocgnkpvoligvygakairp.supabase.co";
const SB_KEY = "sb_publishable_dHSVpNuTOtU-R9FKxJjJlw_ZcRY8jEu";
// the one thing kept on the device: { access_token, refresh_token, expires_at (s), user: { id, email } }
const SESSION_KEY = "stats.session";
const PUSH_DELAY = 1500; // ms after the last change before sending (taps come in bursts)
const RECENT = 2 * 60 * 1000; // a sync within this long ago counts as "just synced": the page only says "online"

let session = loadSession();
let pushTimer = null;
let applying = false; // putting the cloud's copy in place: not a change to upload
let pending = false; // a change made here hasn't reached the cloud yet (in memory only)
const setPending = (on) => (pending = on);
// the cloud's copy is in (this session): until then the list says "loading…" / "no connection" and nothing can
// change or go up
let loaded = false;
let loadError = ""; // why it isn't in yet: "" (still loading), "no connection", or the server's message
const cloudLoaded = () => loaded;
const cloudLoadMsg = () => loadError || "loading…";
// what the account page shows under your email (see cloudStatus)
let syncing = false;
let offline = !navigator.onLine; // also set when a request can't get through
let syncError = ""; // the server said no (not a connection problem)
let lastSync = null;

// ── left over from before the app went cloud-only: stats and settings this device used to keep ──
// read once at start; uploaded (or, with stats in the cloud too, you choose) on the next login; cleared off the
// device after the first sync. pending: a change back then hadn't gone up yet (then this device's copy goes up)
const leftover = (() => {
  const read = (...keys) => {
    for (const k of keys) {
      try {
        const v = JSON.parse(localStorage.getItem(k));
        if (v) return v;
      } catch {}
    }
    return null;
  };
  const saved = read("stats.v1", "tally.v1");
  let pendingThen = false;
  try {
    pendingThen = localStorage.getItem("stats.pending") === "1";
  } catch {}
  return {
    stats: Array.isArray(saved) ? saved.map(normalize) : [],
    settings: read("stats.settings", "stats.appearance"),
    pending: pendingThen,
  };
})();
// everything this app ever kept on the device, except the login. only this app's keys: the rest of the site
// shares the storage
function clearLeftover() {
  leftover.stats = [];
  leftover.settings = null;
  leftover.pending = false;
  try {
    const mine = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if ((k.startsWith("stats.") || k.startsWith("tally.")) && k !== SESSION_KEY) mine.push(k);
    }
    for (const k of mine) localStorage.removeItem(k);
  } catch {}
}
// this device's leftover copy becomes the one in use, and goes up (replacing the cloud's)
function useLeftover() {
  stats = leftover.stats;
  settings = loadSettings(leftover.settings);
  applySettings(settings);
  loaded = true;
  setPending(true);
  showHome();
}

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY)) || null;
  } catch {
    return null;
  }
}
function storeSession(s) {
  session = s;
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {}
}

// ── auth ──
async function authCall(params, body) {
  const res = await fetch(`${SB_URL}/auth/v1/token?${params}`, {
    method: "POST",
    headers: { apikey: SB_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error_description || json.msg || json.message || `error ${res.status}`);
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: json.expires_at || Math.floor(Date.now() / 1000) + (json.expires_in || 3600),
    user: { id: json.user.id, email: json.user.email },
  };
}
// a valid access token, refreshed first if it's (nearly) expired. null = logged out
async function accessToken() {
  if (!session) return null;
  if (session.expires_at - 60 > Date.now() / 1000) return session.access_token;
  try {
    storeSession(await authCall("grant_type=refresh_token", { refresh_token: session.refresh_token }));
    return session.access_token;
  } catch (e) {
    // offline: keep the session and try again later. rejected: the session is over, back to the # screen
    if (e instanceof TypeError) throw e;
    endSession();
    return null;
  }
}

// ── data ──
async function rest(path, { method = "GET", body, prefer } = {}) {
  const token = await accessToken();
  if (!token) throw new Error("logged out");
  const headers = { apikey: SB_KEY, Authorization: `Bearer ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    const err = new Error(json.message || `error ${res.status}`);
    err.code = json.code; // e.g. "23505" = already taken (a unique column)
    throw err;
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

async function pullAll() {
  const [rows, set] = await Promise.all([rest("stats?select=id,data"), rest("settings?select=data")]);
  return { stats: rows.map((r) => r.data), settings: set[0] ? set[0].data : null };
}

// this device → cloud: every stat upserted, and any stat no longer on this device (deleted for good) removed
async function pushAll() {
  const uid = session.user.id;
  const now = new Date().toISOString();
  if (stats.length) {
    await rest("stats?on_conflict=user_id,id", {
      method: "POST",
      body: stats.map((s) => ({ user_id: uid, id: s.id, data: s, updated_at: now })),
      prefer: "resolution=merge-duplicates,return=minimal",
    });
  }
  const keep = stats.map((s) => `"${String(s.id).replace(/"/g, '\\"')}"`).join(",");
  await rest(keep ? `stats?id=not.in.(${encodeURIComponent(keep)})` : "stats?id=not.is.null", { method: "DELETE" });
  await rest("settings?on_conflict=user_id", {
    method: "POST",
    body: { user_id: uid, data: settings, updated_at: now },
    prefer: "resolution=merge-duplicates,return=minimal",
  });
}

// called by save() / saveSettings() after every change: remember it, and send it a moment later.
// never before the cloud's copy is in: sending then would replace your stats with an empty list
function cloudQueue() {
  if (!session || applying || !loaded) return;
  setPending(true);
  clearTimeout(pushTimer);
  pushTimer = setTimeout(cloudPush, PUSH_DELAY);
}
async function cloudPush() {
  if (!session || !loaded) return;
  clearTimeout(pushTimer);
  setSyncing();
  try {
    await pushAll();
    setPending(false);
    synced();
  } catch (e) {
    syncFailed(e);
  }
}

// ── sync status ──
function setSyncing() {
  syncing = true;
  renderAccount();
}
function synced() {
  syncing = false;
  offline = false;
  syncError = "";
  lastSync = Date.now();
  clearLeftover(); // in step with the cloud: anything left on the device from before goes (cloud-only)
  renderAccount();
  // in step with the cloud: now it's safe to do any automatic resets that are due (app.js). they're changes like
  // any other, so they go up straight after
  autoResets();
}
// a fetch that can't reach the server throws a TypeError: that's being offline, not an error
function syncFailed(e) {
  syncing = false;
  if (e instanceof TypeError) offline = true;
  else syncError = e.message;
  renderAccount();
}
// "online" when the last sync was just now; otherwise when it last synced (same UTC time as the rest of the app,
// just the time if it was today)
function cloudStatus() {
  const when = () => {
    if (!lastSync) return "never synced";
    const full = fmtUtc(new Date(lastSync).toISOString());
    const today = fmtUtc(new Date().toISOString()).slice(0, 10);
    return `last sync ${full.startsWith(today) ? full.slice(11) : full}`;
  };
  if (isOffline()) return `offline · ${when()}${pending ? " · changes go up when back online" : ""}`;
  if (syncing) return "syncing…";
  if (syncError) return `not synced: ${syncError} · ${when()}`;
  if (lastSync && Date.now() - lastSync < RECENT) return "online";
  return `online · ${when()}`;
}

const isOffline = () => offline || !navigator.onLine;
// the plug at the top of the cloud page: tapping it does nothing, so it gives a little no-shake
$("accountCloud").addEventListener("click", () => {
  const icon = $("accountCloud");
  icon.classList.remove("nope");
  void icon.getBoundingClientRect();
  icon.classList.add("nope");
});

// sync (app opens, comes back into view, connection returns, just logged in, and every minute while open):
// a change not sent yet → upload it (it's the newest). otherwise → download the cloud's copy and use it.
// the first download of a session is what lets the list (and changes) in. quiet = the once-a-minute check: no
// "syncing…" flash, and the list is only redrawn if something actually changed
let syncRunning = false;
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function cloudStart(quiet = false) {
  if (!session || syncRunning) return;
  if (pending) return cloudPush();
  // in the middle of something (a stat page, a yes / no, adding time…): don't swap the stats out from
  // under it. it downloads the next time instead (the first download always goes ahead: nothing's open on it)
  if (loaded && document.querySelector("dialog[open]:not(#accountDialog):not(#viewDialog):not(#menuDialog):not(#helpDialog)")) return;
  syncRunning = true;
  if (!quiet) setSyncing();
  let cloud;
  try {
    cloud = await pullAll();
  } catch (e) {
    syncRunning = false;
    if (!loaded && session) {
      // the list can't come in yet: say why ("loading…" again when the connection's back, see "online" below)
      loadError = e instanceof TypeError ? "no connection" : `couldn't load: ${e.message}`;
      render();
    }
    return syncFailed(e);
  }
  syncRunning = false;
  if (!session) return; // logged out while it was downloading
  // a change made while it was downloading wins: send that instead
  if (pending) return cloudPush();
  const first = !loaded;
  // the cloud has nothing, but this device still has stats from before the app went cloud-only: those go up
  // (never thrown away for an empty cloud)
  if (first && !cloud.stats.length && leftover.stats.length) {
    useLeftover();
    return cloudPush();
  }
  const cloudStats = cloud.stats.map(normalize);
  const cloudSettings = loadSettings(cloud.settings);
  // already the same here: nothing to redraw (a redraw mid-hold would cancel the hold)
  const byId = (list) => [...list].sort((a, b) => (a.id < b.id ? -1 : 1));
  if (!first && sameJson(byId(cloudStats), byId(stats)) && sameJson(cloudSettings, settings)) return synced();
  applying = true;
  try {
    stats = cloudStats;
    settings = cloudSettings;
    loaded = true;
    loadError = "";
    saveSettings(); // (the look, and the settings pages; not sent back up: applying)
    if (first) showHome(); // the list and the + come in
    else render();
  } finally {
    applying = false;
  }
  synced();
}

// ── live view (menu → eye, its own page): live.html?u=<username>, read-only, for anyone who has the link ──
// not shared: type a username, tap the eye. shared: the username (fixed), then open · copy link · stop sharing
let shareName = null; // null = not shared (or not known yet)
const USERNAME = /^[a-z0-9_-]{3,20}$/;
const shareUrl = () => new URL(`live.html?u=${encodeURIComponent(shareName)}`, location.href).href;
const shareMsg = (text) => ($("shareMsg").textContent = text);
async function loadShare() {
  try {
    const rows = await rest("shares?select=username");
    shareName = rows[0] ? rows[0].username : null;
  } catch {}
  renderView();
}
// the live view page: the view ID and its buttons while connected; otherwise just "connect first" and the plug
function renderView() {
  const inside = !!session;
  $("shareBox").hidden = !inside;
  $("viewNeedCloud").hidden = inside;
  if (!inside) return;
  const shared = !!shareName;
  $("shareName").readOnly = shared;
  if (shared) $("shareName").value = shareName;
  $("shareBtn").hidden = shared;
  for (const id of ["openShare", "copyShare", "stopShare"]) $(id).hidden = !shared;
}
$("viewBtn").onclick = () => {
  $("menuDialog").close();
  shareMsg("");
  renderView();
  show($("viewDialog"));
  if (session) loadShare();
};
$("viewExit").onclick = () => {
  $("viewDialog").close();
  show($("menuDialog"));
};
// not connected: the plug goes to the cloud page (back from there goes to the menu, like opening it from there)
$("viewToCloud").onclick = () => {
  $("viewDialog").close();
  $("accountBtn").click();
};
// usernames are lowercase: letters, numbers, _ and -
$("shareName").addEventListener("input", () => {
  const el = $("shareName");
  el.value = el.value.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  shareMsg("");
});
$("shareName").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("shareBtn").click();
});
$("shareBtn").onclick = async () => {
  const name = $("shareName").value;
  if (!USERNAME.test(name)) return shareMsg("3–20 letters, numbers, _ or -");
  shareMsg("…");
  try {
    await rest("shares", { method: "POST", body: { user_id: session.user.id, username: name }, prefer: "return=minimal" });
    shareName = name;
    // a little "view created!" under the icons, gone after 3 seconds (unless something else replaced it)
    shareMsg("view created!");
    setTimeout(() => {
      if ($("shareMsg").textContent === "view created!") shareMsg("");
    }, 3000);
  } catch (e) {
    if (e instanceof TypeError) return shareMsg("no connection");
    // "23505" = already taken. which one: your account already has a view (one each), or the username is someone's
    if (e.code === "23505" && /user_id/.test(e.message)) {
      shareMsg("you already have a view");
      return loadShare(); // show it
    }
    return shareMsg(e.code === "23505" ? "that view ID is taken" : `couldn't share: ${e.message}`);
  }
  $("shareName").blur();
  renderView();
};
$("openShare").onclick = () => window.open(shareUrl(), "_blank", "noopener");
// copy: the link to the clipboard, and the icon turns into a tick for a moment
$("copyShare").onclick = async () => {
  try {
    await navigator.clipboard.writeText(shareUrl());
    $("copyIcon").setAttribute("href", "#i-check");
    setTimeout(() => $("copyIcon").setAttribute("href", "#i-copy"), 1200);
  } catch {
    shareMsg(shareUrl()); // no clipboard access: show it so it can be copied by hand
  }
};
// stop sharing: the link stops working, and the username is free again
$("stopShare").onclick = () =>
  ask("deactivate live view?", async () => {
    try {
      await rest("shares?user_id=not.is.null", { method: "DELETE" });
      shareName = null;
      shareMsg("");
    } catch (e) {
      shareMsg(e instanceof TypeError ? "no connection" : `couldn't stop: ${e.message}`);
    }
    renderView();
  });

// the plug icons (menu, guide, demo): plugged in while logged in, apart while logged out
function updatePlugIcons() {
  for (const u of document.querySelectorAll("use.plug-state")) u.setAttribute("href", session ? "#i-plug-in" : "#i-plug");
}
// ── the account page (menu → cloud) ──
function renderAccount() {
  const inside = !!session;
  updatePlugIcons(); // (this runs on every log in / out, and when a login runs out)
  $("loginForm").hidden = inside;
  $("accountIn").hidden = !inside;
  $("logoutBtn").hidden = !inside;
  $("accountCloud").toggleAttribute("hidden", !inside); // (an <svg> has no .hidden property, only the attribute)
  if (inside) {
    $("accountEmail").textContent = session.user.email;
    // the plug at the top: together while online, apart while offline
    $("accountCloud").classList.toggle("plugged", !isOffline());
    $("accountState").textContent = cloudStatus();
  }
}
// while the page is open, keep the status current ("online" turns into "online · last sync …" as time passes)
setInterval(() => {
  if ($("accountDialog").open && session) renderAccount();
}, 15000);
// the connection drops or comes back: say so straight away
window.addEventListener("offline", () => {
  offline = true;
  renderAccount();
});
$("accountBtn").onclick = () => {
  accountFromStart = accountFromHelp = false;
  $("menuDialog").close();
  renderAccount();
  show($("accountDialog"));
};
// ── registering: a new account, confirmed by email ──
// "new?" switches the form: a "repeat password" box appears and the plug makes an account instead of
// logging in. Supabase emails a confirmation link; opening it comes back here (see confirmReturn below), and then you
// log in as usual. (needs sign-ups switched on in Supabase, and this page's address in its allowed redirect URLs)
let registerMode = false;
function loginMsg(text, bad = false) {
  $("loginMsg").textContent = text;
  $("loginMsg").classList.toggle("bad", bad);
}
function setRegisterMode(on) {
  registerMode = on;
  $("loginRepeatField").hidden = !on;
  $("loginRepeat").value = "";
  $("loginPassword").setAttribute("autocomplete", on ? "new-password" : "current-password");
  $("plugBtn").setAttribute("aria-label", on ? "Register" : "Connect");
  $("loginMode").textContent = on ? "have an account?" : "new?";
  loginMsg("");
}
$("loginMode").onclick = () => setRegisterMode(!registerMode);
// Supabase's messages, in the app's words
function registerError(message) {
  const m = message.toLowerCase();
  if (m.includes("signups not allowed") || m.includes("signup is disabled")) return "registering is switched off for now.";
  if (m.includes("already registered")) return "that email already has an account: log in instead.";
  if (m.includes("rate limit")) return "too many sign-ups right now. try again in a while.";
  if (m.includes("password")) return message.toLowerCase();
  if (m.includes("email")) return "that doesn't look like an email address.";
  return message;
}
async function register() {
  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;
  if (!email || !password) return;
  if (password.length < 6) return loginMsg("password: at least 6 characters.", true);
  if (password !== $("loginRepeat").value) return loginMsg("the two passwords don't match.", true);
  loginMsg("sending…");
  try {
    // the link in the email brings you back to this page
    const back = encodeURIComponent(location.origin + location.pathname);
    const res = await fetch(`${SB_URL}/auth/v1/signup?redirect_to=${back}`, {
      method: "POST",
      headers: { apikey: SB_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error_description || json.msg || json.message || `error ${res.status}`);
    setRegisterMode(false); // back to logging in either way, the email still filled in
    $("loginPassword").value = "";
    // the email already has an account: with email confirmation on, Supabase doesn't say so outright (so no one can
    // test which emails are signed up). it answers "ok" with a user that has no sign-in methods (identities: [])
    // and sends no email. nothing about the existing account changes
    const user = json.user || json;
    if (Array.isArray(user.identities) && user.identities.length === 0) return loginMsg("user already exists. log in instead.", true);
    loginMsg(`check ${email} for a link to confirm your account, then log in here.`);
  } catch (e) {
    if (/already registered/i.test(e.message)) {
      // (with email confirmation off, Supabase does say it outright)
      setRegisterMode(false);
      $("loginPassword").value = "";
      return loginMsg("user already exists. log in instead.", true);
    }
    loginMsg(e instanceof TypeError ? "no connection." : registerError(e.message), true);
  }
}
// back from the confirmation email: Supabase sends you to this page with the result after a # in the address.
// it also logs you in there, but connecting goes through the usual login (and its warning), so that's thrown away:
// the account page opens, says it's confirmed, and you log in
(function confirmReturn() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.has("access_token") && !h.has("error")) return;
  history.replaceState(null, "", location.pathname + location.search); // tidy the address (and don't do this twice)
  const token = h.get("access_token");
  if (token) fetch(`${SB_URL}/auth/v1/logout`, { method: "POST", headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` } }).catch(() => {});
  const bad = h.has("error");
  const text = !bad
    ? "email confirmed. log in to connect."
    : h.get("error_code") === "otp_expired"
      ? "that confirmation link has expired. register again to get a new one."
      : `that link didn't work: ${(h.get("error_description") || h.get("error")).replace(/\+/g, " ")}`;
  setTimeout(() => {
    if (session) return; // already connected on this device: nothing to do
    renderAccount();
    show($("accountDialog"));
    loginMsg(text, bad);
  }, 0);
})();

// ── logging in ──
// does the cloud have any stats for this account yet? (checked with the new login, before it's kept; only asked
// when this device still has stats from before the app went cloud-only)
async function cloudHasStats(token) {
  const res = await fetch(`${SB_URL}/rest/v1/stats?select=id&limit=1`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`error ${res.status}`);
  return (await res.json()).length > 0;
}
// both this device (left over from before) and the cloud have stats: one page, in steps (see the markup). the login fades to black, a short
// pause, then "sync to" 📱 ☁. tap one: an arrow shows where the data goes, "sync to" turns into the warning
// (it deletes the other side's data) and 👍 👎 appear. 👍 connects; 👎 back to the choice; exit = don't connect
let syncChoice = null; // { connect, cancel } while the page is open
let syncPick = null; // null, "phone" (the cloud's copy comes down) or "cloud" (this device's goes up)
function chooseSync(connect, cancel) {
  syncChoice = { connect, cancel };
  setSyncPick(null);
  show($("syncChoiceDialog"));
}
function setSyncPick(to) {
  syncPick = to;
  const page = $("syncChoiceDialog");
  page.classList.toggle("picked", !!to);
  page.classList.toggle("to-phone", to === "phone");
  page.classList.toggle("to-cloud", to === "cloud");
  if (to) $("syncWarnText").textContent = to === "phone" ? "delete all local data?" : "delete all cloud data?";
}
// fades out (0.3s), then closes, and only then is the choice acted on: the download waits while another page is
// open (cloudStart), so connecting while this page is still fading would put the download off
function syncChoiceDone(to) {
  const choice = syncChoice;
  syncChoice = null;
  const page = $("syncChoiceDialog");
  page.classList.add("fading");
  setTimeout(() => {
    page.close();
    page.classList.remove("fading");
    if (!choice) return;
    if (to) choice.connect(to);
    else choice.cancel();
  }, 300);
}
$("syncToPhone").onclick = () => setSyncPick("phone");
$("syncToCloud").onclick = () => setSyncPick("cloud");
$("syncYes").onclick = () => syncPick && syncChoiceDone(syncPick);
$("syncNo").onclick = () => setSyncPick(null);
$("syncChoiceBack").onclick = () => syncChoiceDone(null);
$("syncChoiceDialog").addEventListener("cancel", (e) => {
  e.preventDefault();
  syncChoiceDone(null);
});

// logging in: the email and password are checked (the plug goes in meanwhile), then the cloud's copy comes down.
// the one exception: stats left on this device from before the app went cloud-only. those go up when the cloud
// has none; with stats on both sides you choose which copy wins (chooseSync above)
$("loginForm").onsubmit = (e) => {
  e.preventDefault();
  if (registerMode) return register();
  const email = $("loginEmail").value.trim();
  const password = $("loginPassword").value;
  if (!email || !password) return;
  // the email and password are checked first (the plug goes in meanwhile); only then the warning (always). 👍 = connected. 👎 / tap off = the plug comes back out and that login is thrown away
  const plug = $("plugBtn");
  plug.classList.add("plugged"); // in it goes
  const landed = new Promise((ok) => setTimeout(ok, 600)); // let the plug land before anything else happens
  authCall("grant_type=password", { email, password }).then(
    async (newSession) => {
      await landed;
      // which way the first sync goes. "phone" = sync to phone: the cloud's copy comes down and replaces this
      // device's. "cloud" = sync to cloud: this device's copy goes up and replaces the cloud's
      const connect = (to) => {
        storeSession(newSession);
        $("loginPassword").value = "";
        renderAccount();
        if (to === "cloud") {
          useLeftover(); // this device's leftover copy is the one, and goes up
          cloudPush();
        } else {
          showHome(); // "loading…" until the cloud's copy is down (the leftovers go once it is)
          cloudStart();
        }
      };
      const cancel = () => {
        plug.classList.remove("plugged");
        // not using it: end that session on Supabase's side too (best effort)
        fetch(`${SB_URL}/auth/v1/logout`, { method: "POST", headers: { apikey: SB_KEY, Authorization: `Bearer ${newSession.access_token}` } }).catch(() => {});
      };
      // nothing left on this device (the usual case): the cloud's copy comes down. leftovers: they go up if the
      // cloud is empty; with stats on both sides (or it can't tell), you choose
      if (!leftover.stats.length) return connect("phone");
      let cloudHas = true;
      try {
        cloudHas = await cloudHasStats(newSession.access_token);
      } catch {}
      if (!cloudHas) return connect("cloud");
      chooseSync(connect, cancel);
    },
    async (err) => {
      await landed;
      // didn't work: while it's still plugged in, it turns red and jitters; then it comes back apart (and fades back)
      plug.classList.remove("fail");
      void plug.offsetWidth; // (so it plays again on a second miss)
      plug.classList.add("fail");
      setTimeout(() => plug.classList.remove("plugged"), 500); // after the jitter (0.45s)
      setTimeout(() => plug.classList.remove("fail"), 1300); // red until it's apart, then back to normal
      // wrong email or password: both fields cleared. no connection: what you typed stays
      const fields = [$("loginEmail"), $("loginPassword")];
      if (!(err instanceof TypeError)) for (const f of fields) f.value = "";
    }
  );
};
// log out (👍 / 👎; tapping away cancels too). your stats stay in the cloud, and nothing is left on the device:
// the page fades and the cloud implodes, a change not sent yet goes up first, then it's the # screen
$("logoutBtn").onclick = () =>
  ask(
    '<span class="ask-head"><svg class="ic"><use href="#i-warn" /></svg><b>disconnect</b></span>log out? your <b>stats</b> stay in the cloud.',
    disconnect,
    true
  );
function disconnect() {
  const page = $("accountDialog");
  page.classList.add("leaving");
  const sent = pending && !isOffline() ? cloudPush() : Promise.resolve();
  const animated = new Promise((ok) => setTimeout(ok, 1500)); // 0.6s fade, then the 0.6s implode (starts at 0.75s), then a beat
  Promise.all([sent, animated]).then(() => {
    page.classList.remove("leaving");
    endSession();
  });
}
// logged out: the login goes (here and on Supabase), and so does everything of yours in memory
function logOut() {
  const token = session && session.access_token;
  clearTimeout(pushTimer);
  storeSession(null);
  setPending(false);
  stats = [];
  settings = loadSettings();
  applySettings(settings);
  loaded = false;
  loadError = "";
  lastSync = null;
  syncing = false;
  syncError = "";
  shareName = null;
  $("shareName").value = "";
  $("plugBtn").classList.remove("plugged"); // unplugged, ready for next time
  renderAccount();
  if (token) fetch(`${SB_URL}/auth/v1/logout`, { method: "POST", headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` } }).catch(() => {});
}
// logged out, whatever was open: every page closes onto the # screen
function endSession() {
  logOut();
  for (const d of document.querySelectorAll("dialog[open]")) d.close();
  accountFromStart = accountFromHelp = false;
  showHome();
}
// ── ? guide → cloud sync: the info page, and deleting everything of yours in the cloud ──
// "here" only works (and only looks tappable) while connected
$("cloudInfoBtn").onclick = () => {
  $("cloudDeleteBtn").disabled = !session;
  show($("cloudInfoDialog"));
};
$("cloudInfoBack").onclick = () => $("cloudInfoDialog").close();
$("cloudInfoDialog").addEventListener("click", (e) => {
  if (!e.target.closest("button, a")) $("cloudInfoDialog").close(); // tap anywhere else: back to the guide
});
// "here": your stats, settings and live view are deleted from the cloud, and this device logs out (onto the #
// screen). the account itself (email + password) stays
$("cloudDeleteBtn").onclick = () => {
  if (!session) return;
  ask('<span class="ask-head"><svg class="ic"><use href="#i-warn" /></svg><b>warning</b></span>delete all your stats, settings and live view from the cloud? this can\'t be undone.', async () => {
    clearTimeout(pushTimer); // no upload sneaking in while it deletes
    try {
      await rest("shares?user_id=not.is.null", { method: "DELETE" });
      await rest("stats?user_id=not.is.null", { method: "DELETE" });
      await rest("settings?user_id=not.is.null", { method: "DELETE" });
    } catch (e) {
      return ask(e instanceof TypeError ? "no connection: nothing was deleted." : `couldn't delete: ${e.message}`);
    }
    endSession(); // so nothing goes back up
    ask("your info on the cloud is deleted. you're logged out.");
  }, true);
};

// first-visit guide → "To sync online click here": the cloud login, opened on top of the guide.
// back closes both: logged in, onto your list; not, back to the # screen (not the guide)
let accountFromHelp = false;
$("helpSync").onclick = () => {
  accountFromHelp = true;
  renderAccount();
  show($("accountDialog"));
};

// opened from the first visit's "#welcomeback" (not the menu): back goes back to the # screen
let accountFromStart = false;
function openAccountFromStart() {
  accountFromStart = true;
  accountFromHelp = false;
  renderAccount();
  show($("accountDialog"));
}
// back: to wherever it was opened from (the menu, the first-timer guide, or the # screen)
$("accountBack").onclick = () => {
  $("accountDialog").close();
  if (accountFromHelp) $("helpDialog").close(); // the guide goes too: onto the # screen (or, logged in, your list)
  // the # screen (or, logged in with stats now, the list) is right behind
  if (!accountFromHelp && !accountFromStart) show($("menuDialog"));
  accountFromStart = accountFromHelp = false;
};

// sync when the app opens, when the connection comes back, and when you come back to the app
window.addEventListener("online", () => {
  offline = false;
  renderAccount(); // the plug at the top goes back together straight away
  if (!loaded && session) {
    loadError = ""; // "no connection" → "loading…"
    render();
  }
  cloudStart();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") cloudStart();
});
// and quietly once a minute while the app is open: picks up changes from your other devices
setInterval(() => {
  if (document.visibilityState === "visible" && navigator.onLine) cloudStart(true);
}, 60 * 1000);
updatePlugIcons();
// logged in, opening the app: a change from before the app went cloud-only that never went up goes up now
// (this device's copy is the newest); otherwise the cloud's copy comes down
setTimeout(() => {
  if (session && leftover.pending && leftover.stats.length) {
    useLeftover();
    return cloudPush();
  }
  cloudStart();
}, 0);
