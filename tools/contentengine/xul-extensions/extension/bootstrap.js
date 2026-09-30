/* Test extension uses ordinary Gecko APIs only. */
var {utils:Cu,interfaces:Ci,classes:Cc,results:Cr}=Components;
Cu.import('resource://gre/modules/Services.jsm');
var script,style,seen=[],timers=[],held=[];
var listener={receiveMessage(message) {
  seen.push({name:message.name,data:message.data});
  message.target.messageManager.sendAsyncMessage('xul-fixture:reply',{value:'parent reply'});
}};
var observer={observe(subject,topic) {
  if(topic==='browser-delayed-startup-finished') {
    subject.xulFixture={seen,held,loadLate(){Services.mm.loadFrameScript(script.replace('frame.js','late.js'),false);}};
    return;
  }
  var channel=subject.QueryInterface(Ci.nsIHttpChannel);
  if(channel.URI.spec.endsWith('/headers')) {
    if(topic==='http-on-examine-response')channel.setResponseHeader('X-Response-Extension','yes',false);
    else {channel.setRequestHeader('X-Extension','unchanged',false);channel.setRequestHeader('X-Remove-Me','',false);}
    return;
  }
  if(topic!=='http-on-modify-request')return;
  if(channel.URI.spec.endsWith('/echo-body')) {channel.suspend();held.push(channel);return;}
  if(!channel.URI.spec.includes('/deny/'))return;
  if(channel.URI.spec.includes('/fetch?')) {
    channel.suspend();
    var timer=Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);timers.push(timer);
    timer.initWithCallback(()=>{channel.cancel(Cr.NS_BINDING_ABORTED);channel.resume();},150,Ci.nsITimer.TYPE_ONE_SHOT);
  } else channel.cancel(Cr.NS_BINDING_ABORTED);
}};
function startup(data) {
  script=data.resourceURI.resolve('frame.js');
  Services.mm.addMessageListener('xul-fixture:ready',listener);
  Services.mm.loadFrameScript(script,true);
  Services.obs.addObserver(observer,'http-on-modify-request',false);
  Services.obs.addObserver(observer,'http-on-examine-response',false);
  Services.obs.addObserver(observer,'browser-delayed-startup-finished',false);
  style=Services.io.newURI('data:text/css,'+encodeURIComponent('#target { color: rgb(17, 33, 49) !important; }'),null,null);
  Cc['@mozilla.org/content/style-sheet-service;1'].getService(Ci.nsIStyleSheetService).loadAndRegisterSheet(style,Ci.nsIStyleSheetService.USER_SHEET);
}
function shutdown() {
  Services.mm.broadcastAsyncMessage('xul-fixture:shutdown',{});
  Services.mm.removeDelayedFrameScript(script);
  Services.mm.removeMessageListener('xul-fixture:ready',listener);
  Services.obs.removeObserver(observer,'http-on-modify-request');
  Services.obs.removeObserver(observer,'http-on-examine-response');
  Services.obs.removeObserver(observer,'browser-delayed-startup-finished');
  Cc['@mozilla.org/content/style-sheet-service;1'].getService(Ci.nsIStyleSheetService).unregisterSheet(style,Ci.nsIStyleSheetService.USER_SHEET);
  for(var timer of timers)timer.cancel();
  for(var channel of held)if(channel.isPending())channel.cancel(Cr.NS_BINDING_ABORTED);
}
function install() {}
function uninstall() {}
