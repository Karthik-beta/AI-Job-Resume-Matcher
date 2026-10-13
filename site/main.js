(() => {
  const root = document.documentElement;

  const run = document.querySelector("[data-run]");
  if (run) {
    setUpRun(run);
  }
  setUpInstallers(document.querySelectorAll("[data-installer]"));

  function setUpRun(run) {
    const titles = [...run.querySelectorAll(".wall .t")];
    const dropped = titles.filter((title) => title.dataset.v === "f");
    const checked = titles.filter((title) => title.dataset.v === "m" || title.dataset.v === "n");
    const count = (name) => run.querySelector(`[data-count="${name}"]`);
    const counts = {
      found: count("found"),
      eligible: count("eligible"),
      checked: count("checked"),
      matches: count("matches"),
    };
    const verdict = {
      badge: run.querySelector("[data-verdict-badge]"),
      title: run.querySelector("[data-verdict-title]"),
      company: run.querySelector("[data-verdict-company]"),
      reason: run.querySelector("[data-verdict-reason]"),
    };

    for (const button of checked) {
      button.addEventListener("click", () => select(button));
    }

    function select(button) {
      for (const other of checked) {
        other.setAttribute("aria-pressed", String(other === button));
      }
      const isMatch = button.dataset.v === "m";
      verdict.badge.textContent = isMatch ? "Match" : "No match";
      verdict.badge.className = `badge ${isMatch ? "badge-match" : "badge-no-match"}`;
      verdict.title.textContent = button.firstChild.textContent;
      verdict.company.textContent = button.dataset.company;
      verdict.reason.textContent = button.dataset.reason;
    }

    // The markup already shows the finished run, which is what reduced motion gets.
    if (!root.classList.contains("js-play")) {
      return;
    }

    const timers = [];
    const at = (ms, step) => timers.push(window.setTimeout(step, ms));

    function reset() {
      for (const timer of timers.splice(0)) {
        window.clearTimeout(timer);
      }
      for (const title of titles) {
        title.classList.remove("is-done", "is-checking");
      }
      counts.found.textContent = String(titles.length);
      counts.eligible.textContent = String(titles.length);
      counts.checked.textContent = "0";
      counts.matches.textContent = "0";
    }

    // The filters strike the dropped titles first, then the eligible ones are checked in order.
    function play() {
      reset();
      const strikeEvery = 34;
      dropped.forEach((title, index) => {
        at(250 + index * strikeEvery, () => {
          title.classList.add("is-done");
          counts.eligible.textContent = String(titles.length - index - 1);
        });
      });

      const checkFrom = 250 + dropped.length * strikeEvery + 450;
      const checkEvery = 380;
      let matches = 0;
      checked.forEach((title, index) => {
        const start = checkFrom + index * checkEvery;
        at(start, () => title.classList.add("is-checking"));
        at(start + 240, () => {
          title.classList.remove("is-checking");
          title.classList.add("is-done");
          counts.checked.textContent = String(index + 1);
          if (title.dataset.v === "m") {
            matches += 1;
            counts.matches.textContent = String(matches);
          }
        });
      });
    }

    reset();
    run.querySelector("[data-replay]").addEventListener("click", play);

    // Start when the sheet is on screen, so a reader below the fold still sees the run happen.
    const wall = run.querySelector(".wall");
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          play();
        }
      },
      { threshold: 0.3 },
    );
    observer.observe(wall);
  }

  function setUpInstallers(installers) {
    if (installers.length === 0) {
      return;
    }
    const chooseOs = (os) => {
      for (const installer of installers) {
        for (const button of installer.querySelectorAll("[data-os]")) {
          button.setAttribute("aria-pressed", String(button.dataset.os === os));
        }
        for (const command of installer.querySelectorAll("[data-command]")) {
          command.hidden = command.dataset.command !== os;
        }
      }
    };

    for (const installer of installers) {
      for (const button of installer.querySelectorAll("[data-os]")) {
        button.addEventListener("click", () => chooseOs(button.dataset.os));
      }
      for (const button of installer.querySelectorAll("[data-copy]")) {
        button.addEventListener("click", () => copy(button));
      }
    }

    chooseOs(/Windows/i.test(navigator.userAgent) ? "windows" : "unix");
  }

  function copy(button) {
    const text = button.parentElement.querySelector("code").textContent;
    // The button's new label isn't announced by every screen reader, so a status line says it too.
    const status = document.querySelector("[data-copy-status]");
    const done = (label) => {
      button.textContent = label;
      status.textContent = "Install command copied";
      window.setTimeout(() => {
        button.textContent = "Copy";
        status.textContent = "";
      }, 2000);
    };
    if (!navigator.clipboard) {
      selectCommand(button);
      return;
    }
    navigator.clipboard.writeText(text).then(
      () => done("Copied"),
      () => selectCommand(button),
    );
  }

  // Without clipboard access, select the command so the reader can copy it by hand.
  function selectCommand(button) {
    const code = button.parentElement.querySelector("code");
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
})();
