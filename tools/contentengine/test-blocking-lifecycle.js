/* Discovery must not revive extension state after its owning windows close. */
'use strict';
const assert=require('assert'),fs=require('fs'),vm=require('vm');
const discoveries=[],errors=[];
let subscriptions=0,notifications=0;
const background={},identity={};
const adapter={
  version:'test',
  inspectRuntime:()=>({background,identity,signature:'one'}),
  snapshot:()=>({}),compileStaticNetwork:()=>({rules:[],unsupported:[]})
};
const addons=[{id:'arbitrary-provider',version:'test',isActive:true}];
const context=vm.createContext({
  Components:{
    classes:{'@mozilla.org/timer;1':{createInstance:()=>({initWithCallback(){},cancel(){}})}},
    interfaces:{nsITimer:{}},
    utils:{import:()=>({XPIProvider:{bootstrapScopes:{'arbitrary-provider':{}}}}),
      reportError:error=>errors.push(error)}
  },
  Services:{scriptloader:{loadSubScript:(uri,scope)=>{scope.UBlockStateAdapter=adapter;}}},
  AddonManager:{
    addAddonListener:()=>++subscriptions,removeAddonListener:()=>--subscriptions,
    getAddonsByTypes:(types,callback)=>discoveries.push(callback)
  }
});
vm.runInContext(fs.readFileSync('basilisk/modules/LegacyBlockingExtensions.jsm','utf8'),context);
const service=context.LegacyBlockingExtensions,listener=()=>++notifications;
async function settle(result=addons) {
  assert.strictEqual(discoveries.length,1);
  const pending=service.pending;
  discoveries.shift()(result);
  return pending;
}
(async()=>{
  service.subscribe(listener);
  await settle();
  assert(service.entry);
  assert.strictEqual(notifications,1);
  service.refresh();
  service.unsubscribe(listener);
  await settle();
  assert.strictEqual(service.entry,null);
  assert.strictEqual(notifications,1);
  assert.strictEqual(subscriptions,0);

  service.subscribe(listener);
  service.invalidate();
  assert.strictEqual((await settle()).waiting,true);
  assert.strictEqual(service.entry,null);
  service.refresh();
  await settle();
  assert(service.entry);

  // A new window can subscribe while the old window's scan is still pending.
  for(let i=0;i<100;i++) {
    service.refresh();
    service.unsubscribe(listener);
    service.subscribe(listener);
    assert.strictEqual((await settle()).waiting,true);
    assert.strictEqual(service.entry,null);
    service.refresh();
    await settle();
    assert(service.entry);
    assert.strictEqual(subscriptions,1);
  }
  service.unsubscribe(listener);
  assert.strictEqual(await service.ready(),null);
  assert.strictEqual(discoveries.length,0);
  assert.strictEqual(subscriptions,0);
  assert.deepStrictEqual(errors,[]);
  console.log('PASS discovery cancellation, disable invalidation, and 100 window lifetime changes');
})().catch(error=>{console.error(error);process.exitCode=1;});
