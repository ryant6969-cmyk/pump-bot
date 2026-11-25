// Runs before the app. If the app hasn't started after 12 seconds (for
// example a half-finished download), it offers a clean reload.
(function () {
  setTimeout(function () {
    if (window.__winbotStarted || window.__winbotFailed) return;
    var boot = document.getElementById('boot');
    if (!boot) return;
    boot.hidden = false;
    boot.innerHTML = '<p style="padding:0 28px;text-align:center">Win Bot is taking too long to start.</p>' +
      '<button id="boot-reload" class="btn go" style="width:auto;padding:0 28px">Reload</button>';
    document.getElementById('boot-reload').addEventListener('click', function () {
      var done = function () { location.reload(); };
      try {
        if (!window.caches) return done();
        caches.keys().then(function (keys) { return Promise.all(keys.map(function (k) { return caches.delete(k); })); }).then(done, done);
      } catch (e) { done(); }
    });
  }, 12000);
})();
