/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

// Dispatch real privileged observers against native policy channels. No filter
// serialization, extension recognition, or access to extension-private state.
var ContentEngineRequests = {
  states: new WeakMap(),
  state(view) {
    let state=this.states.get(view);
    if (!state) {
      state={channels:new Map(),topFrame:""}; this.states.set(view,state);
    }
    return state;
  },
  clear(view) {
    const state=this.states.get(view);
    if (!state) return;
    for (const entry of state.channels.values()) entry.finish();
    state.channels.clear(); this.states.delete(view);
  },
  handle(view, info) {
    const request=JSON.parse(info.getPropertyAsAUTF8String("json"));
    const state=this.state(view);
    if (request.phase==="complete") {
      const old=state.channels.get(request.id);
      if (old) {old.finish();state.channels.delete(request.id);}
      info.setPropertyAsAUTF8String("reply",'{"allow":true}'); return;
    }
    if (!/^(?:https?|wss?):/i.test(request.url)) {
      info.setPropertyAsAUTF8String('reply','{"allow":true}');return;
    }
    if (request.mainFrame && request.mainResource) state.topFrame=request.frameId;
    const frame=id=>id===state.topFrame ? 0 : Number(id)||0;
    let entry=state.channels.get(request.id);
    if (!entry || request.phase==="request") {
      if (entry) {entry.finish();state.channels.delete(request.id);}
      const c=Ci.nsIContentPolicy;
      const types=[c.TYPE_OTHER,c.TYPE_BEACON,c.TYPE_CSP_REPORT,c.TYPE_SUBDOCUMENT,
        c.TYPE_XMLHTTPREQUEST,c.TYPE_FONT,c.TYPE_IMAGE,c.TYPE_MEDIA,c.TYPE_OBJECT,
        c.TYPE_OTHER,c.TYPE_PING,c.TYPE_SCRIPT,c.TYPE_STYLESHEET,c.TYPE_XMLHTTPREQUEST,c.TYPE_STYLESHEET];
      const type=request.type===15 ? c.TYPE_WEBSOCKET :
        request.mainFrame && request.mainResource ? c.TYPE_DOCUMENT : types[request.type]||c.TYPE_OTHER;
      // HTTP channel interfaces represent a WebSocket's HTTP handshake as well.
      const uri=Services.io.newURI(request.url.replace(/^ws(s?):/,'http$1:'),null,null);
      let principal;
      const attributes={userContextId:view.userContextId || 0,
        privateBrowsingId:PrivateBrowsingUtils.isWindowPrivate(view.browser.ownerDocument.defaultView) ? 1 : 0};
      try {
        principal=Services.scriptSecurityManager.createCodebasePrincipal(
          Services.io.newURI(request.sourceOrigin || request.documentURL || request.url,null,null),
          attributes);
      } catch(error) {principal=Services.scriptSecurityManager.createNullPrincipal(attributes);}
      const backing=Services.io.newChannelFromURI2(uri,null,principal,principal,
        Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_DATA_IS_NULL,type);
      if (request.originalURL) backing.originalURI=Services.io.newURI(request.originalURL,null,null);
      backing.notificationCallbacks={
        QueryInterface:XPCOMUtils.generateQI([Ci.nsIInterfaceRequestor]),
        getInterface(iid) {
          if (!iid.equals(Ci.nsILoadContext)) throw Cr.NS_ERROR_NO_INTERFACE;
          return {QueryInterface:XPCOMUtils.generateQI([Ci.nsILoadContext]),
            topFrameElement:view.browser,associatedWindow:null,topWindow:null,
            isContent:true,usePrivateBrowsing:PrivateBrowsingUtils.isWindowPrivate(view.browser.ownerDocument.defaultView),
            useRemoteTabs:false,originAttributes:principal.originAttributes};
        }
      };
      entry=Cc['@basilisk-browser.org/content-request-channel;1'].createInstance(Ci.nsIContentRequestChannel);
      entry.initialize(backing,frame(request.frameId),request.parentFrameId ? frame(request.parentFrameId) : frame(request.frameId));
      entry.channel.requestMethod=request.method || 'GET';
      for (const name of Object.keys(request.headers||{}))
        entry.channel.setRequestHeader(name,request.headers[name],false);
      state.channels.set(request.id,entry);
    }
    const channel=entry.channel, response=request.phase==='response';
    if (response) {
      entry.beginResponse(request.status);
      for (const name of Object.keys(request.headers||{})) channel.setResponseHeader(name,request.headers[name],false);
    }
    Services.obs.notifyObservers(channel,response ? 'http-on-examine-response' : 'http-on-modify-request',null);
    const finish=()=> {
      const headers={};
      const visitor={visitHeader(name,value) {headers[name]=value;}};
      if (response) channel.visitResponseHeaders(visitor); else channel.visitRequestHeaders(visitor);
      const decision={allow:channel.isPending() && Components.isSuccessCode(channel.status),headers};
      if (entry.redirectURI) decision.redirectURL=entry.redirectURI.spec;
      return JSON.stringify(decision);
    };
    if (entry.suspendCount && Components.isSuccessCode(channel.status)) {
      info.setPropertyAsBool('deferred',true);
      const id=info.getPropertyAsUint32('id'),began=Date.now();
      const resume=()=> {
        if (view.destroyed || !channel.isPending()) return;
        if (entry.suspendCount && Components.isSuccessCode(channel.status) && Date.now()-began<29000) {
          setTimeout(resume,10);return;
        }
        if (entry.suspendCount) channel.cancel(Cr.NS_BINDING_ABORTED);
        try {view.native.completeResourcePolicy(id,finish());} catch(error) {Cu.reportError(error);}
      };
      setTimeout(resume,0);
    } else info.setPropertyAsAUTF8String('reply',finish());
  }
};
