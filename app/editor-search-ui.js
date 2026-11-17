'use strict';
window.installSearch = function ({ editor, changed, busy }) {
  const $ = selector => document.querySelector(selector);
  const dialog = $('#find-dialog');
  function message(value) { $('#find-message').textContent = value; }
  function next() {
    if (!$('#find-text').value) return message('Enter find text.');
    const text = editor();
    try {
      const found = BenchSearch.nextMatch(text.value, $('#find-text').value, text.selectionEnd, $('#find-case').checked), match = found.match;
      if (!match) return message('No match found.');
      text.setSelectionRange(match.start, match.end); message(found.ordinal + ' of ' + found.count + ' matches');
      // Keep the dialog open so Replace operates on this exact match.
      text.dispatchEvent(new Event('click'));
    } catch (error) { message(error.message); }
  }
  function replace(all) {
    if (busy()) return message('Finish the running database operation first.');
    const text = editor();
    try {
      if (all) {
        const output = BenchSearch.replaceAll(text.value, $('#find-text').value, $('#replace-text').value, $('#find-case').checked);
        if (output.count) { text.setRangeText(output.value, 0, text.value.length, 'start'); changed(); }
        message(output.count + ' replacement' + (output.count === 1 ? '' : 's') + '.');
      } else {
        const selected = BenchSearch.nextMatch(text.value, $('#find-text').value, text.selectionStart, $('#find-case').checked).match;
        if (!selected || selected.start !== text.selectionStart || selected.end !== text.selectionEnd) return next();
        const replacement = $('#replace-text').value;
        if (text.value.length - (selected.end - selected.start) + replacement.length > 1000000) throw new Error('Replacement would exceed the 1 MB editor limit.');
        text.setRangeText(replacement, selected.start, selected.end, 'end'); changed(); next();
      }
    } catch (error) { message(error.message); }
  }
  $('#find-next').onclick = event => { event.preventDefault(); next(); };
  $('#find-close').onclick = () => { dialog.close(); editor().focus(); };
  $('#replace-one').onclick = () => replace(false); $('#replace-all').onclick = () => replace(true);
  $('#find-form').onsubmit = event => { event.preventDefault(); next(); };
  $('#find-text').oninput = () => { try { message($('#find-text').value ? BenchSearch.nextMatch(editor().value, $('#find-text').value, 0, $('#find-case').checked).count + ' matches' : 'Literal text search'); } catch (error) { message(error.message); } };
  $('#find-case').onchange = () => $('#find-text').dispatchEvent(new Event('input'));
};
