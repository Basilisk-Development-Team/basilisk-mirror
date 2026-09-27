/* Run by test-state.py against JavaScript extracted from the verified XPI. */
'use strict';
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const root = process.argv[2];
const context = vm.createContext({console, setTimeout, clearTimeout, punycode:require("punycode")});
vm.runInContext(`var µBlock = {URI:{domainFromHostname: () => { throw Error("Unexpected request evaluation"); }}}, vAPI = {setTimeout: () => 0};`, context);
for (const file of ['utils.js', 'static-net-filtering.js', 'dynamic-net-filtering.js',
                    'url-net-filtering.js', 'hnswitches.js']) {
  vm.runInContext(fs.readFileSync(root + '/js/' + file, 'utf8'), context, {filename:file});
}
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
for (const url of ['https://ads.example/x', 'https://ads.example/allowed',
                   'https://ads.example/important', 'https://notads.example/x',
                   'https://sub.ads.example/x', 'https://ads.example:pw@safe.example/x',
                   'https://user@ads.example:443/x', 'https://elsewhere.example/banner/a',
                   'https://exact.example/path', 'https://exact.example/path2',
                   'https://scripts.example/x', 'https://third.example/x']) {
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
assert(vm.runInContext('UBlockStateAdapter.compileStaticNetwork(UBlockStateAdapter.snapshot("1.16.6.1", {µBlock})).unsupported.length', context) > 0);
context.µBlock.loadingFilterLists = true;
assert.throws(read, /not ready/);
context.µBlock.loadingFilterLists = false;
context.µBlock.systemSettings.compiledMagic++;
assert.throws(read, /schema/);
console.log('PASS live effective state, badfilter, selfie restore, user edits, session rules, whitelist, immutable ownership, version/schema/readiness guards');
