'use strict';
window.BenchWorkspaceMenu=(()=>{
  const menu=document.getElementById('workspace-settings');
  function hide(){if(menu.matches(':popover-open'))menu.hidePopover();}
  // Dismiss before the command opens a native picker or another dialog.
  menu.addEventListener('click',event=>{if(event.target.closest('button'))hide();},true);
  return{hide};
})();
