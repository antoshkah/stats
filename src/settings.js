// settings page: font, colours, hold, pause. loadSettings / applySettings / THEMES / FONTS live in
// the inline script in index.html's <head>, so the look is applied before the page draws

// settings
let settings = loadSettings();
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
  applySettings(settings);
  renderSettings();
  if (typeof cloudQueue === "function") cloudQueue(); // logged in: copy the change up to the cloud (cloud.js loads last)
}
const holdLabel = (ms) => `${(ms / 1000).toFixed(1)}s`;
// font list: one button per font, made once and only ever reordered (chosen font first)
const fontBtns = {};
for (const [key, f] of Object.entries(FONTS)) {
  const b = document.createElement("button");
  b.textContent = f.label;
  b.style.fontFamily = f.css;
  b.setAttribute("role", "option");
  b.onclick = () => {
    const s = $("fontSetting");
    // the top line (the chosen font) opens / closes the list
    if (key === settings.font) {
      s.classList.toggle("open");
      return;
    }
    // another font: it slides up to the top while the list folds away
    settings.font = key;
    saveSettings();
    orderFonts(true);
    s.classList.remove("open");
  };
  fontBtns[key] = b;
}
$("fontList").style.setProperty("--n", Object.keys(FONTS).length);
// chosen font first, the rest in their usual order. animate: each button glides from
// where it was to its new place (measure, reorder, then play back the difference)
function orderFonts(animate) {
  const list = $("fontList");
  const before = new Map(Object.values(fontBtns).map((b) => [b, b.getBoundingClientRect().top]));
  const order = [settings.font, ...Object.keys(FONTS).filter((k) => k !== settings.font)];
  for (const k of order) {
    list.append(fontBtns[k]);
    fontBtns[k].setAttribute("aria-selected", k === settings.font);
  }
  if (!animate) return;
  for (const [b, top] of before) {
    const dy = top - b.getBoundingClientRect().top;
    if (dy) b.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 250, easing: "ease" });
  }
}
function renderSettings() {
  const themes = $("themeList");
  themes.innerHTML = "";
  for (const [key, t] of Object.entries(THEMES)) {
    const b = document.createElement("button");
    b.style.background = t.bg;
    b.setAttribute("aria-label", key);
    b.title = key;
    b.classList.toggle("on", key === settings.theme);
    b.onclick = () => { settings.theme = key; saveSettings(); }; // stays open to try others
    themes.append(b);
  }
  $("holdNum").textContent = holdLabel(settings.hold);
  $("holdVal").textContent = holdLabel(settings.hold); // the hold line shows the seconds chosen
  for (const b of document.querySelectorAll("[data-mode]")) {
    const [key, value] = b.dataset.mode.split(":");
    b.classList.toggle("on", settings[key] === value);
  }
  // the pause line shows the number of taps chosen
  $("pauseVal").textContent = { off: 0, tap: 1, double: 2 }[settings.timerPause];
  for (const b of document.querySelectorAll("[data-toggle]")) {
    b.classList.toggle("on", settings[b.dataset.toggle]);
    b.setAttribute("aria-checked", settings[b.dataset.toggle]);
  }
  $("themeVal").innerHTML = `<span class="dot" style="background:${THEMES[settings.theme].bg}"></span>${settings.theme}`;
}
// pause: 0 / 1 / 2 taps (stays open, so you can see what you picked)
for (const b of document.querySelectorAll("[data-mode]")) {
  const [key, value] = b.dataset.mode.split(":");
  b.onclick = () => {
    settings[key] = value;
    saveSettings();
  };
}
// info: each line on the stat page switches on / off by itself
for (const b of document.querySelectorAll("[data-toggle]")) {
  b.onclick = () => {
    settings[b.dataset.toggle] = !settings[b.dataset.toggle];
    saveSettings();
    render(); // "deleted" changes the list itself
  };
}
// − / +: 0.1s a tap; keep holding to run through the values
for (const b of document.querySelectorAll("[data-step]")) {
  const [key, dir] = b.dataset.step.split(":");
  let repeat = null;
  const step = () => {
    const next = Math.min(HOLD_MAX, Math.max(HOLD_MIN, settings[key] + Number(dir) * HOLD_STEP));
    if (next === settings[key]) return;
    settings[key] = next;
    saveSettings();
  };
  const stop = () => { clearTimeout(repeat); clearInterval(repeat); };
  b.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    step();
    stop();
    repeat = setTimeout(() => (repeat = setInterval(step, 70)), 400);
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) b.addEventListener(ev, stop);
  b.addEventListener("click", (e) => { if (e.detail === 0) step(); }); // keyboard
  b.addEventListener("contextmenu", (e) => e.preventDefault());
}
// each line opens / closes on its own; any number can be open at once
function closeDropdowns() {
  for (const s of document.querySelectorAll(".setting")) s.classList.remove("open");
}
for (const head of document.querySelectorAll(".set-head")) {
  head.onclick = () => head.parentElement.classList.toggle("open");
}
$("settingsBtn").onclick = () => {
  $("menuDialog").close();
  closeDropdowns();
  orderFonts(false);
  renderSettings();
  show($("settingsDialog"));
};
// the exit button is the only way out, and it goes back to the menu
$("settingsDone").onclick = () => {
  hideTip();
  $("settingsDialog").close();
  show($("menuDialog"));
};
$("settingsDialog").addEventListener("cancel", (e) => e.preventDefault()); // no Esc / back gesture

