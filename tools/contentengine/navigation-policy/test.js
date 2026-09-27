/* Verify bounded document preparation, not a per-resource request broker. */
Components.utils.import('resource://gre/modules/Services.jsm');
const Ci=Components.interfaces;
function check(value,description){if(!value)throw Error(description);}
function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
async function waitFor(predicate,description){for(let i=0;i<400;i++){if(predicate())return;await delay(100);}throw Error(description);}
window.addEventListener('load',()=>run().then(()=>finish(),finish));
function finish(error){dump('CONTENT-TEST '+(error?'FAIL '+error+'\n'+error.stack:'PASS all')+'\n');Services.startup.quit(Ci.nsIAppStartup.eForceQuit);}
async function run(){
 const base='http://127.0.0.1:'+Services.prefs.getIntPref('content.test.port');
 const win=window.openDialog('chrome://browser/content/browser.xul','_blank','chrome,all,dialog=no','about:blank');
 await waitFor(()=>win.gBrowserInit&&win.gBrowserInit.delayedStartupFinished,'startup');
 const tab=win.ContentEngines.open('about:blank'),view=win.ContentEngines.get(tab.linkedBrowser),native=view.native;
 const original=view.onContentEvent,held=[];
 let terminated=false;
 view.onContentEvent=function(sender,topic,subject){
  if(topic==='content-view-process-terminated')terminated=true;
  if(topic==='content-view-navigation-prepare'){
   const info=subject.QueryInterface(Ci.nsIWritablePropertyBag2);
   info.setPropertyAsBool('deferred',true);
   held.push(info.getPropertyAsUint32('id'));return;
  }
  return original.call(this,sender,topic,subject);
 };
 async function counts(){return new Promise((resolve,reject)=>{const x=new XMLHttpRequest();x.open('GET',base+'/counts');x.onload=()=>resolve(JSON.parse(x.responseText));x.onerror=reject;x.send();});}
 async function hold(name){
  const length=held.length;
  tab.linkedBrowser.loadURI(base+'/matrix?run='+name);
  await waitFor(()=>held.length>length,'response decision '+name);
  await delay(300);
  const requests=await counts();
  check(requests['/matrix?run='+name]===1,'main response not received');
  check(!requests['/allow/script?run='+name],'document parsed before preparation '+name);
  return held[held.length-1];
 }
 function stale(id){let rejected=false;try{native.completeNavigationPreparation(id,true);}catch(e){rejected=e.result===Components.results.NS_ERROR_NOT_AVAILABLE;}check(rejected,'stale decision accepted '+id);}
 let id=await hold('prepare-allow');native.completeNavigationPreparation(id,true);
 await waitFor(()=>tab.linkedBrowser.contentTitle==='Matrix ready'&&!tab.hasAttribute('busy'),'allowed document');
 check((await counts())['/allow/script?run=prepare-allow']===1,'allowed document did not resume');stale(id);
 id=await hold('prepare-block');native.completeNavigationPreparation(id,false);stale(id);
 id=await hold('prepare-stop');native.stop();stale(id);
 id=await hold('prepare-replaced');const replacement=await hold('prepare-replacement');stale(id);
 native.completeNavigationPreparation(replacement,false);
 id=await hold('prepare-timeout');await delay(32000);stale(id);
 id=await hold('prepare-crash');dump('CONTENT-TEST KILL WebProcesses\n');
 await waitFor(()=>terminated,'process termination');stale(id);
 id=await hold('prepare-close');win.gBrowser.removeTab(tab);stale(id);
 const requests=await counts();
 for(const name of ['block','stop','replaced','replacement','timeout','crash','close'])
  check(!requests['/allow/script?run=prepare-'+name],'cancelled document fetched subresources '+name);
 dump('NAVIGATION-POLICY PASS deferred parsing, allow/block, stop, replacement, timeout, crash and tab destruction\n');
}
