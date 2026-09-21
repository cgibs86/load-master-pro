/*
 * LoadMaster Pro AI — "thinking" overlay.
 *
 * One shared busy indicator for every action that makes the user wait: the
 * load calculation, a recalculate, the room diagnosis, a proposal build, the
 * report, photo analysis, and any link that navigates to another page.
 *
 * Why an overlay rather than only a button spinner: the work behind these
 * buttons takes a second or two (a geocode, a year of hourly weather, a
 * vision call), and a page that looks frozen reads as broken — especially on
 * a phone in a driveway with one bar of signal. The overlay says what is
 * happening, and it cycles through the real steps rather than showing a
 * generic bar, because "Analyzing 8,760 hours of weather" is also the moment
 * that sells the product to the homeowner watching over the rep's shoulder.
 *
 * Exposed as window.Thinking.
 */
(function (root, doc) {
  "use strict";

  var el = null, msgEl = null, stepTimer = null, openedAt = 0;
  // Below this, a flash of overlay is more distracting than helpful; above it,
  // silence reads as a broken tap. Anything already slower than ~120ms shows.
  var MIN_VISIBLE_MS = 420;

  function build() {
    if (el) return el;
    el = doc.createElement("div");
    el.className = "thinking";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.setAttribute("aria-hidden", "true");
    el.innerHTML =
      '<div class="thinking-box">' +
        '<div class="thinking-orbit">' +
          '<span class="to-ring"></span><span class="to-ring"></span><span class="to-ring"></span>' +
          '<span class="to-core"></span>' +
        '</div>' +
        '<div class="thinking-msg" id="thinkingMsg"></div>' +
        '<div class="thinking-dots"><i></i><i></i><i></i></div>' +
      '</div>';
    doc.body.appendChild(el);
    msgEl = el.querySelector("#thinkingMsg");
    return el;
  }

  function setMessage(text) {
    build();
    if (msgEl && text) msgEl.textContent = text;
  }

  /*
   * show(steps) — steps is a string, or an array of strings to walk through
   * while the work runs. The last step stays on screen rather than looping,
   * so a slow job doesn't look like it restarted.
   */
  function show(steps, stepMs) {
    build();
    clearInterval(stepTimer);
    var list = Array.isArray(steps) ? steps.slice() : [steps || "Working…"];
    setMessage(list[0]);
    if (list.length > 1) {
      var i = 0;
      stepTimer = setInterval(function () {
        i++;
        if (i >= list.length) { clearInterval(stepTimer); return; }
        setMessage(list[i]);
      }, stepMs || 1100);
    }
    openedAt = Date.now();
    el.classList.add("on");
    el.setAttribute("aria-hidden", "false");
    doc.body.classList.add("thinking-open");
  }

  function hide(force) {
    if (!el) return;
    clearInterval(stepTimer);
    var elapsed = Date.now() - openedAt;
    // Hiding instantly after a fast response makes the overlay flicker, which
    // looks like a glitch rather than a fast app.
    var wait = force ? 0 : Math.max(0, MIN_VISIBLE_MS - elapsed);
    setTimeout(function () {
      el.classList.remove("on");
      el.setAttribute("aria-hidden", "true");
      doc.body.classList.remove("thinking-open");
    }, wait);
  }

  /*
   * Wrap a promise so the overlay is guaranteed to come down, including on
   * rejection — a stuck overlay is worse than none at all.
   */
  function during(steps, promise, stepMs) {
    show(steps, stepMs);
    return Promise.resolve(promise).then(
      function (v) { hide(); return v; },
      function (e) { hide(true); throw e; }
    );
  }

  /*
   * Navigation links: show the overlay and let the browser navigate normally.
   * Nothing is intercepted — preventing default here would mean owning the
   * navigation, and any mistake in that code would strand the user on a page
   * whose link no longer works.
   */
  function wireLinks(selector, label) {
    Array.prototype.forEach.call(doc.querySelectorAll(selector), function (a) {
      a.addEventListener("click", function (ev) {
        // Let modified clicks (new tab, download, external) behave normally.
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || ev.button !== 0) return;
        var href = a.getAttribute("href") || "";
        if (!href || href.charAt(0) === "#" || /^(https?:|mailto:|tel:)/.test(href)) return;
        if (a.target === "_blank" || a.hasAttribute("download")) return;
        show(label || "Loading…");
      });
    });
  }

  // Returning via the back button restores the page from cache with the
  // overlay still up; clear it so the page isn't locked behind a spinner.
  root.addEventListener("pageshow", function () { hide(true); });
  root.addEventListener("pagehide", function () { hide(true); });

  root.Thinking = { show: show, hide: hide, during: during, setMessage: setMessage, wireLinks: wireLinks };
})(typeof window !== "undefined" ? window : this, document);
