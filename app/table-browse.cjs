'use strict';

const OPERATORS = Object.freeze({ eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', contains: 'LIKE', starts: 'LIKE', isnull: 'IS NULL', notnull: 'IS NOT NULL' });

function compileBrowse(input, columns, mode, quote, placeholder) {
  if (input == null) input = {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Choose valid table filter options.');
  const find = name => {
    const column = columns.find(column => column.name === name);
    if (!column) throw new Error('Choose an existing table column.');
    return column;
  };
  const parameters = [], browse = {};
  let where = '', order = '';
  if (input.filter != null) {
    const filter = input.filter;
    if (typeof filter !== 'object' || Array.isArray(filter)) throw new Error('Choose a valid column filter.');
    const column = find(filter.column), op = OPERATORS[filter.operator];
    if (!op) throw new Error('Choose a supported filter comparison.');
    const name = quote(column.name, mode);
    browse.filter = { column: column.name, operator: filter.operator };
    if (['isnull', 'notnull'].includes(filter.operator)) where = ` WHERE ${name} ${op}`;
    else {
      if (!['integer', 'number', 'boolean', 'text', 'date'].includes(column.valueType)) throw new Error('Filter this column using SQL. This type is not supported by the table filter.');
      if (typeof filter.value !== 'string' || filter.value.length > 4096 || filter.value.includes('\0')) throw new Error('Enter a filter value up to 4,096 characters.');
      let value = filter.value;
      if (['contains', 'starts'].includes(filter.operator)) {
        if (column.valueType !== 'text') throw new Error('Contains and starts with require a text column.');
        // Treat wildcard characters literally. SQL Server also recognizes [.
        value = value.replace(/[!%_\[]/g, '!$&');
        value = (filter.operator === 'contains' ? '%' : '') + value + '%';
      } else if (column.valueType === 'integer') {
        if (!/^[+-]?\d+$/.test(value)) throw new Error('Enter a whole number for this filter.');
      } else if (column.valueType === 'number') {
        if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value))) throw new Error('Enter a finite number for this filter.');
      } else if (column.valueType === 'boolean') {
        if (!/^(true|false|1|0)$/i.test(value)) throw new Error('Enter true or false for this filter.');
        value = /^(true|1)$/i.test(value);
        if (mode === 'sqlite' || mode === 'demo') value = Number(value);
      }
      parameters.push(value);
      browse.filter.value = filter.value;
      where = ` WHERE ${name} ${op} ${placeholder(mode, 1)}` + (['contains', 'starts'].includes(filter.operator) ? " ESCAPE '!'" : '');
    }
  }
  const orderColumns = [];
  if (input.order != null) {
    if (typeof input.order !== 'object' || Array.isArray(input.order)) throw new Error('Choose valid table sort options.');
    const column = find(input.order.column);
    if (!['text', 'integer', 'number', 'boolean', 'date'].includes(column.valueType)) throw new Error('Sort this column using SQL. This type is not supported by the table sort.');
    if (!['asc', 'desc'].includes(input.order.direction)) throw new Error('Choose ascending or descending order.');
    browse.order = { column: column.name, direction: input.order.direction };
    orderColumns.push(quote(column.name, mode) + ' ' + input.order.direction.toUpperCase());
  }
  // A usable primary key breaks ties across pages. No-key tables remain best-effort.
  for (const key of columns.filter(column => column.primaryKey)) if (key.name !== browse.order?.column) orderColumns.push(quote(key.name, mode) + ' ASC');
  if (orderColumns.length) order = ' ORDER BY ' + orderColumns.join(', ');
  return { where, order, parameters, browse };
}

module.exports = { compileBrowse, OPERATORS };
