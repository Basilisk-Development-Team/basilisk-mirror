/* MPL 2.0. Test instrumentation only; never packaged in production. */
Components.utils.import('resource://gre/modules/Services.jsm');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(test,label) {for(let n=0;n<300;n++){if(await test())return;await delay(100);}throw Error(label);}
function check(value,label){if(!value)throw Error(label);}
function finish(error){dump('CONTENT-TEST '+(error?'FAIL '+error+'\n'+error.stack:'PASS all')+'\n');Services.startup.quit(Components.interfaces.nsIAppStartup.eForceQuit);}
window.addEventListener('load',()=>run().then(()=>finish(),finish));
async function run() {
 Services.console.registerListener({observe(message){if(message instanceof Components.interfaces.nsIScriptError)dump('GM-CONSOLE '+message.message+'\n');}});
 const base='http://127.0.0.1:'+Services.prefs.getIntPref('content.test.port');
 const win=window.openDialog('chrome://browser/content/browser.xul','_blank','chrome,all,dialog=no','about:blank');
 await waitFor(()=>win.gBrowserInit&&win.gBrowserInit.delayedStartupFinished,'browser startup');
 const {GM_util}=Components.utils.import('chrome://greasemonkey-modules/content/util.js',{});
 const {parse}=Components.utils.import('chrome://greasemonkey-modules/content/parseScript.js',{});
 const {RemoteScript}=Components.utils.import('chrome://greasemonkey-modules/content/remoteScript.js',{});
 const source=['// ==UserScript==','// @name Basilisk compatibility audit','// @namespace basilisk-test',
 '// @include http://127.0.0.1:*/frames*','// @include http://*/child*','// @run-at document-end',
 '// @require '+base+'/gm-helper.js','// @resource audit '+base+'/gm-resource.txt',
 '// @grant GM_setValue','// @grant GM_getValue','// @grant GM_addStyle','// @grant GM_xmlhttpRequest',
 '// @grant GM_getResourceText','// @grant GM_registerMenuCommand','// ==/UserScript==',
 "try { GM_setValue('test-value','stored'); document.body.dataset.gmValue=GM_getValue('test-value');",
 "GM_addStyle('#target { color: rgb(31, 47, 63) !important; }');",
 "document.getElementById('target').textContent='Greasemonkey changed the DOM';",
 "document.body.dataset.gmResource=GM_getResourceText('audit'); document.body.dataset.gmRequired=gmRequired;",
 "document.body.dataset.gmUnsafe=unsafeWindow.pageFixtureValue;",
 "try { Components.classes['@mozilla.org/preferences-service;1'].getService(Components.interfaces.nsIPrefService); document.body.dataset.gmNativeAccess='allowed'; } catch(ignore) { document.body.dataset.gmNativeAccess='blocked'; }",
 "if(window===window.top) { const probe=function(){try { const child=window.frames[1].document; if(child && child.URL==='about:blank'){setTimeout(probe,25);return;} document.body.dataset.gmSandboxSOP='allowed'; } catch(ignore) { document.body.dataset.gmSandboxSOP='blocked'; }}; probe(); }",
 "GM_registerMenuCommand('Audit command',function(){document.body.dataset.gmMenu='invoked';});",
 "GM_xmlhttpRequest({method:'POST',url:"+JSON.stringify(base.replace('127.0.0.1','localhost')+'/echo-body')+",data:'gm request',onload:function(response){document.body.dataset.gmRequest=response.status+':'+response.responseText;},onerror:function(){document.body.dataset.gmError='request failed';}});",
 "document.body.dataset.gmRan='yes'; } catch(error) { document.body.dataset.gmError=String(error)+' '+error.stack; throw error; }"].join('\n');
 async function install(source) {
  const remote=new RemoteScript(),script=parse(source),temp=GM_util.getTempFile(remote._tempDir,'audit.user.js');
  await new Promise(resolve=>GM_util.writeToFile(source,temp,resolve));remote.setScript(script,temp);
  check(await new Promise(resolve=>remote.download(resolve)),'userscript dependencies');remote.install();return script;
 }
 await install(source);
 for(const phase of ['start','idle'])await install(['// ==UserScript==','// @name Audit '+phase,
  '// @namespace basilisk-test','// @include http://127.0.0.1:*/frames*','// @include http://*/child*',
  '// @run-at document-'+phase,'// @grant none','// ==/UserScript==',
  phase==='start'?"document.documentElement.dataset.gmStart=document.readyState;":"document.body.dataset.gmIdle='yes';"].join('\n'));
 await install(['// ==UserScript==','// @name Audit noframes','// @namespace basilisk-test',
  '// @include http://127.0.0.1:*/frames*','// @include http://*/child*','// @noframes',
  '// @run-at document-end','// @grant none','// ==/UserScript==',"document.body.dataset.gmNoFrames='top';"].join('\n'));
 for(const engine of ['gecko','webkit']) {
  const tab=engine==='gecko'?win.gBrowser.addTab(base+'/frames?engine='+engine):win.ContentEngines.open(base+'/frames?engine='+engine);
  win.gBrowser.selectedTab=tab;
  await waitFor(()=>tab.linkedBrowser.contentTitle==='Content fixture'&&!tab.hasAttribute('busy'),engine+' page');
  await waitFor(async()=> {
    const status=await tab.linkedBrowser.contentAPI.executeScript('return {ran:document.body.dataset.gmRan,error:document.body.dataset.gmError}');
    if(status.error)throw Error(engine+' userscript: '+status.error);return status.ran==='yes';
  },engine+' Greasemonkey execution');
  const result=await tab.linkedBrowser.contentAPI.executeScript("return {value:document.body.dataset.gmValue,color:getComputedStyle(document.getElementById('target')).color,text:document.getElementById('target').textContent,privileged:typeof GM_setValue}");
  check(result.value==='stored'&&result.color==='rgb(31, 47, 63)'&&result.text==='Greasemonkey changed the DOM'&&result.privileged==='undefined',engine+' userscript APIs '+JSON.stringify(result));
  await waitFor(()=>tab.linkedBrowser.contentAPI.executeScript("return document.body.dataset.gmRequest==='200:gm request'"),engine+' cross-origin GM_xmlhttpRequest');
  const resources=await tab.linkedBrowser.contentAPI.executeScript('return {resource:document.body.dataset.gmResource,required:document.body.dataset.gmRequired}');
  check(resources.resource==='userscript resource'&&resources.required==='loaded',engine+' resources and requires');
  check(await tab.linkedBrowser.contentAPI.executeScript("return document.body.dataset.gmUnsafe==='page-defined'"),engine+' unsafeWindow page globals');
  await waitFor(()=>tab.linkedBrowser.contentAPI.executeScript('return !!document.body.dataset.gmSandboxSOP'),engine+' final-frame sandbox boundary');
  const boundary=await tab.linkedBrowser.contentAPI.executeScript('return {native:document.body.dataset.gmNativeAccess,sop:document.body.dataset.gmSandboxSOP}');
  check(boundary.native==='blocked'&&boundary.sop==='blocked',engine+' userscript privilege boundary '+JSON.stringify(boundary));
  check(await tab.linkedBrowser.contentAPI.executeScript("try { document.querySelectorAll('iframe')[1].contentWindow.document; return false; } catch(ignore) { return true; }"),engine+' page same-origin boundary');
  const frames=await tab.linkedBrowser.contentAPI.getFrames();
  check(frames.length===3,engine+' frame count');
  for(const frame of frames)await waitFor(()=>tab.linkedBrowser.contentAPI.executeScript("return document.body.dataset.gmRan==='yes' && document.body.dataset.gmRequest==='200:gm request'",{frameId:frame.frameId}),engine+' userscript in '+frame.documentURI);
  for(const frame of frames) {
   await waitFor(()=>tab.linkedBrowser.contentAPI.executeScript("return document.body.dataset.gmIdle==='yes'",{frameId:frame.frameId}),engine+' idle userscript');
   const timing=await tab.linkedBrowser.contentAPI.executeScript('return {start:document.body.dataset.gmStartBeforePage,noframes:document.body.dataset.gmNoFrames}',{frameId:frame.frameId});
   check(timing.start==='loading',engine+' document-start timing '+frame.documentURI);
   check(frame.isTopFrame?timing.noframes==='top':!timing.noframes,engine+' noframes matching');
  }
  const menu=win.document.querySelector('.greasemonkey-user-script-commands-popup');
  check(menu&&win.GM_MenuCommander,engine+' extension menu');
  const popup=menu.parentNode.parentNode;
  win.GM_showPopup({currentTarget:popup,target:popup});
  await waitFor(()=>Array.from(popup.querySelectorAll('menuitem')).filter(item=>item.script).length===4,engine+' matching-script UI through frameLoader.messageManager');
  await waitFor(()=>menu.children.length>0,engine+' menu command discovery');
  check(menu.children.length===1,engine+' duplicate frame menu commands');
  menu.firstChild.dispatchEvent(new win.Event('command'));
  await waitFor(()=>tab.linkedBrowser.contentAPI.executeScript("return document.body.dataset.gmMenu==='invoked'"),engine+' menu command invocation');
  win.GM_MenuCommander.onPopupHiding();
  dump('CONTENT-TEST PASS '+engine+' unchanged Greasemonkey DOM, styles, storage, cross-origin XHR, resources, unsafeWindow, frame timing, noframes, menu commands and isolation\n');
 }
}
