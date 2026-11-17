'use strict';
window.BenchBrowse = (() => {
  const $ = id => document.getElementById(id);
  function update(data) {
    const enabled = Boolean(data?.table);
    $('table-browse-bar').hidden = !enabled;
    if (!enabled) return;
    $('table-browse-open').disabled = busy;
    const active = Boolean(data.browse?.filter || data.browse?.order);
    $('table-browse-reset').hidden = !active; $('table-browse-reset').disabled = busy;
    const filter = data.browse?.filter, order = data.browse?.order;
    $('table-browse-summary').textContent = [filter ? filter.column + ' · ' + ({ eq: 'equals', ne: 'not equal', gt: 'greater than', gte: 'at least', lt: 'less than', lte: 'at most', contains: 'contains', starts: 'starts with', isnull: 'is NULL', notnull: 'is not NULL' })[filter.operator] : 'All rows', order ? order.column + ' ' + order.direction.toUpperCase() : data.columns.some(column => column.primaryKey) ? 'Primary-key order' : 'Default order'].join(' · ');
    $('table-browse-summary').title = filter?.value === undefined ? '' : 'Filter value: ' + filter.value;
  }
  function option(select, value, text) { const element = document.createElement('option'); element.value = value; element.textContent = text; select.append(element); }
  function open() {
    if (busy || !result?.table) return;
    const filter = result.browse?.filter, order = result.browse?.order;
    $('browse-column').replaceChildren(); $('browse-sort').replaceChildren();
    option($('browse-column'), '', 'No column filter'); option($('browse-sort'), '', result.columns.some(column => column.primaryKey) ? 'Primary-key order' : 'Default order');
    for (const column of result.columns) {
      option($('browse-column'), column.name, column.name + ' · ' + column.type);
      if (['integer', 'number', 'boolean', 'text', 'date'].includes(column.valueType)) option($('browse-sort'), column.name, column.name);
    }
    $('browse-column').value = filter?.column || ''; $('browse-operator').value = filter?.operator || 'eq'; $('browse-value').value = filter?.value || '';
    $('browse-sort').value = order?.column || ''; $('browse-direction').value = order?.direction || 'asc';
    $('browse-error').textContent = ''; toggle(); $('browse-dialog').showModal();
  }
  function toggle() { $('browse-value').disabled = !$('browse-column').value || ['isnull', 'notnull'].includes($('browse-operator').value); $('browse-operator').disabled = !$('browse-column').value; $('browse-direction').disabled = !$('browse-sort').value; }
  document.addEventListener('DOMContentLoaded', () => {
    $('table-browse-open').onclick = open;
    $('table-browse-reset').onclick = () => { if (!busy && result?.table) BenchTables.load(result.schema, result.table, true, 0, {}); };
    for (const id of ['browse-column', 'browse-operator', 'browse-sort']) $(id).onchange = toggle;
    $('browse-close').onclick = () => $('browse-dialog').close();
    $('browse-form').onsubmit = async event => {
      event.preventDefault(); if (busy || !result?.table) return;
      const browse = {};
      if ($('browse-column').value) browse.filter = { column: $('browse-column').value, operator: $('browse-operator').value, value: $('browse-value').value };
      if ($('browse-sort').value) browse.order = { column: $('browse-sort').value, direction: $('browse-direction').value };
      const data = result; $('browse-dialog').close();
      if (!await BenchTables.load(data.schema, data.table, true, 0, browse)) toast('Table criteria were not applied. Existing results are kept. See the result status for details.');
    };
  });
  return { update, open };
})();
