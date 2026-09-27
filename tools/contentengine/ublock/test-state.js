/* Run by test-state.py against JavaScript extracted from the verified XPI. */
'use strict';
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const root = process.argv[2];
const context = vm.createContext({console, setTimeout, clearTimeout, punycode:require("punycode")});
vm.runInContext(`var µBlock = {URI:{domainFromHostname: () => { throw Error("Unexpected request evaluation"); }}}, vAPI = {setTimeout: () => 0};`, context);
for (const file of ['utils.js', 'hntrie.js', 'static-net-filtering.js', 'dynamic-net-filtering.js',
                    'url-net-filtering.js', 'hnswitches.js']) {
  vm.runInContext(fs.readFileSync(root + '/js/' + file, 'utf8'), context, {filename:file});
}
for (const file of ['policy-domains.js','policy-patterns.js']) vm.runInContext(fs.readFileSync('basilisk/base/content/contentengine/'+file,'utf8'),context);
vm.runInContext(fs.readFileSync('basilisk/base/content/contentengine/adapters/ublock-state.js', 'utf8'), context);
// Supply browser-independent state normally created by background/startup. The
// filtering engine, parser, serialization and rule containers above are the
// actual unmodified extension implementations, not reimplementations.
vm.runInContext(`
µBlock.systemSettings = {compiledMagic:4, selfieMagic:2};
µBlock.userSettings = {advancedUserEnabled:true, parseAllABPHideFilters:true};
µBlock.netWhitelist = 'example.org';
µBlock.stringFromWhitelist = value => value;
µBlock.logger = {writeOne: () => {}};
function compile(lines) {
  let writer = new µBlock.CompiledLineIO.Writer();
  for (let line of lines) µBlock.staticNetFilteringEngine.compile(line, writer);
  µBlock.staticNetFilteringEngine.fromCompiledContent(new µBlock.CompiledLineIO.Reader(writer.toString()));
  µBlock.staticNetFilteringEngine.freeze();
}
compile(['||ads.example^', '*/banner*', '@@||safe.example^',
         '||removed.example^', '||removed.example^$badfilter']);
`, context);
const read = () => vm.runInContext('UBlockStateAdapter.snapshot("1.16.6.1", {µBlock})', context);
const first = read(), engine = context.µBlock.staticNetFilteringEngine;
assert(JSON.stringify(first.network).includes('ads.example'));
assert(!JSON.stringify(first.network).includes('removed.example'));
assert(Object.isFrozen(first.network.categories));
const registers = [engine.cbRegister, engine.thRegister, engine.fRegister];
read();
assert.deepStrictEqual([engine.cbRegister, engine.thRegister, engine.fRegister], registers);
// Startup from selfie must yield the same effective state even with no raw
// goodFilters. This catches an attractive but incorrect rule-export shortcut.
const selfie = engine.toSelfie();
engine.reset(); engine.fromSelfie(selfie);
assert.strictEqual(engine.goodFilters.size, 0);
assert.strictEqual(JSON.stringify(read().network), JSON.stringify(first.network));
vm.runInContext(`compile(['||new.example^']);
µBlock.sessionFirewall.setCell('example.org', '*', '3p', 1);
µBlock.netWhitelist = 'different.example';`, context);
const changed = read();
assert(JSON.stringify(changed.network).includes('new.example'));
assert(changed.session.firewall.length > first.session.firewall.length);
assert.strictEqual(changed.permanent.firewall.length, first.permanent.firewall.length);
assert.strictEqual(first.whitelist, 'example.org');
assert.strictEqual(changed.whitelist, 'different.example');
assert.throws(() => vm.runInContext('UBlockStateAdapter.snapshot("other", {µBlock})', context), /Unsupported/);
// Compare translated rules with the actual extension matcher on a controlled
// corpus. No browser request observer or synthetic channel is involved.
vm.runInContext(`
µBlock.staticNetFilteringEngine.reset();
compile(['||ads.example^', '@@||ads.example/allowed',
         '||ads.example/important$important', '@@||ads.example/important',
         '*/banner*', '|https://exact.example/path|', '||scripts.example^$script',
         '||third.example^$third-party']);
`, context);
const compiled = vm.runInContext('UBlockStateAdapter.compileStaticNetwork(UBlockStateAdapter.snapshot("1.16.6.1", {µBlock}))', context);
assert.strictEqual(compiled.unsupported.length, 0);
for (const input of ['https://ads.example/x', 'https://ads.example/allowed',
                   'https://ads.example/important', 'https://notads.example/x',
                   'https://sub.ads.example/x', 'https://ads.example:pw@safe.example/x',
                   'https://user@ads.example:443/x', 'https://elsewhere.example/banner/a',
                   'https://exact.example/path', 'https://exact.example/path2',
                   'https://scripts.example/x', 'https://third.example/x',
                   'http://ads.example', 'http://ads.example?query', 'ws://ads.example',
                   'wss://user@ads.example:444?query']) {
  const url=new URL(input).href;
  for (const type of ['script', 'image']) {
    const host = new URL(url).hostname;
    const request = {requestURL:url, requestHostname:host, requestType:type,
                     pageHostname:'page.example', pageDomain:'page.example'};
    const nativeBlock = engine.matchString(request) === 1;
    let translatedBlock = false;
    for (const rule of compiled.rules) {
      if (!rule.resourceTypes.includes(type)) continue;
      if (rule.party === 'first-party') continue;
      if (new RegExp(rule.urlPattern, 'i').test(url)) translatedBlock = rule.action === 'block';
    }
    assert.strictEqual(translatedBlock, nativeBlock, url + ' ' + type);
  }
}
vm.runInContext(`compile(['||domain.example^$domain=page.example']);`, context);
assert(vm.runInContext('UBlockStateAdapter.compileStaticNetwork(UBlockStateAdapter.snapshot("1.16.6.1", {µBlock})).unsupported.length', context) === 0);
vm.runInContext(`
µBlock.staticNetFilteringEngine.reset();
compile(['||negative.example^$domain=~safe.example|~other.example',
         '||mixed.example^$domain=example|~safe.example']);
`,context);
const domains=vm.runInContext('UBlockStateAdapter.compileStaticNetwork(UBlockStateAdapter.snapshot("1.16.6.1", {µBlock}))',context);
assert(domains.rules.some(rule=>rule.excludeDocumentURL && rule.documentURLPatterns.length===2));
for(const pageHostname of ['safe.example','sub.safe.example','other.example','page.example','unrelated.test']) {
  for(const requestHostname of ['negative.example','mixed.example']) {
    const requestURL='https://'+requestHostname+'/script';
    const request={requestURL,requestHostname,requestType:'script',pageHostname,pageDomain:'example'};
    const native=engine.matchString(request)===1;
    let translated=false;
    for(const rule of domains.rules) {
      const match=rule.documentURLPatterns.some(pattern=>new RegExp(pattern,'i').test('https://'+pageHostname+'/'));
      if (match===!!rule.excludeDocumentURL || !new RegExp(rule.urlPattern,'i').test(requestURL)) continue;
      translated=rule.action==='block';
    }
    assert.strictEqual(translated,native,requestURL+' from '+pageHostname);
  }
}
context.µBlock.loadingFilterLists = true;
assert.throws(read, /not ready/);
context.µBlock.loadingFilterLists = false;
vm.runInContext(`
µBlock.staticNetFilteringEngine.reset();
compile(['||shared.example^$script,image', '@@||shared.example/safe$script',
         '@@||popup.example^$popup', '@@||cosmetic.example^$generichide',
         '@@||object.example/safe$object,domain=page.example']);
`,context);
const projection=vm.runInContext('UBlockStateAdapter.compileStaticNetwork(UBlockStateAdapter.snapshot("1.16.6.1", {µBlock}))',context);
assert(!projection.unsupported.some(item=>(item.category&1)&&item.networkException!==false));
assert(projection.unsupported.some(item=>item.conservativeException));
assert(projection.rules.some(rule=>rule.action==='block'&&rule.resourceTypes.includes('script')&&rule.resourceTypes.includes('image')));
assert(!projection.rules.some(rule=>rule.urlPattern.includes('popup')||rule.urlPattern.includes('cosmetic')));
assert(projection.rules.some(rule=>rule.action==='allow'&&rule.urlPattern.includes('object')&&rule.documentURLPatterns));
context.µBlock.systemSettings.compiledMagic++;
assert.throws(read, /schema/);
console.log('PASS live effective state, badfilter, selfie restore, user edits, session rules, whitelist, immutable ownership, version/schema/readiness guards');
if(process.argv[3]) {
  context.µBlock.systemSettings.compiledMagic--;
  context.listLines=fs.readFileSync(process.argv[3],'utf8').split(/\r?\n/);
  const start=Date.now();
  vm.runInContext('µBlock.staticNetFilteringEngine.reset();compile(listLines);',context);
  const parsed=Date.now();
  const result=vm.runInContext('UBlockStateAdapter.compileStaticNetwork(UBlockStateAdapter.snapshot("1.16.6.1", {µBlock}))',context);
  const reasons={};
  for(const item of result.unsupported) {
    const key=JSON.stringify(item);
    reasons[key]=(reasons[key]||0)+1;
  }
  console.log('LARGEST RULES '+JSON.stringify(result.rules.map(rule=>({bytes:JSON.stringify(rule).length,documents:(rule.documentURLPatterns||[]).length,action:rule.action,pattern:rule.urlPattern})).sort((a,b)=>b.bytes-a.bytes).slice(0,10)));
  console.log('LIST TRANSLATION '+JSON.stringify({
    sha256:require('crypto').createHash('sha256').update(fs.readFileSync(process.argv[3])).digest('hex'),
    accepted:engine.acceptedCount,discarded:engine.discardedCount,rules:result.rules.length,
    parserMS:parsed-start,translationMS:Date.now()-parsed,unsupported:reasons
  }));
  for (const category of read().network.categories)
    if (category[0]===49) console.log('OBJECT EXCEPTIONS '+JSON.stringify(category));
}
