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
context.µBlock.loadingFilterLists = true;
assert.throws(read, /not ready/);
context.µBlock.loadingFilterLists = false;
context.µBlock.systemSettings.compiledMagic++;
assert.throws(read, /schema/);
console.log('PASS live effective state, badfilter, selfie restore, user edits, session rules, whitelist, immutable ownership, version/schema/readiness guards');
