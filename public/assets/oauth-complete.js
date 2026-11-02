// Runs in the OAuth popup: tell the dashboard (same origin) the result, then close.
(function () {
  var params = new URLSearchParams(location.search);
  var status = params.get('status') === 'success' ? 'success' : 'error';
  var message = params.get('message') || '';
  var el = document.getElementById('message');
  el.textContent =
    status === 'success' ? 'HubSpot connected. You can close this window.' : message || 'HubSpot connection failed.';
  if (status !== 'success') el.classList.add('error');
  if (window.opener) {
    window.opener.postMessage({ type: 'hubspot-oauth', status: status, message: message }, location.origin);
    setTimeout(function () {
      window.close();
    }, 1200);
  }
})();
