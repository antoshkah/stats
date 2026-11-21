// the animated walkthrough at the top of the how-to page (runDemo is started by show() in app.js)
// the story: make a counted and a timed stat, hold into counted and reset it, cut to timed and reset it,
// tap off back to the list, hold into counted again and delete it, then hold the + to open the menu.
// the jump from one stat page to the other is a soft cut (the screen dips and comes back), so they don't look like something the app does on its own

// the walkthrough loops while the guide is open; closing it (or reopening) stops the old loop
let demoRun = 0;
async function runDemo() {
  const run = ++demoRun;
  const wait = (ms) =>
    new Promise((ok, stop) => setTimeout(() => (run === demoRun && $("helpDialog").open ? ok() : stop()), ms));
  const demo = $("demo");
  const finger = $("dFinger");
  const moveTo = async (el) => {
    const a = demo.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    const appear = !finger.classList.contains("on");
    finger.style.transition = appear ? "none" : "";
    finger.style.transform = `translate(${b.left - a.left + b.width / 2}px, ${b.top - a.top + b.height / 2}px)`;
    if (appear) {
      await wait(30);
      finger.style.transition = "";
      finger.classList.add("on");
      await wait(300);
    } else {
      await wait(550);
    }
  };
  const tap = async () => {
    finger.classList.add("press");
    await wait(130);
    finger.classList.remove("press");
    await wait(120);
  };
  const bump = (el) => {
    el.classList.remove("bump");
    void el.offsetWidth; // restart the animation
    el.classList.add("bump");
  };
  const poof = (el) => {
    const a = demo.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    const cx = b.left - a.left + b.width / 2;
    const cy = b.top - a.top + b.height / 2;
    el.classList.add("poof");
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const s = document.createElement("span");
      s.className = "d-line";
      s.style.left = `${cx + Math.cos(angle) * 18}px`;
      s.style.top = `${cy + Math.sin(angle) * 12}px`;
      s.style.setProperty("--a", `${angle + Math.PI / 2}rad`); // point outward
      s.style.setProperty("--dx", `${Math.cos(angle) * 11}px`);
      s.style.setProperty("--dy", `${Math.sin(angle) * 11}px`);
      demo.append(s);
      setTimeout(() => s.remove(), 500);
    }
  };

  // which stat page is showing: "counted", "timed" or "" (the list)
  let page = "";
  let count = 0;
  // the demo timer: ticks one second at a time while running, on its row and (if open) its page
  let tSecs = 0;
  let tRunning = false;
  const showTime = () => {
    $("dCountT").textContent = `${tSecs}s`;
    if (page === "timed") $("dBig").textContent = `${tSecs}s`;
  };
  // (re)started the moment the timer starts, so its seconds land on known beats of the story
  let ticker = null;
  const startTimer = () => {
    clearInterval(ticker);
    tRunning = true;
    ticker = setInterval(() => {
      if (run !== demoRun || !$("helpDialog").open) return clearInterval(ticker);
      if (!tRunning) return;
      tSecs++;
      showTime();
    }, 1000);
  };

  // fill the stat page for one of the two stats
  const fillPage = (kind) => {
    page = kind;
    const timer = kind === "timed";
    $("dPopName").textContent = kind;
    $("dBig").classList.remove("swell", "bump");
    $("dBig").classList.toggle("timer", timer);
    $("dBig").textContent = timer ? `${tSecs}s` : count;
    $("dMinus").hidden = timer;
  };
  // a soft cut: the screen dips to the background, the scene changes behind it, then it comes back
  const cut = async (change) => {
    finger.classList.remove("on");
    $("dCut").classList.add("on");
    await wait(500);
    change();
    await wait(250);
    $("dCut").classList.remove("on");
    await wait(550);
  };
  const openByCut = (kind) =>
    cut(() => {
      fillPage(kind);
      $("dPop").classList.add("on");
    });

  // hold a stat's row to open its page
  const hold = async (kind) => {
    await moveTo($(kind === "timed" ? "dNameT" : "dNameC"));
    finger.classList.add("hold");
    await wait(750);
    finger.classList.remove("hold");
    fillPage(kind);
    $("dPop").classList.add("on");
    await wait(700);
  };
  // move to an empty point, given as a fraction of the demo's width / height
  const moveToSpot = async (fx, fy) => {
    const a = demo.getBoundingClientRect();
    finger.style.transform = `translate(${a.width * fx}px, ${a.height * fy}px)`;
    await wait(550);
  };

  // shared steps: open the name field, type, then tap # or the clock; the new row shows up in the list
  const addStat = async (kindEl, name, row) => {
    await moveTo($("dStar"));
    await tap();
    $("dStar").hidden = true;
    $("dTyped").textContent = "";
    $("dBox").hidden = false;
    finger.classList.remove("on");
    await wait(300);
    for (const ch of name) {
      $("dTyped").textContent += ch;
      await wait(110);
    }
    await wait(350);
    await moveTo(kindEl);
    await tap();
    $("dBox").hidden = true;
    $("dStar").hidden = false;
    row.hidden = false;
  };
  // ask → yes on the stat page that's showing
  const confirm = async (btn, what) => {
    $("dAsk").textContent = `${what} "${page}"?`;
    await moveTo(btn);
    await tap();
    $("dZero").classList.add("on");
    await wait(500);
    await moveTo($("dYes"));
    await tap();
    $("dZero").classList.remove("on");
  };
  // reset → yes: the value swells and lands on zero (a running timer keeps going from zero)
  const reset = async () => {
    await confirm($("dReset"), "reset");
    await wait(150);
    const el = $("dBig");
    el.classList.remove("swell", "bump");
    void el.offsetWidth;
    el.classList.add("swell");
    await wait(230); // at its biggest
    if (page === "timed") {
      tSecs = 0;
      showTime();
    } else {
      count = 0;
      el.textContent = 0;
      $("dCountC").textContent = 0;
    }
    await wait(300);
    el.classList.remove("swell");
  };

  try {
    while (true) {
      // fresh scene
      demo.classList.remove("fade");
      for (const id of ["dRowC", "dRowT"]) {
        $(id).hidden = true;
        $(id).classList.remove("poof");
      }
      $("dBig").classList.remove("swell", "timer");
      $("dBox").hidden = true;
      $("dStar").hidden = false;
      $("dTyped").textContent = "";
      $("dPop").classList.remove("on");
      $("dZero").classList.remove("on");
      $("dCut").classList.remove("on");
      $("dMenu").classList.remove("on");
      finger.classList.remove("on", "press", "hold");
      page = "";
      count = 0;
      $("dCountC").textContent = 0;
      tRunning = false;
      tSecs = 0;
      showTime();
      await wait(700);

      // ── make both: a counted stat (tapped a few times) and a timed one (ticking from the moment it's made) ──
      await addStat($("dKStar"), "counted", $("dRowC"));
      await wait(400);
      await moveTo($("dCountC"));
      for (let n = 1; n <= 3; n++) {
        await tap();
        count = n;
        $("dCountC").textContent = n;
        bump($("dCountC"));
        await wait(180);
      }
      await wait(300);
      await addStat($("dKClock"), "timed", $("dRowT"));
      startTimer();
      finger.classList.remove("on");
      // timed so the cut to the timed page lands just after it ticks to 6s (≈6.06s in), and 7s follows
      // right after the fade back in: hold into counted 1.78s + reset 2.78s + 0.7s + the cut's dip 0.5s = 5.76s
      await wait(300);

      // ── reset both: hold into counted, reset, then a soft cut over to timed and reset that too ──
      await hold("counted");
      await reset();
      await wait(700);
      await openByCut("timed");
      await wait(600);
      await reset();
      await wait(900);

      // tap any empty space on the stat page to go back to the list
      await moveToSpot(0.22, 0.2);
      await tap();
      $("dPop").classList.remove("on");
      page = "";
      await wait(700);

      // ── delete just the counted one: hold into it, delete, the pages close and the row bursts away ──
      await hold("counted");
      await confirm($("dTrash"), "delete");
      finger.classList.remove("on");
      $("dPop").classList.remove("on");
      page = "";
      await wait(220); // the pages fade away
      poof($("dRowC"));
      await wait(500);
      // the empty space closes up: timed (and the +) slide to the middle, like the real list re-centring
      const movers = [$("dRowT"), $("dStar")];
      const before = movers.map((el) => el.getBoundingClientRect().top);
      $("dRowC").hidden = true;
      movers.forEach((el, i) => {
        el.style.transition = "none";
        el.style.transform = `translateY(${before[i] - el.getBoundingClientRect().top}px)`;
      });
      void demo.offsetWidth;
      for (const el of movers) {
        el.style.transition = "transform 0.35s ease-in-out";
        el.style.transform = "";
      }
      await wait(600);
      for (const el of movers) el.style.transition = "";

      // ── hold the + to open the menu ──
      await moveTo($("dStar"));
      finger.classList.add("hold");
      await wait(750);
      finger.classList.remove("hold");
      $("dMenu").classList.add("on");
      await wait(500);
      finger.classList.remove("on");
      await wait(1800);

      demo.classList.add("fade");
      await wait(500);
    }
  } catch {
    // stopped: the guide was closed or reopened
  }
}
