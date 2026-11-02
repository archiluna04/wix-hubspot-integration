/*
 * Wix site attribution script (Embedded Script extension).
 * Embed snippet configured in the Wix Dev Center:
 *   <script src="https://YOUR_APP_HOST/embed/attribution.js" data-site-key="{{siteKey}}" async></script>
 * or, when the host can't serve scripts to browsers (e.g. free ngrok tunnels show an
 * interstitial page), the inline form printed by `npm run embed:snippet`.
 *
 * - Captures first-touch and latest-touch UTM parameters, landing page and external referrer
 *   in localStorage (first-party, this site only).
 * - When a form containing an email field is submitted, it sends the touch data plus that
 *   email to the app, where it is matched to the Wix Forms submission. The server stores only
 *   a salted hash of the email.
 */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script) return;
  var siteKey = script.getAttribute('data-site-key');
  // Real site keys are base64url; an unfilled template placeholder fails this test.
  if (!siteKey || !/^[A-Za-z0-9_-]{10,}$/.test(siteKey)) return;

  // Inline embeds (see `npm run embed:snippet`) pass the endpoint explicitly; src embeds derive it.
  var endpoint = script.getAttribute('data-endpoint');
  if (!endpoint) {
    try {
      endpoint = new URL(script.src).origin + '/public/attribution';
    } catch (e) {
      return;
    }
  }

  var STORAGE_KEY = 'whs_attribution_v1';
  var UTM = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function read() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
    } catch (e) {
      return {};
    }
  }
  function write(value) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch (e) {
      /* storage unavailable: attribution falls back to hidden form fields */
    }
  }
  function withoutQuery(url) {
    try {
      var u = new URL(url);
      return u.origin + u.pathname;
    } catch (e) {
      return '';
    }
  }
  function externalReferrer() {
    if (!document.referrer) return '';
    try {
      var r = new URL(document.referrer);
      return r.hostname === location.hostname ? '' : r.origin + r.pathname;
    } catch (e) {
      return '';
    }
  }

  // ---- record the touch for this page view ----
  var params = new URLSearchParams(location.search);
  var touch = { ts: Date.now(), landing_page: withoutQuery(location.href), referrer: externalReferrer() };
  var hasUtm = false;
  UTM.forEach(function (key) {
    var v = params.get(key);
    if (v) {
      touch[key] = v.slice(0, 200);
      hasUtm = true;
    }
  });

  var data = read();
  if (!data.first) data.first = touch;
  if (hasUtm || touch.referrer || !data.last) data.last = touch;
  write(data);

  // ---- report on form submit ----
  function findEmail(root) {
    var inputs = (root || document).querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i];
      var hint = [input.type, input.name, input.id, input.autocomplete, input.getAttribute('aria-label')].join(' ');
      var value = (input.value || '').trim();
      if (/mail/i.test(hint) && EMAIL_RE.test(value)) return value;
    }
    return '';
  }

  var lastSent = '';
  function report(root) {
    var email = findEmail(root);
    if (!email || email === lastSent) return;
    lastSent = email;
    var current = read();
    var body = JSON.stringify({
      siteKey: siteKey,
      email: email,
      first: current.first || null,
      last: current.last || null,
      pageUrl: withoutQuery(location.href),
      referrer: (current.last && current.last.referrer) || externalReferrer(),
    });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(endpoint, new Blob([body], { type: 'text/plain' }))) return;
    } catch (e) {
      /* fall through to fetch */
    }
    fetch(endpoint, { method: 'POST', body: body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(
      function () {},
    );
  }

  document.addEventListener(
    'submit',
    function (e) {
      report(e.target);
    },
    true,
  );
  // Wix Forms may submit via a button handler instead of a native submit event.
  document.addEventListener(
    'click',
    function (e) {
      var target = e.target && e.target.closest ? e.target.closest('button, [role="button"], input[type="submit"]') : null;
      if (!target) return;
      var isSubmit =
        target.type === 'submit' || /submit|send|subscribe|sign ?up/i.test(target.textContent || target.value || '');
      if (isSubmit) report(target.closest('form') || document);
    },
    true,
  );
})();
