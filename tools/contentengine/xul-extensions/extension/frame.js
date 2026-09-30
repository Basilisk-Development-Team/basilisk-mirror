/* Unmodified frame-script APIs shared by Gecko and WebKit. */
(function(scope) {
  const {Services}=Components.utils.import('resource://gre/modules/Services.jsm',null);
  const Ci=Components.interfaces,Cu=Components.utils;
  const sheet='data:text/css,'+encodeURIComponent('#target { background-color: rgb(51, 67, 83) !important; }');
  const utils=()=>scope.content.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDOMWindowUtils);
  scope.addMessageListener('xul-fixture:reply',message=> {
    if(scope.content.document.body)scope.content.document.body.dataset.extensionReply=message.data.value;
  });
  const observer={observe(document) {
    if(document.defaultView!==scope.content)return;
    const ready=()=> {
      if(!document.body)return;
      document.body.dataset.extensionScript='executed';
      document.body.dataset.versionComparison=JSON.stringify([
        Services.vc.compare('1.0pre','1.0'),Services.vc.compare('1.0+','1.1pre'),
        Services.vc.compare('1.*','1.999'),Services.vc.compare('1.0','1.0.0')]);
      const sandbox=new Cu.Sandbox(scope.content,{sandboxPrototype:scope.content,wantComponents:false});
      Cu.evalInSandbox("var fixtureUserscriptSecret='isolated'; document.body.dataset.userscript='executed';",sandbox);
      utils().loadSheetUsingURIString(sheet,Ci.nsIDOMWindowUtils.USER_SHEET);
      const target=document.getElementById('target');
      if(target)target.textContent='Changed by unchanged extension';
      scope.sendAsyncMessage('xul-fixture:ready',{url:document.URL});
    };
    if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready,{once:true});
    else ready();
  }};
  Services.obs.addObserver(observer,'document-element-inserted',false);
  scope.addMessageListener('xul-fixture:shutdown',()=> {
    Services.obs.removeObserver(observer,'document-element-inserted');
    utils().removeSheetUsingURIString(sheet,Ci.nsIDOMWindowUtils.USER_SHEET);
    if(scope.content.document.body) {
      delete scope.content.document.body.dataset.extensionScript;
      delete scope.content.document.body.dataset.extensionReply;
    }
  });
})(this);
