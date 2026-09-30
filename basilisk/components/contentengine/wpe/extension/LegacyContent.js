/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
(function(native) {
  'use strict';
  delete globalThis.__basiliskLegacyNative;
  let realmToken=null;
  const host=request=> {
    request.frameId=String(native.frameId);
    if(realmToken)request.realm=realmToken;
    const reply=JSON.parse(native.host(JSON.stringify(request)));
    if (reply.error) throw new Error(reply.error);
    return reply.value;
  };
  const report=error=> {
    try {host({op:'log',message:String(error)+'\n'+(error && error.stack || '')});} catch(ignore) {}
  };
  const config=host({op:'bootstrap',frameId:String(native.frameId),
    parentFrameId:String(native.parentFrameId),isTop:native.isTop});
  realmToken=config.realm;
  const remoteObjects=new Map(),remoteIds=new WeakMap(),callbacks=new Map(),callbackIds=new WeakMap(),interfaceNames=new WeakMap(),recordIds=new WeakMap(),systemPrincipals=new WeakSet();
  let nextCallback=0,nextRecord=0;
  function encodeNative(value,seen=new Set()) {
    if(value===undefined)return {kind:'undefined'};
    if(value===null||['string','number','boolean'].includes(typeof value))return {kind:'value',value};
    if(remoteIds.has(value))return {kind:'object',id:remoteIds.get(value)};
    if(interfaceNames.has(value))return {kind:'iid',name:interfaceNames.get(value)};
    if(typeof value==='function') {
      if(!callbackIds.has(value)){const id=String(++nextCallback);callbackIds.set(value,id);callbacks.set(id,value);}
      return {kind:'callback',id:callbackIds.get(value)};
    }
    if(value instanceof Node||value===window)throw Error('Content DOM objects cannot be passed to a parent native service');
    if(seen.has(value))throw Error('Cyclic native service argument');seen.add(value);
    let result;
    if(Array.isArray(value))result={kind:'array',values:value.map(item=>encodeNative(item,seen))};
    else {
      if(!recordIds.has(value))recordIds.set(value,String(++nextRecord));
      const values={};for(const key of Object.keys(value))values[key]=encodeNative(value[key],seen);
      result={kind:'record',id:recordIds.get(value),values};
    }
    seen.delete(value);return result;
  }
  function nativeRequest(request) {return decodeNative(host(Object.assign({op:'xpcom'},request)));}
  function decodeNative(value) {
    if(value.kind==='undefined')return undefined;
    if(value.kind==='value')return value.value;
    if(value.kind==='array')return value.values.map(decodeNative);
    if(value.kind==='buffer')return new Uint8Array(value.bytes).buffer;
    if(value.kind==='record') {
      const result={};for(const key of Object.keys(value.values))Object.defineProperty(result,key,{value:decodeNative(value.values[key]),writable:true,enumerable:true,configurable:true});
      return result;
    }
    if(value.kind!=='object')throw Error('Invalid native service reply');
    if(remoteObjects.has(value.id))return remoteObjects.get(value.id);
    const id=value.id,target=value.callable ? function(){} : {};
    const proxy=new Proxy(target,{
      get(target,property) {
        if(typeof property==='symbol')return Reflect.get(target,property);
        const descriptor=Object.getOwnPropertyDescriptor(target,property);
        if(descriptor&&!descriptor.configurable&&!descriptor.writable&&'value' in descriptor)return descriptor.value;
        return nativeRequest({action:'get',id,property});
      },
      set(target,property,value){return nativeRequest({action:'set',id,property,value:encodeNative(value)});},
      apply(target,self,args){return nativeRequest({action:'call',id,args:args.map(value=>encodeNative(value))});},
      ownKeys(target){return Array.from(new Set(Reflect.ownKeys(target).concat(nativeRequest({action:'keys',id}))));},
      getOwnPropertyDescriptor(target,property){return Object.getOwnPropertyDescriptor(target,property)||{configurable:true,enumerable:true,writable:true,value:proxy[property]};}
    });
    remoteObjects.set(id,proxy);remoteIds.set(proxy,id);if(value.systemPrincipal)systemPrincipals.add(proxy);return proxy;
  }
  function nativeService(contract,iid,create) {return nativeRequest({action:'service',contract,iid:iid&&iid.name,create});}
  function PrivilegedXHR(options) {return nativeRequest({action:'xhr',anonymous:!!(options&&options.mozAnon)});}
  function nativeFallback(local,contract,name) {
    let service;
    return new Proxy(local,{get(target,key,receiver) {
      if(key in target)return Reflect.get(target,key,receiver);
      if(!service)service=nativeService(contract,{name},false);
      return service[key];
    }});
  }
  const shared=native.shared();
  for(const key of ['observers','modules','factories','categories','windows'])if(!shared[key])shared[key]=new Map();
  shared.windows.set(window,String(native.frameId));
  const observers=shared.observers,modules=shared.modules,messageListeners=new Map();
  const factories=shared.factories,categories=shared.categories;
  const categoryManager={
    addCategoryEntry(category,name,contract,persist,replace) {
      if (!categories.has(category)) categories.set(category,new Map());
      const entries=categories.get(category),previous=entries.get(name)||'';
      if (previous && !replace) throw new Error('Category entry already exists');
      entries.set(name,contract);return previous;
    },
    deleteCategoryEntry(category,name) {const entries=categories.get(category);if(entries)entries.delete(name);},
    getCategoryEntry(category,name) {
      const value=categories.get(category);if(!value || !value.has(name))throw new Error('Unknown category entry');
      return value.get(name);
    }
  };
  const registrar={QueryInterface:qi,
    registerFactory(cid,name,contract,factory) {factories.set(contract,{cid:String(cid),factory});},
    unregisterFactory(cid,factory) {for(const [contract,entry] of factories)if(entry.cid===String(cid)&&entry.factory===factory)factories.delete(contract);},
    isContractIDRegistered(contract) {return factories.has(contract);}
  };
  const scripts=[], progressListeners=new Set(), sandboxes=new Set();
  let currentURI='',started=false,closed=false;
  const iid=name=>({name,equals(other) {return other && other.name===name;},
    toString() {return name;},[Symbol.hasInstance](object) {
      if (name==='nsIDOMWindow') return object===window || object===window.top;
      if (name==='nsIDOMDocument' || name==='nsIDOMHTMLDocument') return object instanceof Document;
      if (name==='nsIDOMNode') return object instanceof Node;
      if (name==='nsIDOMElement') return object instanceof Element;
      return !!(object && object.QueryInterface && (()=>{try {return object.QueryInterface(this)===object;} catch(error) {return false;}})());
    }});
  const interfaces=new Proxy(Object.create(null),{get(target,name) {
    if (typeof name!=='string') return undefined;
    if (!target[name]) {target[name]=Object.assign(iid(name),host({op:'interface',name}));interfaceNames.set(target[name],name);}
    return target[name];
  }});
  function qi() {return this;}
  const uri=(spec,charset,base)=> {
    const url=base ? new URL(String(spec),base.spec) : new URL(String(spec));
    return {spec:url.href,asciiSpec:url.href,scheme:url.protocol.slice(0,-1),host:url.hostname,
      asciiHost:url.hostname,hostPort:url.host,port:url.port ? Number(url.port) : -1,
      path:url.pathname+url.search+url.hash,pathQueryRef:url.pathname+url.search+url.hash,
      prePath:url.origin,QueryInterface:qi,schemeIs(scheme) {return scheme===this.scheme;},
      resolve(relative) {return new URL(relative,url.href).href;},clone() {return uri(url.href);},
      equals(other) {return other && other.spec===url.href;}};
  };
  const notify=(subject,topic,data)=> {
    for (const listener of Array.from(observers.get(topic)||[])) {
      try {typeof listener==='function' ? listener(subject,topic,data) : listener.observe(subject,topic,data);}
      catch(error) {report(error);}
    }
  };
  const manager=process=>({QueryInterface:qi,
    get content(){return process?undefined:window;},
    get docShell(){return process?undefined:docShell;},
    sendAsyncMessage(name,data) {host({op:'message',name,data,process,sync:false});},
    sendSyncMessage(name,data) {return host({op:'message',name,data,process,sync:true});},
    sendRpcMessage(name,data) {return host({op:'message',name,data,process,sync:true});},
    addMessageListener(name,listener) {
      const key=(process ? 'p:':'t:')+name;
      if (!messageListeners.has(key)) messageListeners.set(key,new Set());
      if (!messageListeners.get(key).size) host({op:'listen',name,process,add:true});
      messageListeners.get(key).add(listener);
    },
    removeMessageListener(name,listener) {
      const set=messageListeners.get((process ? 'p:':'t:')+name);if (set) set.delete(listener);
      if (set && !set.size) host({op:'listen',name,process,add:false});
    }
  });
  const tabManager=manager(false),processManager=manager(true);
  const sheetSource=spec=> {
    if (!spec.startsWith('data:')) return host({op:'read',uri:spec});
    const comma=spec.indexOf(',');
    return spec.slice(0,comma).endsWith(';base64') ? atob(spec.slice(comma+1)) : decodeURIComponent(spec.slice(comma+1));
  };
  const sheets=new Map();let sheetId=0;
  const registeredStyles=new Set();
  function documentMatches(condition) {
    const decode=value=>value.replace(/\\([0-9a-f]{1,6})\s?|\\(.)/gi,
      (all,hex,char)=>hex ? String.fromCodePoint(parseInt(hex,16)) : char);
    const pattern=/(url|url-prefix|domain|regexp)\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^)]*)\s*\)\s*(?:,|$)/g;
    let match,matched=false,end=0;
    while ((match=pattern.exec(condition))) {
      if (condition.slice(end,match.index).trim()) throw new Error('Unsupported document style condition');
      end=pattern.lastIndex;
      let value=match[2].trim();
      if (/^["']/.test(value)) value=value.slice(1,-1);
      value=decode(value);
      switch(match[1]) {
        case 'url':matched=matched||location.href===value;break;
        case 'url-prefix':matched=matched||location.href.startsWith(value);break;
        case 'domain':matched=matched||location.hostname===value||location.hostname.endsWith('.'+value);break;
        case 'regexp':matched=matched||new RegExp('^(?:'+value+')$').test(location.href);break;
      }
    }
    if (condition.slice(end).trim()) throw new Error('Unsupported document style condition');
    return matched;
  }
  function applyStyles(styles) {
    const render=rules=>rules.map(rule=> {
      if (rule.document!==undefined) return documentMatches(rule.document) ? render(rule.rules) : '';
      if (rule.group!==undefined) return rule.group+'{'+render(rule.rules)+'}';
      return rule.css;
    }).join('\n');
    const next=new Set(styles.map(sheet=>sheet.id));
    for (const id of registeredStyles) if (!next.has(id)) native.style(id,'',true);
    registeredStyles.clear();
    for (const sheet of styles) {
      try {native.style(sheet.id,render(sheet.rules),false);registeredStyles.add(sheet.id);}
      catch(error) {native.style(sheet.id,'',true);report(error);}
    }
  }
  const windowUtils={QueryInterface:qi,outerWindowID:native.frameId,currentInnerWindowID:native.frameId,
    USER_SHEET:1,AUTHOR_SHEET:2,AGENT_SHEET:0,
    loadSheetUsingURIString(spec,type) {
      let id=sheets.get(spec);if (!id) {id='legacy-'+native.frameId+'-'+(++sheetId);sheets.set(spec,id);}
      native.style(id,sheetSource(spec),false);
    },
    removeSheetUsingURIString(spec,type) {
      const id=sheets.get(spec);if (id) {native.style(id,'',true);sheets.delete(spec);}
    },
    loadSheet(sheet,type) {this.loadSheetUsingURIString(sheet.spec,type);},
    removeSheet(sheet,type) {this.removeSheetUsingURIString(sheet.spec,type);}
  };
  const webProgress={QueryInterface:qi,isTopLevel:native.isTop,DOMWindow:window,isLoadingDocument:document.readyState!=='complete',
    addProgressListener(listener) {progressListeners.add(listener);},removeProgressListener(listener) {progressListeners.delete(listener);}};
  const docShell={QueryInterface:qi,contentViewer:{DOMDocument:document},
    get sameTypeRootTreeItem() {return this;},get rootTreeItem() {return this;},
    getInterface(iid) {return getInterface(iid);}};
  function getInterface(iid) {
    switch(iid.name) {
      case 'nsIDOMWindowUtils':return windowUtils;
      case 'nsIDocShell':case 'nsIWebNavigation':return docShell;
      case 'nsIWebProgress':return webProgress;
      case 'nsIContentFrameMessageManager':case 'nsISyncMessageSender':return tabManager;
      case 'nsIDOMWindow':return window;
      default:throw new Error('Unsupported content interface: '+iid);
    }
  }
  Object.defineProperty(window,'getInterface',{value:getInterface,configurable:true});
  Object.defineProperty(window,'QueryInterface',{value:requested=> {
    if(['nsISupports','nsIDOMWindow','nsIInterfaceRequestor'].includes(requested.name))return window;
    throw Object.assign(new Error('No such content window interface'),{result:0x80004002,name:'NS_ERROR_NO_INTERFACE'});
  },configurable:true});
  const compare=(first,second)=>host({op:'compareVersions',first:String(first),second:String(second)});
  const Services={
    appinfo:config.appinfo,vc:{compare},io:nativeFallback({newURI:uri},'@mozilla.org/network/io-service;1','nsIIOService'),cpmm:processManager,
    obs:{addObserver(listener,topic) {
      if (!observers.has(topic)) observers.set(topic,new Set());observers.get(topic).add(listener);
    },removeObserver(listener,topic) {if(observers.has(topic))observers.get(topic).delete(listener);},notifyObservers:notify},
    tm:{currentThread:{dispatch(callback) {setTimeout(()=>typeof callback==='function' ? callback() : callback.run(),0);}}},
    console:{logStringMessage:message=>report(message)},
    prefs:new Proxy({}, {get(target,method) {return (...args)=>host({op:'preference',method,args});}}),
    scriptloader:{loadSubScript:loadSubScript,loadSubScriptWithOptions(url,options) {return loadSubScript(url,options.target,options.charset);}}
  };
  const XPCOMUtils={generateQI:list=>function(requested) {
    if(requested.name==='nsISupports'||list.some(iid=>iid.equals(requested)))return this;
    throw Object.assign(new Error('No such interface'),{result:0x80004002,name:'NS_ERROR_NO_INTERFACE'});
  },defineLazyGetter(object,name,getter) {
    Object.defineProperty(object,name,{configurable:true,get() {const value=getter();Object.defineProperty(object,name,{value,configurable:true});return value;}});
  },defineLazyModuleGetter(object,name,url,symbol) {
    this.defineLazyGetter(object,name,()=>importModule(url,null)[symbol||name]);
  },defineLazyServiceGetter(object,name,contract,iid) {
    this.defineLazyGetter(object,name,()=>classes[contract].getService(interfaces[iid]));
  },generateNSGetFactory(constructors) {return cid=>({createInstance(outer,iid) {
    if(outer)throw Components.results.NS_ERROR_NO_AGGREGATION;
    const Constructor=constructors.find(item=>String(item.prototype.classID)===String(cid));
    if(!Constructor)throw Error('Unknown component class');return new Constructor().QueryInterface(iid);
  }});}};
  const classes=new Proxy({}, {has(target,contract) {return factories.has(contract)||nativeRequest({action:'hasService',contract});},get(target,contract) {
    const services={
      '@mozilla.org/childprocessmessagemanager;1':processManager,
      '@mozilla.org/moz/jssubscript-loader;1':Services.scriptloader,
      '@mozilla.org/observer-service;1':Services.obs,
      '@mozilla.org/network/io-service;1':Services.io,
      '@mozilla.org/xre/app-info;1':Object.assign({QueryInterface:qi},config.appinfo,{processType:interfaces.nsIXULRuntime.PROCESS_TYPE_CONTENT}),
      '@mozilla.org/categorymanager;1':categoryManager
    };
    if (factories.has(contract)) return {
      createInstance(iid) {return factories.get(contract).factory.createInstance(null,iid);},
      getService(iid) {const entry=factories.get(contract);return entry.service||(entry.service=entry.factory.createInstance(null,iid));}
    };
    if (!(contract in services))return {
      getService:iid=>nativeService(contract,iid,false),createInstance:iid=>nativeService(contract,iid,true)
    };
    return {getService() {return services[contract];}};
  }});
  const Components={interfaces,classes,results:{NS_ERROR_NO_INTERFACE:0x80004002,NS_ERROR_NOT_IMPLEMENTED:0x80004001,
    NS_ERROR_NO_AGGREGATION:0x80040110,NS_OK:0},ID:id=>iid(id),
    get stack() {return {filename:currentURI};},
    manager:registrar,
    isSuccessCode:code=>!(code & 0x80000000)};
  Components.utils={
    import:importModule,unload(url) {modules.delete(url);},reportError:report,
    Sandbox:function(principal,options) {
      const subject=Array.isArray(principal)?principal[0]:principal;
      const sandbox=native.sandbox(shared.windows.get(subject)||String(native.frameId));
      if (!options || options.wantComponents!==false) {
        if(systemPrincipals.has(principal))sandbox.Components=Components;
        else if(Array.isArray(principal))sandbox.Components={interfaces,results:Components.results,isSuccessCode:Components.isSuccessCode};
      }
      sandboxes.add(sandbox);return sandbox;
    },
    evalInSandbox(source,sandbox,version,url,line) {return native.evaluate(source,url||currentURI,sandbox.__basiliskSandboxId||'');},
    nukeSandbox(sandbox) {sandboxes.delete(sandbox);},
    waiveXrays:value=>value,unwaiveXrays:value=>value,
    cloneInto(value,target,options={}) {
      const seen=new Map();
      const clone=value=> {
        if(value===null||!['object','function'].includes(typeof value))return value;
        if(seen.has(value))return seen.get(value);
        if(typeof value==='function') {
          if(!options.cloneFunctions)throw Error('Function cloning requires cloneFunctions');
          const wrapper=target.Function('callback','return function(){return callback.apply(this,arguments)}')(value);
          seen.set(value,wrapper);return wrapper;
        }
        // A parent-service proxy is a privileged capability, not a content DOM
        // reflector. Never hand its property/call traps to a userscript world.
        if(remoteIds.has(value))throw Error('Native service objects cannot be cloned into content sandboxes');
        if(Object.prototype.toString.call(value)==='[object ArrayBuffer]') {
          const result=new target.Uint8Array(new Uint8Array(value)).buffer;seen.set(value,result);return result;
        }
        const result=Array.isArray(value)?new target.Array():new target.Object();seen.set(value,result);
        for(const key of Object.keys(value))Object.defineProperty(result,key,{value:clone(value[key]),writable:true,enumerable:true,configurable:true});
        return result;
      };
      return clone(value);
    },
    exportFunction(fn,target,options) {if(options && options.defineAs)target[options.defineAs]=fn;return fn;},
    getGlobalForObject:()=>window
  };
  function scopedComponents(scope) {
    const result=Object.create(Components);result.utils=Object.create(Components.utils);
    result.utils.import=(url,target)=>importModule(url,target===undefined ? scope : target);
    result.utils.importGlobalProperties=names=> {
      for(const name of names) {
        if(name==='XMLHttpRequest')scope[name]=PrivilegedXHR;
        else if(name in globalThis)scope[name]=globalThis[name];
        else throw Error('Unsupported global property '+name);
      }
    };
    return result;
  }
  function sourceOf(value,seen=new Set()) {
    if(value===undefined)return 'undefined';
    if(typeof value==='function')return '('+Function.prototype.toString.call(value)+')';
    if(typeof value==='number')return Object.is(value,-0)?'-0':String(value);
    if(value===null||typeof value!=='object')return JSON.stringify(value);
    if(Object.prototype.toString.call(value)==='[object Error]')return 'new Error('+JSON.stringify(value.message)+')';
    if(value instanceof Date)return 'new Date('+value.getTime()+')';
    if(value instanceof RegExp)return String(value);
    if(seen.has(value))throw Error('Cannot serialize a cyclic source expression');seen.add(value);
    const result=Array.isArray(value)?'['+value.map(item=>sourceOf(item,seen)).join(',')+']':
      '({'+Object.keys(value).map(key=>JSON.stringify(key)+':'+sourceOf(value[key],seen)).join(',')+'})';
    seen.delete(value);return result;
  }
  Object.defineProperty(Function.prototype,'toSource',{configurable:true,value:function(){return sourceOf(this);}});
  function evaluateScope(source,url,scope,exportSymbols) {
    if(!scope.Components)scope.Components=scopedComponents(scope);
    if(!scope.dump)scope.dump=message=>host({op:'log',message:String(message)});
    if(!scope.uneval)scope.uneval=sourceOf;
    if(!scope.XPCNativeWrapper)scope.XPCNativeWrapper=function(value){return value;};
    const suffix=exportSymbols ? '\n;return (typeof EXPORTED_SYMBOLS!=="undefined" ? EXPORTED_SYMBOLS : this.EXPORTED_SYMBOLS||[]).reduce((result,name)=>{result[name]=eval(name);return result;},{});' : '';
    const fn=native.evaluate('(function(scope){with(scope){return (function(Components){\n'+source+suffix+'\n}).call(scope,scope.Components);}})',url,'');
    return fn(scope);
  }
  function withURI(url,fn) {const previous=currentURI;currentURI=url;try{return fn();}finally{currentURI=previous;}}
  function importModule(url,target) {
    let module=modules.get(url);
    if (!module) {
      if (url==='resource://gre/modules/Services.jsm') module={Services};
      else if (url==='resource://gre/modules/XPCOMUtils.jsm') module={XPCOMUtils};
      else if (url==='resource://gre/modules/PrivateBrowsingUtils.jsm') module={PrivateBrowsingUtils:{
        isContentWindowPrivate:()=>config.privateBrowsing,isWindowPrivate:()=>config.privateBrowsing}};
      else {
        const source=host({op:'read',uri:url});
        const scope={};modules.set(url,scope);
        try {module=withURI(url,()=>evaluateScope(source,url,scope,true));}
        catch(error) {modules.delete(url);throw error;}
      }
      modules.set(url,module);
    }
    if (target!==null) Object.assign(target||globalThis,module);
    return module;
  }
  function loadSubScript(url,target,charset) {
    const source=host({op:'read',uri:url});
    return withURI(url,()=> {
      if (target && target.__basiliskSandboxId) return native.evaluate(source,url,target.__basiliskSandboxId);
      if (!target || target===window) return native.evaluate(source,url,'');
      return evaluateScope(source,url,target,false);
    });
  }
  function runScript(script) {
    // Gecko frame-script globals belong to the tab's top-level frame. Their
    // shared observers still receive subdocument notifications.
    if(!native.isTop)return;
    const context={content:window,docShell,dump:message=>host({op:'log',message:String(message)}),
      addEventListener:window.addEventListener.bind(window),removeEventListener:window.removeEventListener.bind(window)};
    const mm=script.process ? processManager : tabManager;
    for (const name of ['sendAsyncMessage','sendSyncMessage','sendRpcMessage','addMessageListener','removeMessageListener']) context[name]=mm[name];
    try {loadSubScript(script.uri,context);} catch(error) {report(error);}
  }
  function locationChanged() {
    if (started) applyStyles(config.styles||[]);
    for (const listener of progressListeners) {
      try {listener.onLocationChange(webProgress,null,uri(location.href),0);} catch(error) {report(error);}
    }
  }
  Object.defineProperty(globalThis,'__basiliskLegacy',{value:Object.freeze({
    resourcePolicy(url,resourceType) {
      const entries=categories.get('content-policy');if(!entries)return true;
      const c=interfaces.nsIContentPolicy;
      const types=[c.TYPE_OTHER,c.TYPE_BEACON,c.TYPE_CSP_REPORT,native.isTop ? c.TYPE_DOCUMENT : c.TYPE_SUBDOCUMENT,
        c.TYPE_XMLHTTPREQUEST,c.TYPE_FONT,c.TYPE_IMAGE,c.TYPE_MEDIA,c.TYPE_OBJECT,c.TYPE_OTHER,c.TYPE_PING,
        c.TYPE_SCRIPT,c.TYPE_STYLESHEET,c.TYPE_XMLHTTPREQUEST,c.TYPE_STYLESHEET,c.TYPE_WEBSOCKET];
      const type=types[resourceType]||c.TYPE_OTHER;
      const context=resourceType===3 ? {contentWindow:window} : document;
      for(const contract of entries.values()) {
        try {
          const policy=classes[contract].getService(c);
          if(policy.shouldLoad(type,uri(url),uri(location.href),context,'',null)!==c.ACCEPT)return false;
        } catch(error) {report(error);return false;}
      }
      return true;
    },
    documentStart() {
      if(started || closed)return;started=true;
      applyStyles(config.styles||[]);
      notify(window,'content-document-global-created',null);
      notify(document,'document-element-inserted',null);
      locationChanged();
    },
    documentEnd() {webProgress.isLoadingDocument=false;},
    receive(message) {
      if(closed)return;
      if(message.op==='callback') {
        if(message.realm!==realmToken||String(message.frameId)!==String(native.frameId))return;
        const callback=callbacks.get(message.id);if(callback)callback(...message.args.map(decodeNative));return;
      }
      if(message.op==='styles') {config.styles=message.styles;applyStyles(message.styles);return;}
      if(message.op==='script') {runScript(message);return;}
      if(message.op!=='message')return;
      const key=(message.process ? 'p:':'t:')+message.name;
      const value={name:message.name,data:message.data,target:tabManager};
      for(const listener of Array.from(messageListeners.get(key)||[])) {
        try {typeof listener==='function' ? listener(value) : listener.receiveMessage(value);} catch(error) {report(error);}
      }
    }
  })});
  for(const script of config.scripts) runScript(script);
  addEventListener('hashchange',locationChanged);
  addEventListener('popstate',locationChanged);
  addEventListener('pagehide',event=>{
    if(event.persisted)return;
    try {host({op:'closeRealm'});} catch(ignore) {}
    for(const key of messageListeners.keys()) {
      try {host({op:'listen',name:key.slice(2),process:key.startsWith('p:'),add:false});} catch(error) {}
    }
    messageListeners.clear();closed=true;
  });
})(globalThis.__basiliskLegacyNative);
