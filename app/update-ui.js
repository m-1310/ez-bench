'use strict';
window.installUpdates = function ({ api, canInstall, toast }) {
  const $ = selector => document.querySelector(selector);
  const dialog = $('#update-dialog');
  let timer = null;
  function render(state) {
    $('#update-current').textContent = 'Installed version ' + state.currentVersion + ' · Windows 10+ · x64';
    $('#update-message').textContent = state.message;
    $('#update-version').textContent = state.version ? 'Version ' + state.version + (state.bytes ? ' · ' + (state.bytes / 1024 / 1024).toFixed(1) + ' MiB' : '') : '';
    const working = ['checking', 'downloading'].includes(state.phase);
    const fromGit = state.phase === 'source';
    $('#update-git-guide').hidden = !fromGit;
    $('#update-package-note').hidden = fromGit;
    $('#update-check').hidden = fromGit;
    $('#update-check').disabled = fromGit || working || state.phase === 'disabled';
    $('#update-download').hidden = !['available', 'downloading'].includes(state.phase);
    $('#update-download').disabled = working;
    $('#update-install').hidden = state.phase !== 'ready';
    $('#update-reveal').hidden = state.phase !== 'ready';
    $('#update-cancel').hidden = !working;
    $('#update-progress').hidden = state.phase !== 'downloading';
    $('#update-progress').max = state.bytes || 1;
    $('#update-progress').value = state.downloaded || 0;
    if (!working && timer) { clearInterval(timer); timer = null; }
  }
  async function run(method) {
    $('#update-error').textContent = '';
    $('#update-check').disabled = true;
    $('#update-download').disabled = true;
    try {
      if (!timer) timer = setInterval(() => api.updateStatus().then(render).catch(() => {}), 300);
      render(await api[method]());
    } catch (error) { $('#update-error').textContent = error.message; render(await api.updateStatus()); }
    finally { if (timer) { clearInterval(timer); timer = null; } }
  }
  async function open() {
    $('#update-error').textContent = '';
    render(await api.updateStatus());
    if (!dialog.open) dialog.showModal();
    const state = await api.updateStatus();
    if (['checking', 'downloading'].includes(state.phase) && !timer) timer = setInterval(() => api.updateStatus().then(render).catch(() => {}), 300);
  }
  api.updateStatus().then(state => {
    document.querySelector('.brand .version').textContent = state.currentVersion;
    document.querySelector('.status-version').textContent = 'EZ Bench ' + state.currentVersion;
  }).catch(() => {});
  $('#check-updates').addEventListener('click', () => open().catch(error => toast(error.message)));
  $('#update-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { if (timer) { clearInterval(timer); timer = null; } });
  $('#update-git-guide').addEventListener('click', async () => {
    $('#update-error').textContent = '';
    try { await api.openGitUpdateGuide(); }
    catch (error) { $('#update-error').textContent = error.message; }
  });
  $('#update-check').addEventListener('click', () => run('checkUpdates'));
  $('#update-download').addEventListener('click', () => run('downloadUpdate'));
  $('#update-cancel').addEventListener('click', () => api.cancelUpdate().catch(error => toast(error.message)));
  $('#update-reveal').addEventListener('click', () => api.revealUpdate().catch(error => { $('#update-error').textContent = error.message; }));
  $('#update-install').addEventListener('click', async () => {
    $('#update-install').disabled = true;
    try {
      if (!await canInstall()) { $('#update-error').textContent = 'Finish running work, save SQL files, apply or discard table edits, and disconnect before installing.'; return; }
      await api.installUpdate();
    } catch (error) { $('#update-error').textContent = error.message; }
    finally { $('#update-install').disabled = false; }
  });
};
