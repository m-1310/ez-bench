'use strict';
// Database workers and native clients need platform paths, not unrelated API
// tokens or developer instrumentation inherited from the launching terminal.
const ALLOWED=new Set(['PATH','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMW6432','SYSTEMROOT','WINDIR','TEMP','TMP','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','COMSPEC','PATHEXT','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS']);
function childEnvironment(extra={},source=process.env){
  const output={};for(const[key,value]of Object.entries(source))if(ALLOWED.has(key.toUpperCase())&&typeof value==='string')output[key]=value;
  return {...output,...extra};
}
module.exports={childEnvironment};
