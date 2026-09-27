/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
// Compile DNS suffix sets into disjoint positive regular expressions. Backend
// regexes need neither lookahead nor alternation. Exclusions always win.
var ContentPolicyDomains = Object.freeze({
  patterns(included, excluded) {
    const valid = value => typeof value == "string" &&
      /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(value) && value.length <= 253;
    if (!included.concat(excluded).every(valid)) throw new Error("Unsupported domain name");
    if (included.length + excluded.length > 256) throw new Error("Too many domain conditions");
    const node = () => ({include:false, exclude:false, children:new Map()});
    const root = node(); root.include = !included.length;
    for (const [domains, field] of [[included,"include"],[excluded,"exclude"]]) {
      for (const domain of domains) {
        let cursor = root;
        for (const label of domain.split('.').reverse()) {
          if (!cursor.children.has(label)) cursor.children.set(label,node());
          cursor = cursor.children.get(label);
        }
        cursor[field] = true;
      }
    }
    const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // All nonempty DNS labels except the specified finite set of words.
    function otherLabels(words) {
      const results = [];
      function walk(prefix, tails) {
        const chars = Array.from(new Set(tails.filter(Boolean).map(s => s[0]))).sort();
        if (prefix && !tails.includes('')) results.push(escape(prefix));
        if (!chars.length) {
          results.push(escape(prefix) + '[a-z0-9_-]+'); return;
        }
        // Restrict the divergence character to the label alphabet explicitly.
        const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789_-';
        const rest = alphabet.split('').filter(c => !chars.includes(c)).join('').replace(/-/g,'\\-');
        if (rest) results.push(escape(prefix) + '['+rest+'][a-z0-9_-]*');
        for (const c of chars) walk(prefix+c,tails.filter(s=>s[0]===c).map(s=>s.slice(1)));
      }
      walk('', words); return results;
    }
    const hosts = [];
    function walk(cursor, suffix, inherited) {
      if (cursor.exclude) return;
      const active = inherited || cursor.include;
      if (active) {
        if (suffix) hosts.push(escape(suffix));
        for (const label of otherLabels(Array.from(cursor.children.keys())))
          hosts.push('([a-z0-9_-]+\\.)*' + label + (suffix ? '\\.'+escape(suffix) : ''));
      }
      for (const [label, child] of cursor.children)
        walk(child, label + (suffix ? '.'+suffix : ''), active);
    }
    walk(root,'',false);
    if (hosts.length > 4096) throw new Error("Domain condition expansion too large");
    return hosts.map(host => '^https?://([^/?#]*@)?'+host+'(:[0-9]+)?/');
  }
});
