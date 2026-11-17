'use strict';
// UI test helper: use the same Settings path available to a person.
async function workspaceAction(page,id){
  const action=page.locator('#'+id);
  if(!await action.isVisible())await page.locator('#workspace-menu').click();
  await action.click();
}
module.exports={workspaceAction};
