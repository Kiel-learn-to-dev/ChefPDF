// Fallback page script (no build step). Uses only window.chef.
(function () {
  const chef = window.chef;
  const $ = (id) => document.getElementById(id);
  const statusText = {
    starting: 'Đang khởi động',
    ready: 'Sẵn sàng',
    crashed: 'Bị lỗi',
    restarting: 'Đang khởi động lại',
  };

  function logEvent(text) {
    const li = document.createElement('li');
    li.textContent = text;
    $('events').prepend(li);
  }

  async function ping() {
    $('ping').textContent = '…';
    try {
      const res = await chef.rpc('system.ping', {});
      $('ping').textContent = JSON.stringify(res);
    } catch (err) {
      $('ping').textContent = 'Lỗi: ' + (err && err.message ? err.message : String(err));
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!chef) {
      $('version').textContent = 'window.chef không khả dụng';
      return;
    }
    $('version').textContent = chef.app.version;
    $('platform').textContent = chef.app.platform;
    chef.onEvent((event) => {
      if (event.type === 'core-status') {
        $('core-status').textContent = statusText[event.status] || event.status;
      }
      logEvent(JSON.stringify(event));
    });
    $('ping-btn').addEventListener('click', ping);
    $('open-btn').addEventListener('click', async () => {
      const paths = await chef.files.openDialog({ multiple: true });
      if (paths.length) logEvent('openDialog: ' + JSON.stringify(paths));
    });
    chef.app.initialFiles().then((files) => {
      if (files.length) logEvent('initialFiles: ' + JSON.stringify(files));
    });
    ping();
  });
})();
