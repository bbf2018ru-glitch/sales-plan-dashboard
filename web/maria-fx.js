/* maria-fx.js — анимация вкладки «Маркетинг» (additive, поверх app.js).
   Навешивает .fx-in на #page-marketing при открытии вкладки/смене подвкладки,
   проставляя стаггер-задержку --d на карточки/бары. CSS (styles-maria.css) делает
   остальное. Полностью безопасно: ничего не ломает, при reduced-motion — no-op.
   ОТКАТ: снять <script> на этот файл в index.html. */
(function () {
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    function trigger() {
      var pm = document.getElementById('page-marketing');
      if (!pm || pm.offsetParent === null) return; // вкладка не видна
      pm.classList.remove('fx-in');
      void pm.offsetWidth; // reflow — перезапустить анимацию
      var groups = [
        ['.mkt-yoy-card, .mkt-kpi, .mkt-chart, .mkt-alert, .mkt-comp-card', 45],
        ['.mkt-topbar, .mkt-dbar', 22]
      ];
      groups.forEach(function (g) {
        var els = pm.querySelectorAll(g[0]);
        for (var i = 0; i < els.length; i++) {
          els[i].style.setProperty('--d', (i % 16) * g[1] + 'ms');
        }
      });
      pm.classList.add('fx-in');
    }

    // Клик по навигации (вкладки) или подвкладкам маркетинга → проиграть вход
    document.addEventListener('click', function (e) {
      var t = e.target && e.target.closest && e.target.closest('.nav-btn, .atab');
      if (!t) return;
      setTimeout(trigger, 70); // дать app.js перерисовать контент
    }, true);

    // На случай прямой загрузки сразу на вкладке маркетинга
    window.addEventListener('load', function () { setTimeout(trigger, 350); });
  } catch (e) { /* тихо — анимация не критична */ }
})();
