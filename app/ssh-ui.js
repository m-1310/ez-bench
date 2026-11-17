'use strict';
window.BenchSsh = (() => {
  const node=id=>document.getElementById(id);
  const form=()=>node('connection-form');
  const field=name=>form().elements[name];
  let verifiedHost=null,checking=false;
  function clearSecrets(){field('sshPassword').value='';field('sshPassphrase').value='';}
  function configure(){
    const local=field('mode').value==='sqlite',enabled=!local&&field('sshEnabled').checked,key=field('sshAuthMethod').value==='key';
    node('ssh-fields').hidden=!enabled;node('ssh-password-field').hidden=key;node('ssh-key-fields').hidden=!key;
    for(const name of ['sshHost','sshPort','sshUser'])field(name).required=enabled;
    field('sshKeyPath').required=enabled&&key;
    field('sshPassword').required=false;
    node('ssh-key-state').textContent=field('sshFingerprint').value?'Trusted · '+field('sshFingerprint').value:'Verify the server fingerprint before connecting.';
    node('ssh-key-state').classList.toggle('verified',Boolean(field('sshFingerprint').value));
  }
  function load(profile){
    const ssh=profile?.ssh;verifiedHost=null;clearSecrets();field('sshEnabled').checked=Boolean(ssh?.enabled);
    for(const [name,key,fallback]of [['sshHost','host',''],['sshPort','port',22],['sshUser','user',''],['sshAuthMethod','authMethod','password'],['sshKeyPath','privateKeyPath',''],['sshFingerprint','hostFingerprint','']])field(name).value=ssh?.[key]??fallback;
    configure();
  }
  function read(profile){
    const enabled=field('mode').value!=='sqlite'&&field('sshEnabled').checked;
    for(const key of Object.keys(profile))if(key.startsWith('ssh'))delete profile[key];
    if(enabled)profile.ssh={enabled:true,host:field('sshHost').value.trim(),port:Number(field('sshPort').value),user:field('sshUser').value.trim(),authMethod:field('sshAuthMethod').value,password:field('sshPassword').value,privateKeyPath:field('sshKeyPath').value.trim(),passphrase:field('sshPassphrase').value,hostFingerprint:field('sshFingerprint').value};
    return profile;
  }
  function invalidatePin(){field('sshFingerprint').value='';verifiedHost=null;configure();}
  async function verify(){
    if(checking)return;
    for(const name of ['sshHost','sshPort'])if(!field(name).reportValidity())return;
    checking=true;node('ssh-verify-host').disabled=true;node('connection-error').textContent='';node('ssh-key-state').textContent='Reading SSH host key…';
    const host=field('sshHost').value.trim(),port=Number(field('sshPort').value);
    try{
      const details=await api.sshFingerprint({ssh:{host,port}});
      if(!node('connection-dialog').open)return;
      if(field('sshHost').value.trim()!==host||Number(field('sshPort').value)!==port)throw new Error('SSH endpoint changed. Verify the new host.');
      verifiedHost={...details,host,port};
      node('ssh-hostkey-endpoint').textContent=`${host}:${port} · ${details.algorithm}`;
      node('ssh-hostkey-value').textContent=details.fingerprint;node('ssh-hostkey-error').textContent='';node('ssh-hostkey-dialog').showModal();
    }catch(error){node('connection-error').textContent=error.message;}
    finally{checking=false;node('ssh-verify-host').disabled=false;configure();}
  }
  function badge(profile){return profile?.ssh?.enabled?' · SSH':'';}
  document.addEventListener('DOMContentLoaded',()=>{
    node('ssh-enabled').addEventListener('change',configure);node('ssh-auth-method').addEventListener('change',()=>{clearSecrets();configure();});
    for(const name of ['sshHost','sshPort'])field(name).addEventListener('input',invalidatePin);
    node('ssh-verify-host').onclick=verify;
    node('ssh-hostkey-trust').onclick=()=>{
      if(!verifiedHost)return;
      if(field('sshHost').value.trim()!==verifiedHost.host||Number(field('sshPort').value)!==verifiedHost.port){node('ssh-hostkey-error').textContent='The endpoint changed. Close this dialog and verify it again.';return;}
      field('sshFingerprint').value=verifiedHost.fingerprint;configure();node('ssh-hostkey-dialog').close();
    };
    for(const id of ['ssh-hostkey-close','ssh-hostkey-cancel'])node(id).onclick=()=>node('ssh-hostkey-dialog').close();
    node('ssh-choose-key').onclick=async()=>{try{const file=await api.pickSshKey();if(file)field('sshKeyPath').value=file;}catch(error){node('connection-error').textContent=error.message;}};
    node('connection-dialog').addEventListener('close',clearSecrets);
  });
  return{configure,load,read,clearSecrets,badge};
})();