// tap a line's icon (not its words) → a bubble under it saying what that line is for.
// goes away after 5s, or on the next tap anywhere
let tipTimer = null;
let tipFor = null;
function hideTip() {
  $("setTip").classList.remove("on");
  tipFor = null;
}
function showTip(icon) {
  const tip = $("setTip");
  const box = tip.parentElement.getBoundingClientRect();
  const r = icon.getBoundingClientRect();
  // plain text, except {clock} becomes the clock icon (e.g. "a {clock} stat" = a timed stat)
  // {restore} the restore icon (the button on a deleted stat's page), {reset} the reset icon, {delete} the (red) trash,
  // {noreset} / {nodelete}: those two with a red cross over them
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);
  tip.innerHTML = esc(icon.dataset.tip)
    .replaceAll("{clock}", '<svg class="ic tip-ic" aria-label="timed"><use href="#i-clock" /></svg>')
    .replaceAll("{restore}", '<svg class="ic tip-ic" aria-label="restoring"><use href="#i-restore" /></svg>')
    .replaceAll("{reset}", '<svg class="ic tip-ic" aria-label="reset"><use href="#i-reset" /></svg>')
    .replaceAll("{delete}", '<svg class="ic tip-ic danger" aria-label="deletes"><use href="#i-trash" /></svg>')
    .replaceAll("{noreset}", '<svg class="ic tip-ic" aria-label="not resets"><use href="#i-reset-x" /></svg>')
    .replaceAll("{nodelete}", '<svg class="ic tip-ic" aria-label="not deletes"><use href="#i-trash-x" /></svg>');
  // one line, kept inside the settings column (so it never pushes the page sideways on a phone):
  // ideally starting just left of the icon, shifted left if it would run off the right edge.
  // the point stays under the icon's middle wherever the bubble ends up
  // too long for one line across the column: the text shrinks until it fits
  tip.style.fontSize = "";
  if (tip.offsetWidth > box.width) {
    const size = parseFloat(getComputedStyle(tip).fontSize);
    const extra = tip.offsetWidth - tip.clientWidth + 20; // border + the 10px padding each side don't shrink
    tip.style.fontSize = `${Math.floor(size * ((box.width - extra) / (tip.offsetWidth - extra)) * 10) / 10}px`;
  }
  const mid = r.left + r.width / 2 - box.left;
  const left = Math.max(0, Math.min(mid - 18, box.width - tip.offsetWidth));
  tip.style.left = `${left}px`;
  tip.style.top = `${r.bottom - box.top + 8}px`;
  tip.style.setProperty("--point", `${mid - left - 4}px`);
  tip.classList.add("on");
  tipFor = icon;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(hideTip, 5000);
}
for (const icon of document.querySelectorAll("#settingsDialog [data-tip]")) {
  icon.addEventListener("click", (e) => {
    e.stopPropagation(); // the icon explains; it doesn't open the drop-down
    if (tipFor === icon) hideTip();
    else showTip(icon);
  });
}
$("settingsDialog").addEventListener("pointerdown", (e) => {
  if (!e.target.closest("[data-tip]")) hideTip();
});
$("settingsDialog").addEventListener("close", hideTip);
