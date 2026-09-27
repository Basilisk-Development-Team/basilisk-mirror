/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
Components.utils.import('resource://gre/modules/Services.jsm');
function check(v,s){if(!v)throw Error(s);}
function delay(ms){return new Promise(r=>setTimeout(r,ms));}
async function waitFor(f,s){for(let i=0;i<300;i++){if(await f())return;await delay(100);}throw Error(s);}
window.addEventListener('load',()=>run().then(()=>finish(),finish));
function finish(e){dump('CONTENT-TEST '+(e?'FAIL '+e+'\n'+e.stack:'PASS all')+'\n');Services.startup.quit(Components.interfaces.nsIAppStartup.eForceQuit);}
async function run(){
 const port=Services.prefs.getIntPref('content.test.port'),base='http://127.0.0.1:'+port;
 let win=window.openDialog('chrome://browser/content/browser.xul','_blank','chrome,all,dialog=no','about:blank');
 await waitFor(()=>win.gBrowserInit&&win.gBrowserInit.delayedStartupFinished,'startup');
 let tab=win.ContentEngines.open('about:blank'),api=tab.linkedBrowser.contentAPI;
 const rules=[
  {urlPrefix:base+'/deny/script',resourceTypes:['script']},
  {urlPrefix:base+'/deny/image',resourceTypes:['image']},
  {urlPrefix:base+'/deny/style',resourceTypes:['stylesheet']},
  {urlPrefix:base+'/deny/frame',resourceTypes:['subdocument']},
  {urlPrefix:base+'/deny/fetch',resourceTypes:['fetch']},
  {urlPrefix:base+'/deny/xhr',resourceTypes:['fetch']},
  {urlPrefix:base+'/deny/redirect-target',resourceTypes:['fetch']},
  {urlPrefix:base+'/deny/post',resourceTypes:['fetch']},
  {urlPrefix:'ws://127.0.0.1:'+port+'/deny/socket',resourceTypes:['websocket']},
  {urlPrefix:'http://localhost:'+port+'/third/',party:'third-party',topURLPrefix:base+'/matrix'}
 ];
 let methodRejected=false;
 try {await api.setRequestRules('unsupported-method',[{urlPrefix:base,method:'POST'}]);}catch(_){methodRejected=true;}
 check(methodRejected,'method-dependent policy silently accepted despite upstream attribution bug');
 const start=Date.now();await api.setRequestRules('matrix',rules);dump('NETWORK policy compile/install ms '+(Date.now()-start)+'\n');
 async function counts(){return new Promise((resolve,reject)=>{let x=new XMLHttpRequest();x.open('GET',base+'/counts');x.onload=()=>resolve(JSON.parse(x.responseText));x.onerror=reject;x.send();});}
 async function load(run,blocked){
  tab.linkedBrowser.loadURI(base+'/matrix?run='+run);
  await waitFor(()=>tab.linkedBrowser.contentTitle=='Matrix ready'&&!tab.hasAttribute('busy'),'matrix load '+run);
  await delay(500);let requests=await counts();
  for(let path of ['script','image','style','frame','fetch','xhr','post','socket','redirect-target'])
   check((requests['/deny/'+path+'?run='+run]||0)==(blocked?0:1),'server saw wrong count '+run+' /deny/'+path+' '+JSON.stringify(requests));
  for(let path of ['script','image','style','frame','fetch','xhr','socket'])
   check(requests['/allow/'+path+'?run='+run]==1,'allowed resource missing '+path);
  check(requests['/deny/get?run='+run]==1,'unmatched GET blocked');
  for(let path of ['script','image','style','frame'])
   check((requests['/third/'+path+'?run='+run]||0)==(blocked?0:1),'party/top URL mismatch '+path);
  dump('NETWORK PASS server counters '+run+' blocked='+blocked+'\n');
 }
 await load('blocked',true);

 // One compiled pattern covers HTTP and WebSocket resources. A subsequent
 // policy-local exception restores the allowed control. Matching is explicitly
 // insensitive here; uppercase patterns must match lowercase request paths.
 const patterns=[
  {urlPattern:'/DENY/',caseSensitive:false},
  {urlPattern:'/deny/get[?]',action:'allow'},
  rules[rules.length-1]
 ];
 await api.setRequestRules('matrix',patterns);await load('patterns',true);
 // A broad allow in another owner's list cannot erase this policy's blocks.
 await api.setRequestRules('other-owner',[{urlPattern:'.*',action:'allow'}]);
 await load('owner-isolation',true);await api.removeRequestRules('other-owner');
 let invalid=false;
 try {await api.setRequestRules('matrix',[{urlPattern:'['}]);}catch(_){invalid=true;}
 check(invalid,'invalid pattern compilation succeeded');
 await load('failed-update-retains-policy',true);
 for(let rule of [{urlPattern:'.*',urlPrefix:base},{urlPattern:'x',action:'redirect'},
                   {urlPattern:'x\n'},{urlPattern:'x',caseSensitive:'false'}]) {
  let rejected=false;try {await api.setRequestRules('invalid',[rule]);}catch(_){rejected=true;}
  check(rejected,'invalid rule accepted '+JSON.stringify(rule));
 }
 await api.removeRequestRules('matrix');await load('disabled',false);
 await api.setRequestRules('matrix',rules);await load('reenabled',true);
 // A first-party constraint on another registrable domain must not match.
 await api.setRequestRules('matrix',rules.slice(0,-1).concat([{urlPrefix:'http://localhost:'+port+'/third/',party:'first-party'}]));
 tab.linkedBrowser.loadURI(base+'/matrix?run=party');
 await waitFor(()=>tab.linkedBrowser.contentTitle=='Matrix ready'&&!tab.hasAttribute('busy'),'party control');
 let requests=await counts();check(requests['/third/script?run=party']==1,'third party falsely classified first party');
 await api.setRequestRules('scoped',[{urlPrefix:base+'/scope/probe',resourceTypes:['fetch'],
   documentURLPattern:'^http://127[.]0[.]0[.]1:'+port+'/'}]);
 tab.linkedBrowser.loadURI(base+'/scoped-documents?phase=include');
 await waitFor(()=>tab.linkedBrowser.contentTitle=='Scoped documents'&&!tab.hasAttribute('busy'),'scoped documents');
 await delay(700);requests=await counts();
 check(!requests['/scope/probe?phase=include&from=127.0.0.1'],'matching document escaped scope');
 check(requests['/scope/probe?phase=include&from=localhost']==1,'top-page origin substituted for child document');
 await api.setRequestRules('scoped',[{urlPrefix:base+'/scope/probe',resourceTypes:['fetch'],
   documentURLPattern:'^http://127[.]0[.]0[.]1:'+port+'/',excludeDocumentURL:true}]);
 tab.linkedBrowser.loadURI(base+'/scoped-documents?phase=exclude');
 await waitFor(()=>tab.linkedBrowser.contentTitle=='Scoped documents'&&!tab.hasAttribute('busy'),'excluded documents');
 await delay(700);requests=await counts();
 check(requests['/scope/probe?phase=exclude&from=127.0.0.1']==1,'excluded document blocked');
 check(!requests['/scope/probe?phase=exclude&from=localhost'],'non-excluded document escaped block');
 await api.removeRequestRules('scoped');
 dump('NETWORK PASS requesting-document conditions distinguish mixed-origin frames\n');
 await api.setRequestRules('matrix',rules);
 await load('after-scope',true);
 await api.setRequestRules('matrix',rules);
 tab=win.ContentEngines.switchEngine(tab,'gecko');
 await waitFor(()=>tab.linkedBrowser.contentTitle=='Matrix ready'&&!tab.hasAttribute('busy'),'Gecko switch');
 await load('gecko-independent',false);
 tab=win.ContentEngines.switchEngine(tab,'webkit');
 await waitFor(()=>tab.linkedBrowser.contentTitle=='Matrix ready'&&!tab.hasAttribute('busy'),'WPE switch');
 await load('restored',true);
 dump('NETWORK PASS pre-fetch script/image/stylesheet/subframe/XHR/fetch/WebSocket/redirect blocking; party, unsupported-method rejection, toggle and independent Gecko\n');
}
