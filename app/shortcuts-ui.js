'use strict';
window.BenchShortcuts = (() => {
  const dialog = document.getElementById('shortcuts-dialog');
  const search = document.getElementById('shortcut-search');
  const list = document.getElementById('shortcut-list');
  const count = document.getElementById('shortcut-count');
  let returnFocus;
  const entries = BenchCommands.all.filter(command => command.accelerator);
  const keys = command => command.accelerator.replace(/CmdOrCtrl/g, 'Ctrl').replace(/Plus/g, '+');
  for (const command of entries) {
    const button = document.getElementById(command.id);
    if (button && button.closest('#workspace-settings')) {
      button.title = command.label + ' · ' + keys(command);
      if (!button.querySelector('kbd')) { const hint = document.createElement('kbd'); hint.textContent = keys(command); button.append(hint); }
    }
  }
  document.getElementById('workspace-menu').title = 'Settings · Ctrl+,';
  function render() {
    const query = search.value.trim().toLowerCase();
    const matches = entries.filter(command => [command.label, command.group, command.note, keys(command)].join(' ').toLowerCase().includes(query));
    list.replaceChildren();
    for (const group of [...new Set(matches.map(command => command.group))]) {
      const section = document.createElement('section');
      const heading = document.createElement('h3'); heading.textContent = group; section.append(heading);
      const definitions = document.createElement('dl');
      for (const command of matches.filter(command => command.group === group)) {
        const row = document.createElement('div'); row.className = 'shortcut-row';
        const description = document.createElement('dt'); description.textContent = command.label.replace(/…$/, '');
        if (command.note) { const note = document.createElement('small'); note.textContent = command.note; description.append(note); }
        const value = document.createElement('dd'); const key = document.createElement('kbd'); key.textContent = keys(command); value.append(key);
        row.append(description, value); definitions.append(row);
      }
      section.append(definitions); list.append(section);
    }
    count.textContent = matches.length ? matches.length + ' shortcuts' : 'No shortcuts match. Try an action or key, such as Ctrl.';
    list.scrollTop = 0;
  }
  function open() {
    if (dialog.open || document.querySelector('dialog[open]')) return;
    const active = document.activeElement;
    returnFocus = active && active.getClientRects().length ? active : document.getElementById('workspace-menu');
    BenchWorkspaceMenu.hide(); search.value = ''; render(); dialog.showModal(); list.scrollTop = 0; search.focus();
  }
  document.getElementById('shortcuts').addEventListener('click', open);
  document.getElementById('shortcut-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => {
    const target = returnFocus?.isConnected && returnFocus.getClientRects().length ? returnFocus : document.getElementById('workspace-menu');
    target.focus();
  });
  search.addEventListener('input', render);
  return { open };
})();
