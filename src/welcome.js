// the first visit's extras: the little Claude Code guy and "powered by Claude Code" at the bottom of the first-timer guide

// (still used by wipeLocal in app.js: an old flag from the welcome page, cleared with the rest)
const WELCOME_KEY = "stats.welcomed";

// the Claude Code mascot in pixels: 18 × 5, each pixel twice as tall as wide (like terminal blocks)
(function drawClawd() {
  const body = [
    "...############...",
    "...##.######.##...", // the gaps are the eyes
    ".################.",
    "...############...",
  ];
  const legsA = "....#.#....#.#....";
  const legsB = "...#.#......#.#...";
  const ns = "http://www.w3.org/2000/svg";
  const g = (cls) => {
    const el = document.createElementNS(ns, "g");
    if (cls) el.setAttribute("class", cls);
    $("clawd").append(el);
    return el;
  };
  const px = (group, x, y) => {
    const r = document.createElementNS(ns, "rect");
    r.setAttribute("x", x);
    r.setAttribute("y", y * 2);
    r.setAttribute("width", 1);
    r.setAttribute("height", 2);
    group.append(r);
  };
  const row = (group, line, y) => [...line].forEach((c, x) => c === "#" && px(group, x, y));
  const b = g();
  body.forEach((line, y) => row(b, line, y));
  row(g("legs-a"), legsA, 4);
  row(g("legs-b"), legsB, 4);
  const lids = g("lids"); // fill the eyes for a blink
  px(lids, 5, 1);
  px(lids, 12, 1);
})();

// "powered by Claude Code" (bottom of the first-timer guide) types out, one letter at a time, with the little guy as
// the cursor just after the last letter, so the letters come out of him. once it's all typed he walks on a little past
// the text, swells a touch and implodes. every letter becomes its own span (keeps the <b> around "Claude Code" for its
// colour). the letters are wrapped now; playPoweredBy() runs it when the guide opens (app.js)
const pbLetters = [];
(function wrapLetters() {
  const guy = $("clawd");
  const wrap = (node) => {
    for (const n of [...node.childNodes]) {
      if (n === guy) continue;
      if (n.nodeType !== Node.TEXT_NODE) {
        wrap(n);
        continue;
      }
      const frag = document.createDocumentFragment();
      for (const ch of n.textContent) {
        const s = document.createElement("span");
        s.textContent = ch;
        pbLetters.push(s);
        frag.append(s);
      }
      n.replaceWith(frag);
    }
  };
  wrap(document.querySelector(".pb-text"));
})();
let pbRun = 0; // bumps on every play, so timers from an earlier one stop
function playPoweredBy() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return; // the CSS shows the whole line
  const run = ++pbRun;
  const START = 600; // ms before the first letter (he shows up first)
  const EACH = 70; // ms per letter
  const guy = $("clawd");
  const later = (ms, fn) => setTimeout(() => run === pbRun && fn(), ms);
  // start over: no letters, no guy
  for (const s of pbLetters) s.classList.remove("on");
  guy.classList.remove("on", "typing", "gone");

  // his left edge on the right edge of letter i: the letters come out of him and stay behind.
  // -1 = where the first letter will be, before any are out
  const place = (i) => {
    const s = pbLetters[Math.max(i, 0)];
    guy.style.left = `${i < 0 ? s.offsetLeft : s.offsetLeft + s.offsetWidth}px`;
  };
  later(START - 300, () => {
    guy.style.transition = "none"; // appear in place, don't slide in
    place(-1);
    void guy.getBoundingClientRect();
    guy.style.transition = "";
    guy.classList.add("on", "typing");
  });
  pbLetters.forEach((s, i) =>
    later(START + i * EACH, () => {
      s.classList.add("on");
      place(i);
    })
  );
  const end = START + pbLetters.length * EACH;
  const STEP_AWAY = 6; // px: he walks on a little past the text, then swells and implodes
  later(end, () => (guy.style.left = `${parseFloat(guy.style.left) + STEP_AWAY}px`));
  later(end + EACH, () => {
    guy.classList.remove("typing");
    guy.classList.add("gone");
  });
}
