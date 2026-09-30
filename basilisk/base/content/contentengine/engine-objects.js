/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
// Privileged content worlds can use parent-owned XPCOM services. Handles and
// asynchronous callbacks are scoped to one document; no capability is placed
// in the web page's world. Content DOM interfaces stay in the WebProcess.
class ContentObjectRealm {
  constructor(view,frameId) {
    this.view=view;this.frameId=frameId;
    this.token=Cc['@mozilla.org/uuid-generator;1'].getService(Ci.nsIUUIDGenerator).generateUUID().toString();
    // Some XPConnect native wrappers cannot be WeakMap keys. The object table
    // already owns these references until document teardown.
    this.objects=new Map();this.ids=new Map();this.methods=new Map();
    this.callbacks=new Map();this.records=new Map();this.calls=new WeakMap();this.cleanups=[];this.nextId=0;this.closed=false;
  }
  encode(value) {
    if(value===undefined)return {kind:'undefined'};
    if(value===null||['string','number','boolean'].includes(typeof value))return {kind:'value',value};
    if(Array.isArray(value))return {kind:'array',values:value.map(item=>this.encode(item))};
    if(value instanceof ArrayBuffer)return {kind:'buffer',bytes:Array.from(new Uint8Array(value))};
    if(typeof value==='object'&&!(value instanceof Ci.nsISupports)&&
       typeof value.QueryInterface!=='function'&&!('wrappedJSObject' in value)&&
       (Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null)) {
      const values={};for(const key of Object.keys(value))values[key]=this.encode(value[key]);
      return {kind:'record',values};
    }
    let id=this.ids.get(value);
    if(!id) {id=String(++this.nextId);this.ids.set(value,id);this.objects.set(id,value);}
    const result={kind:'object',id,callable:typeof value==='function'};
    if(value instanceof Ci.nsIPrincipal)result.systemPrincipal=Services.scriptSecurityManager.isSystemPrincipal(value);
    return result;
  }
  decode(value) {
    switch(value.kind) {
      case 'undefined':return undefined;
      case 'value':return value.value;
      case 'iid':return Ci[value.name];
      case 'object':
        if(!this.objects.has(value.id))throw Error('Expired native object');
        return this.objects.get(value.id);
      case 'array':return value.values.map(item=>this.decode(item));
      case 'record': {
        const result=this.records.get(value.id)||{};this.records.set(value.id,result);
        for(const key of Object.keys(value.values))
          Object.defineProperty(result,key,{value:this.decode(value.values[key]),writable:true,enumerable:true,configurable:true});
        return result;
      }
      case 'callback': {
        if(!this.callbacks.has(value.id))this.callbacks.set(value.id,(...args)=> {
          if(this.closed)return;
          this.view.native.sendLegacyMessage(JSON.stringify({op:'callback',frameId:this.frameId,
            realm:this.token,id:value.id,args:args.map(arg=>this.encode(arg))}));
        });
        return this.callbacks.get(value.id);
      }
      default:throw Error('Invalid native argument');
    }
  }
  request(request) {
    if(this.closed||request.realm!==this.token)throw Error('Expired native service realm');
    let result;
    if(request.action==='hasService')return this.encode(request.contract in Cc);
    if(request.action==='service') {
      const entry=Cc[request.contract],iid=request.iid ? Ci[request.iid] : Ci.nsISupports;
      result=request.create ? entry.createInstance(iid) : entry.getService(iid);
    } else if(request.action==='xhr') {
      result=new XMLHttpRequest(request.anonymous ? {mozAnon:true} : {});
    } else {
      if(!this.objects.has(request.id))throw Error('Unknown native object');
      const object=this.objects.get(request.id),key=request.property;
      switch(request.action) {
        case 'get':
          result=object[key];
          if(typeof result==='function') {
            const cacheKey=request.id+':'+key;
            if(!this.methods.has(cacheKey)) {
              const bound=result.bind(object);this.methods.set(cacheKey,bound);this.calls.set(bound,{object,key});
            }
            result=this.methods.get(cacheKey);
          }
          break;
        case 'set':object[key]=this.decode(request.value);result=true;break;
        case 'keys':return {kind:'array',values:Object.keys(object).map(value=>({kind:'value',value}))};
        case 'call': {
          const args=request.args.map(value=>this.decode(value));result=object(...args);
          const method=this.calls.get(object);
          if(method&&['addObserver','addEventListener','addMessageListener'].includes(method.key)) {
            const remove=method.key.replace(/^add/,'remove');
            this.cleanups.push(()=>method.object[remove](...args));
          }
          break;
        }
        default:throw Error('Unknown native service operation');
      }
    }
    return this.encode(result);
  }
  close() {
    this.closed=true;
    for(const cleanup of this.cleanups) {try{cleanup();}catch(ignore){}}this.cleanups=[];
    for(const object of this.objects.values()) {
      try {
        if(object instanceof Ci.nsITimer)object.cancel();
        else if(object instanceof Ci.nsIXMLHttpRequest)object.abort();
      } catch(ignore) {}
    }
    this.objects.clear();this.ids.clear();this.callbacks.clear();this.records.clear();this.methods.clear();
  }
}
