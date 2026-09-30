/* MPL 2.0 */
Components.utils.import('resource://gre/modules/Services.jsm');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function check(value,label){if(!value)throw Error(label);}
async function waitFor(test,label){for(let n=0;n<300;n++){if(await test())return;await delay(100);}throw Error(label);}
window.addEventListener('load',()=>run().then(()=>finish(),finish));
function finish(error){dump('CONTENT-TEST '+(error?'FAIL '+error+'\n'+error.stack:'PASS all')+'\n');Services.startup.quit(Components.interfaces.nsIAppStartup.eForceQuit);}
async function run(){
 Services.console.registerListener({observe(message){dump('XUL-CONSOLE '+message.message+'\n');}});
 const base='http://127.0.0.1:'+Services.prefs.getIntPref('content.test.port');
 const win=window.openDialog('chrome://browser/content/browser.xul','_blank','chrome,all,dialog=no','about:blank');
 await waitFor(()=>win.xulFixture,'extension startup');
 const tab=win.ContentEngines.open(base+'/matrix?run=xul');
 const browser=tab.linkedBrowser;
 check(browser.messageManager===browser.frameLoader.messageManager,'frame-loader extension sender');

 try {await waitFor(()=>browser.contentTitle==='Matrix ready'&&!tab.hasAttribute('busy'),'matrix completion');}
 catch(error){const native=win.ContentEngines.get(browser).native;dump('XUL-VIEW '+JSON.stringify({uri:native.currentURI,error:native.lastError,loading:native.loading})+'\n');throw error;}
 await waitFor(()=>browser.contentAPI.executeScript("return document.body.dataset.extensionReply==='parent reply'"),'frame message round trip');
 const result=await browser.contentAPI.executeScript("return {script:document.body.dataset.extensionScript,text:document.getElementById('target').textContent,color:getComputedStyle(document.getElementById('target')).color,privileged:typeof Components}");
 check(result.script==='executed'&&result.text==='Changed by unchanged extension','unchanged frame script DOM modifications');
 check(result.color==='rgb(17, 33, 49)','registered user stylesheet');
 check(result.privileged==='undefined','privileged capability leaked to page');
 const comparisons=JSON.parse(await browser.contentAPI.executeScript('return document.body.dataset.versionComparison'));
 check(comparisons[0]<0&&comparisons[1]===0&&comparisons[2]>0&&comparisons[3]===0,'native extension version comparisons');
 const userScript=await browser.contentAPI.executeScript("return {ran:document.body.dataset.userscript,secret:typeof fixtureUserscriptSecret,background:getComputedStyle(document.getElementById('target')).backgroundColor}");
 check(userScript.ran==='executed'&&userScript.secret==='undefined','isolated userscript DOM access');
 check(userScript.background==='rgb(51, 67, 83)','document user stylesheet');
 const headers=await browser.contentAPI.executeScript("const response=await fetch('/headers',{headers:{'X-Remove-Me':'remove'}});return {headers:await response.json(),response:response.headers.get('X-Response-Extension'),ua:navigator.userAgent}");
 const normalized={};for(const name of Object.keys(headers.headers))normalized[name.toLowerCase()]=headers.headers[name];
 check(normalized['x-extension']==='unchanged'&&!('x-remove-me' in normalized),'request header modification/removal');
 check(headers.response==='yes','response header modification');
 check(normalized['user-agent']===headers.ua,'Gecko default headers leaked into WebKit');
 const counts=JSON.parse(await browser.contentAPI.executeScript("return await (await fetch('/counts')).text()"));
 check(!Object.keys(counts).some(path=>path.startsWith('/deny/')),'blocked request reached server');
 check(counts['/allow/fetch?run=xul']&&counts['/allow/socket?run=xul'],'allowed controls');
 const post=browser.contentAPI.executeScript("return await (await fetch('/echo-body',{method:'POST',body:'unchanged body \\u03bb'})).text()");
 await waitFor(()=>win.xulFixture.held.length===1,'suspended POST');
 const heldCounts=JSON.parse(await browser.contentAPI.executeScript("return await (await fetch('/counts')).text()"));
 check(!heldCounts['/echo-body'],'suspended POST reached server');
 win.xulFixture.held[0].resume();
 check(await post==='unchanged body \u03bb','resumed POST body changed');
 win.xulFixture.loadLate();
 await waitFor(()=>browser.contentAPI.executeScript("return document.body.dataset.lateExtensionScript==='executed'"),'live non-delayed frame script');
 const {TabStateFlusher}=Components.utils.import('resource:///modules/sessionstore/TabStateFlusher.jsm',{});
 let flushed=false;TabStateFlusher.flush(browser).then(()=>{flushed=true;});
 await waitFor(()=>flushed,'SessionStore flush through backing native frame loader');
 const {AddonManager}=Components.utils.import('resource://gre/modules/AddonManager.jsm',{});
 const addon=await new Promise(resolve=>AddonManager.getAddonByID('xul-extension-test@basilisk-browser.org',resolve));
 addon.userDisabled=true;
 await waitFor(()=>browser.contentAPI.executeScript("return !document.body.dataset.extensionScript && getComputedStyle(document.getElementById('target')).color!=='rgb(17, 33, 49)'"),'extension shutdown broadcast and stylesheet removal');
 check(await browser.contentAPI.executeScript("return getComputedStyle(document.getElementById('target')).backgroundColor!=='rgb(51, 67, 83)'"),'document user stylesheet removal');
 win.gBrowser.removeTab(tab);win.close();
}
