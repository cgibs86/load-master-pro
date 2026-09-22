/*
 * LoadMaster Pro AI — service worker registration and update handling.
 *
 * Registering the worker is the easy half. The half that actually bit us is
 * what happens when a NEW version is deployed while someone has the old one
 * installed: without this file, the browser quietly installs the update and
 * the person keeps looking at the old page until they happen to come back a
 * second time. A price change can be live on the server and still not be on
 * their screen. So:
 *
 *   updateViaCache: "none"  the worker script is always fetched from the
 *                           network, never from the 10-minute HTTP cache, so
 *                           an update is noticed on the next visit rather
 *                           than up to ten minutes later.
 *   update() on load and on tab focus, so a truck-radio tab left open all day
 *                           still picks up a deploy.
 *   controllerchange        once a new worker takes over, reload so the page
 *                           is running the version that just installed.
 *
 * The reload is deliberately skipped on first install: a page that has just
 * downloaded everything for the first time is already current, and reloading
 * it would be a visible flicker for no reason.
 */
(function () {
  "use strict";
  if (!("serviceWorker" in navigator)) return;

  // Captured before registration: null here means this is a first install,
  // not an update replacing something stale.
  var hadController = !!navigator.serviceWorker.controller;
  var reloading = false;

  navigator.serviceWorker.addEventListener("controllerchange", function () {
    if (!hadController) return;   // first install — nothing stale to replace
    if (reloading) return;        // guard against a reload loop
    reloading = true;
    location.reload();
  });

  window.addEventListener("load", function () {
    navigator.serviceWorker.register("service-worker.js", { updateViaCache: "none" })
      .then(function (reg) {
        // Ask immediately, in case this tab was opened from a bookmark long
        // after the last deploy.
        reg.update().catch(function () {});
        document.addEventListener("visibilitychange", function () {
          if (!document.hidden) reg.update().catch(function () {});
        });
      })
      .catch(function () { /* no worker: the app still works, just not offline */ });
  });
})();
