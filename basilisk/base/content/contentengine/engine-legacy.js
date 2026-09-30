/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
var ContentLegacy = {
  states:new WeakMap(),
  observingStyles:false,
  init(view) {
    const state={view,bridges:{},sources:new Map(),realms:new Map(),backingListeners:new Map(),closed:false,
      backing:view.browser.messageManager,
      subscriptions:new Map(),
      relay:'basilisk:legacy-relay:'+Cc['@mozilla.org/uuid-generator;1'].getService(Ci.nsIUUIDGenerator).generateUUID().toString()};
    this.states.set(view,state);
    state.relayListener=message=> {
      if (!state.closed) view.native.sendLegacyMessage(JSON.stringify({op:'message',
        name:message.data.name,data:message.data.data,process:false}));
    };
    state.backing.addMessageListener(state.relay,state.relayListener);
    const relaySource='('+function(key) {
      const scope=this,listeners=new Map();
      const control=message=> {
        const command=message.data;
        if (command.close) {
          for (const [name,listener] of listeners) scope.removeMessageListener(name,listener);
          listeners.clear();scope.removeMessageListener(key,control);return;
        }
        if (command.add && !listeners.has(command.name)) {
          const listener=message=>scope.sendAsyncMessage(key,{name:message.name,data:message.data});
          listeners.set(command.name,listener);scope.addMessageListener(command.name,listener);
        } else if (!command.add && listeners.has(command.name)) {
          scope.removeMessageListener(command.name,listeners.get(command.name));listeners.delete(command.name);
        }
      };
      scope.addMessageListener(key,control);
    }.toString()+').call(this,'+JSON.stringify(state.relay)+');';
    state.backing.loadFrameScript('data:application/javascript,'+encodeURIComponent(relaySource),false);
    const make=(parent,process)=> {
      const bridge=Cc['@basilisk-browser.org/content-message-bridge;1'].createInstance(Ci.nsIContentMessageBridge);
      let initialized=false;
      const listener={
        QueryInterface:XPCOMUtils.generateQI([Ci.nsIContentMessageListener]),
        loadScript(uri,globalScope) {
          // Initial inherited scripts are supplied by document bootstrap.
          if (!initialized || !ContentLegacy.owner(uri)) return;
          view.native.sendLegacyMessage(JSON.stringify({op:'script',uri,globalScope,process}));
        },
        sendMessage(name,data) {
          if (state.closed) return;
          if (!process && !state.subscriptions.has(name)) {
            state.backing.sendAsyncMessage(name,data);return;
          }
          view.native.sendLegacyMessage(JSON.stringify({op:'message',name,data,process}));
        }
      };
      bridge.initialize(parent,view.browser,listener,process);
      initialized=true;
      return bridge;
    };
    state.bridges.tab=make(window.messageManager,false);
    state.bridges.process=make(Services.ppmm,true);
    const sender=state.bridges.tab.manager,senderMethods=new Map();
    const messageManager=new Proxy(Object.create(null),{get(_,key) {
      const target=sender;
      if(key==='addMessageListener')return (name,listener,...args)=> {
        target.addMessageListener(name,listener,...args);
        if(!state.backingListeners.has(name))state.backingListeners.set(name,new Map());
        const listeners=state.backingListeners.get(name);
        if(listeners.has(listener))return;
        const relay=message=> {
          if(state.closed||state.subscriptions.has(name))return undefined;
          return typeof listener==='function'?listener(message):listener.receiveMessage(message);
        };
        listeners.set(listener,relay);state.backing.addMessageListener(name,relay,...args);
      };
      if(key==='removeMessageListener')return (name,listener)=> {
        target.removeMessageListener(name,listener);
        const listeners=state.backingListeners.get(name),relay=listeners&&listeners.get(listener);
        if(relay){state.backing.removeMessageListener(name,relay);listeners.delete(listener);}
        if(listeners&&!listeners.size)state.backingListeners.delete(name);
      };
      const value=target[key];if(typeof value!=='function')return value;
      if(!senderMethods.has(key))senderMethods.set(key,value.bind(target));return senderMethods.get(key);
    }});
    view.define('messageManager',{get:()=>messageManager});
    // Older add-ons obtain the same sender through frameLoader.messageManager.
    // Native frame-loader operations continue to use the backing loader.
    const loader=view.browser.frameLoader,methods=new Map();
    const facade=new Proxy(Object.create(null),{get(_,key) {
      const target=loader;
      if(key==='messageManager')return messageManager;
      const value=target[key];
      if(typeof value!=='function')return value;
      if(!methods.has(key))methods.set(key,value.bind(target));return methods.get(key);
    }});
    view.define('frameLoader',{get:()=>facade});
    if (!this.observingStyles) {
      this.observingStyles=true;
      const observer={observe:()=> {
        for (const current of ContentEngines.views.values()) {
          const owner=this.states.get(current);
          if (owner && !owner.closed)
            current.native.sendLegacyMessage(JSON.stringify({op:'styles',styles:this.styles(owner)}));
        }
      }};
      for (const topic of ['user-sheet-added','user-sheet-removed']) Services.obs.addObserver(observer,topic,false);
      window.addEventListener('unload',()=> {
        for (const topic of ['user-sheet-added','user-sheet-removed']) Services.obs.removeObserver(observer,topic);
      },{once:true});
    }
  },
  styles(state) {
    const serialize=rules=>Array.from(rules,rule=> {
      if (rule instanceof Ci.nsIDOMCSSMozDocumentRule)
        return {document:rule.conditionText,rules:serialize(rule.cssRules)};
      if (rule.cssRules && rule.type!==Ci.nsIDOMCSSRule.KEYFRAMES_RULE)
        return {group:rule.cssText.slice(0,rule.cssText.indexOf('{')),rules:serialize(rule.cssRules)};
      return {css:rule.cssText};
    });
    const sheets=state.bridges.tab.userStyleSheets,result=[];
    for (let i=0;i<sheets.length;i++) {
      const sheet=sheets.queryElementAt(i,Ci.nsIDOMCSSStyleSheet);
      if (!sheet.disabled) result.push({id:sheet.href||'registered-user-style-'+i,rules:serialize(sheet.cssRules)});
    }
    return result;
  },
  owner(uri) {
    try {return AddonManager.mapURIToAddonID(Services.io.newURI(uri,null,null));}
    catch(error) {return null;}
  },
  read(state,uri) {
    const owner=this.owner(uri);
    if (!owner) throw new Error('Content source is not owned by an installed extension: '+uri);
    if (state.sources.has(uri)) return state.sources.get(uri);
    const {NetUtil}=Cu.import('resource://gre/modules/NetUtil.jsm',{});
    const channel=NetUtil.newChannel({uri,loadUsingSystemPrincipal:true});
    const stream=channel.open();
    let source;
    try {source=NetUtil.readInputStreamToString(stream,stream.available(),{charset:'UTF-8'});}
    finally {stream.close();}
    if (source.length>4*1024*1024) throw new Error('Extension source exceeds size limit');
    state.sources.set(uri,source);return source;
  },
  handle(view,info) {
    const state=this.states.get(view);
    if (!state || state.closed) throw new Error('Content extension services unavailable');
    const request=JSON.parse(info.getPropertyAsAUTF8String('json'));
    let result;
    switch(request.op) {
      case 'bootstrap': {
        const previous=state.realms.get(request.frameId);if(previous)previous.close();
        const realm=new ContentObjectRealm(view,request.frameId);state.realms.set(request.frameId,realm);
        const scripts=[];
        const append=(manager,process)=> {
          const list=process ? manager.getDelayedProcessScripts() : manager.getDelayedFrameScripts();
          for (const [uri,globalScope] of list) if (this.owner(uri) && !scripts.some(s=>s.uri===uri))
            scripts.push({uri,globalScope,process});
        };
        append(Services.ppmm,true); append(Services.mm,false); append(window.messageManager,false);
        result={scripts,realm:realm.token,privateBrowsing:PrivateBrowsingUtils.isWindowPrivate(window),
          styles:this.styles(state),appinfo:{name:Services.appinfo.name,version:Services.appinfo.version,
          platformVersion:Services.appinfo.platformVersion,OS:Services.appinfo.OS},
          frameId:request.frameId,parentFrameId:request.parentFrameId,isTop:request.isTop};
        break;
      }
      case 'read': result=this.read(state,request.uri);break;
      case 'xpcom': {
        const realm=state.realms.get(request.frameId);
        if(!realm)throw Error('No native service realm');
        result=realm.request(request);break;
      }
      case 'closeRealm': {
        const realm=state.realms.get(request.frameId);
        if(realm&&realm.token===request.realm){realm.close();state.realms.delete(request.frameId);}
        result=null;break;
      }
      case 'compareVersions':
        result=Services.vc.compare(String(request.first),String(request.second));break;
      case 'interface': {
        const iid=Ci[request.name]; if (!iid) throw new Error('Unknown interface '+request.name);
        result={}; for (const key of Object.keys(iid)) {
          const value=iid[key]; if (['number','string','boolean'].includes(typeof value)) result[key]=value;
        }
        break;
      }
      case 'message':
        result=state.bridges[request.process ? 'process':'tab'].receiveMessage(request.name,request.data,!!request.sync);
        break;
      case 'listen':
        if (!request.process) {
          let frames=state.subscriptions.get(request.name);
          if (!frames) {frames=new Set();state.subscriptions.set(request.name,frames);}
          const before=frames.size;
          if (request.add) frames.add(request.frameId);else frames.delete(request.frameId);
          if (!!before!==!!frames.size)
            state.backing.sendAsyncMessage(state.relay,{name:request.name,add:!!frames.size});
          if (!frames.size) state.subscriptions.delete(request.name);
        }
        result=null;break;
      case 'preference':
        if (!/^(?:get(?:Bool|Char|Int)Pref|set(?:Bool|Char|Int)Pref|clearUserPref|prefHasUserValue|getPrefType)$/.test(request.method))
          throw new Error('Unsupported preference operation');
        result=Services.prefs[request.method](...request.args);
        break;
      case 'log': Cu.reportError('Content extension: '+request.message);result=null;break;
      default: throw new Error('Unsupported content service: '+request.op);
    }
    info.setPropertyAsAUTF8String('reply',JSON.stringify({value:result}));
  },
  close(view) {
    const state=this.states.get(view); if (!state) return;
    state.closed=true;
    state.backing.sendAsyncMessage(state.relay,{close:true});
    state.backing.removeMessageListener(state.relay,state.relayListener);
    for(const [name,listeners] of state.backingListeners)
      for(const relay of listeners.values())state.backing.removeMessageListener(name,relay);
    state.backingListeners.clear();
    for (const bridge of Object.values(state.bridges)) bridge.close();
    for (const realm of state.realms.values()) realm.close();state.realms.clear();
    state.sources.clear();this.states.delete(view);
  }
};
