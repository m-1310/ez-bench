'use strict';

window.installSnippets = function ({ api, editor, isPrivate, dialect, addTab, changed, busy, toast }) {
  const $ = selector => document.querySelector(selector);
  const dialog = $('#snippets-dialog');
  let entries = [], selected = null, saving = false;
  function error(message = '') { $('#snippet-error').textContent = message; }
  function render() {
    const search = $('#snippet-search').value.toLowerCase(), type = $('#snippet-filter').value;
    const list = $('#snippet-list'); list.replaceChildren();
    const matches = entries.filter(entry => (!type || entry.dialect === type || entry.dialect === 'any') && (entry.title + '\n' + entry.sql).toLowerCase().includes(search));
    for (const entry of matches) {
      const button = document.createElement('button'); button.className = 'snippet-item' + (entry.id === selected ? ' active' : '');
      const title = document.createElement('strong'); title.textContent = entry.title;
      const meta = document.createElement('span'); meta.textContent = (entry.dialect === 'any' ? 'Any dialect' : entry.dialect) + ' · ' + entry.sql.split('\n')[0].slice(0, 80);
      button.append(title, meta); button.addEventListener('click', () => choose(entry)); list.append(button);
    }
    if (!matches.length) { const empty = document.createElement('p'); empty.className = 'subtle'; empty.textContent = 'No matching snippets.'; list.append(empty); }
    $('#snippet-count').textContent = entries.length + '/100 saved';
  }
  function choose(entry) {
    if (saving) return;
    selected = entry?.id || null; $('#snippet-title').value = entry?.title || ''; $('#snippet-sql').value = entry?.sql || ''; $('#snippet-dialect').value = entry?.dialect || dialect();
    $('#snippet-delete').disabled = !selected; error(); render();
  }
  async function open(fromEditor = false) {
    error(); $('#snippet-search').value = ''; $('#snippet-filter').value = '';
    const data = await api.snippets(); entries = data.entries; choose(null);
    if (fromEditor) {
      if (isPrivate()) { toast('Private SQL cannot be saved to snippets.'); return; }
      const text = editor(); $('#snippet-sql').value = text.value.slice(text.selectionStart, text.selectionEnd) || text.value;
      $('#snippet-title').value = 'New snippet';
    } else if (entries.length) choose(entries[0]);
    if (data.warning) error(data.warning);
    if (!dialog.open) dialog.showModal();
    $('#snippet-title').focus();
  }
  function safeOpen(fromEditor) { open(fromEditor).catch(failure => toast(failure.message)); }
  $('#open-snippets').onclick = () => safeOpen(false);
  $('#save-snippet').onclick = () => safeOpen(true);
  $('#snippet-new').onclick = () => { if (!saving) { choose(null); $('#snippet-title').focus(); } };
  $('#snippet-close').onclick = () => { if (!saving) dialog.close(); };
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  $('#snippet-search').oninput = render; $('#snippet-filter').onchange = render;
  $('#snippet-form').onsubmit = async event => {
    event.preventDefault(); if (saving || !$('#snippet-form').reportValidity()) return;
    saving = true; $('#snippet-save').disabled = true; error();
    try {
      const entry = await api.saveSnippet({ id: selected || undefined, title: $('#snippet-title').value, sql: $('#snippet-sql').value, dialect: $('#snippet-dialect').value, private: isPrivate() });
      entries = (await api.snippets()).entries; saving = false; choose(entry); toast('Snippet saved locally.');
    } catch (failure) { error(failure.message); }
    finally { saving = false; $('#snippet-save').disabled = false; }
  };
  $('#snippet-delete').onclick = async () => {
    if (!selected || saving) return; saving = true; error();
    try { if (await api.removeSnippet(selected)) { entries = (await api.snippets()).entries; saving = false; choose(entries[0]); } }
    catch (failure) { error(failure.message); } finally { saving = false; }
  };
  $('#snippet-open').onclick = () => {
    if (saving || busy()) return error('Finish the running database operation first.');
    const sql = $('#snippet-sql').value; if (!sql.trim()) return error('Enter or select SQL first.');
    if (addTab(sql, $('#snippet-title').value || 'Snippet', { privateQuery: isPrivate() }) !== false) dialog.close();
  };
  $('#snippet-insert').onclick = () => {
    if (saving || busy()) return error('Finish the running database operation first.');
    const text = editor(), sql = $('#snippet-sql').value;
    if (!sql.trim()) return error('Enter or select SQL first.');
    if (text.value.length - (text.selectionEnd - text.selectionStart) + sql.length > 1000000) return error('Keep the SQL editor below 1 MB.');
    text.setRangeText(sql, text.selectionStart, text.selectionEnd, 'end'); changed(); dialog.close(); text.focus();
  };
};
