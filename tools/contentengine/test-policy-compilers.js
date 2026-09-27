/* Project-owned predicate compilers: no backend or extension dependencies. */
'use strict';
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const scope=vm.createContext({});
for(const name of ['policy-domains','policy-patterns'])
 vm.runInContext(fs.readFileSync('basilisk/base/content/contentengine/'+name+'.js','utf8'),scope);
const domains=scope.ContentPolicyDomains,patterns=scope.ContentPolicyPatterns;
const hosts=['example.com','sub.example.com','ads.example.com','sub.ads.example.com',
 'tracker.example.com','foo.tracker.example.com','bar.tracker.example.com','notexample.com',
 'example.com.evil','com','localhost','127.0.0.1','example.org','ad.example.com','adsx.example.com'];
for(const [include,exclude] of [ [[],[]], [['example.com'],[]], [[],['ads.example.com']],
 [['example.com'],['ads.example.com','foo.tracker.example.com']], [['example.com'],['com']],
 [['example.com','example.org'],['ads.example.com']], [['sub.ads.example.com'],['ads.example.com']] ]) {
 const regexes=domains.patterns(include,exclude).map(p=>new RegExp(p,'i'));
 const match=(host,set)=>set.some(d=>host===d||host.endsWith('.'+d));
 for(const host of hosts) {
  const expected=(!include.length||match(host,include))&&!match(host,exclude);
  for(const url of ['https://'+host+'/x','http://user:pass@'+host+':8080/x'])
   assert.strictEqual(regexes.some(re=>re.test(url)),expected,url+JSON.stringify([include,exclude]));
 }
 assert(!regexes.some(re=>re.test('https://example.com.evil@bad.invalid/x')) || !include.length);
}
assert.throws(()=>domains.patterns(['bad/path'],[]));
for(const source of ['^https?://(ads|track)[.]example/','banner([^a-z]|$)',
 '^https?://([^/?#]*@)?([^/?#:@]*\\.)?ads\\.example(:[0-9]+)?([/?#]|$)',
 'before([^a-z]|$)after','foo(bar|baz)?','(foo|bar)','(a|b)c(d|e)']) {
 const expanded=patterns.expand(source).map(p=>new RegExp(p));
 const original=new RegExp(source);
 for(const text of ['https://ads.example/','https://track.example/path','https://ads.example.evil/',
 'banner','banner/','bannera','before/after','beforeafter','foo','foobar','foobaz','acd','bce','bar'])
  assert.strictEqual(expanded.some(re=>re.test(text)),original.test(text),source+' '+text);
}
for(const source of ['(?=x)x','(a|b)*','(a','[x','x\\1'])assert.throws(()=>patterns.expand(source));
console.log('PASS domain inclusion/exclusion and bounded regex expansion');
