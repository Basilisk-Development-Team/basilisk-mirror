/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
// Equivalent finite expansion for backends without regex disjunction. This is
// NOT a filter-list parser. Unsupported constructs reject rather than widen.
var ContentPolicyPatterns = Object.freeze({
  expand(source) {
    let pos=0;
    const limit=512;
    function bounded(values) {
      if (values.length>limit) throw new Error("Pattern expansion too large");
      return values;
    }
    function concat(left,right) {
      const out=[];
      for (const a of left) for (const b of right) {
        // A terminal anchor followed by a consuming term is an empty language.
        if (a.endsWith('$') && !a.endsWith('\\$') && b && b!='$') continue;
        out.push(a+(a.endsWith('$') && b=='$' ? '' : b));
        bounded(out);
      }
      return out;
    }
    function alternatives(group) {
      let parts=[''], out=[];
      while (pos<source.length) {
        const c=source[pos++];
        if (c===')') {
          if (!group) throw new Error("Unbalanced pattern");
          return bounded(out.concat(parts));
        }
        if (c==='|') {out=bounded(out.concat(parts));parts=[''];continue;}
        let atom;
        if (c==='(') {
          if (source.slice(pos,pos+2)==='?:') pos+=2;
          else if (source[pos]==='?') throw new Error("Unsupported pattern assertion");
          atom=alternatives(true);
        } else if (c==='[') {
          let text=c, closed=false;
          while (pos<source.length) {
            let next=source[pos++];text+=next;
            if (next==='\\' && pos<source.length) text+=source[pos++];
            else if (next===']') {closed=true;break;}
          }
          if (!closed) throw new Error("Unclosed character class");
          atom=[text];
        } else if (c==='\\') {
          if (pos===source.length) throw new Error("Trailing escape");
          const next=source[pos++];
          if (/[1-9bBpPkK]/.test(next)) throw new Error("Unsupported pattern escape");
          atom=[next==='d' ? '[0-9]' : next==='w' ? '[a-zA-Z0-9_]' : '\\'+next];
        } else {
          if ('*+?{}'.includes(c)) throw new Error("Unsupported pattern quantifier");
          atom=[c];
        }
        const q=source[pos];
        if (q==='{') {
          const match=/^\{(\d+)(?:,(\d*))?\}/.exec(source.slice(pos));
          if (!match) throw new Error("Invalid counted quantifier");
          const min=Number(match[1]);
          const max=match[2]===undefined ? min : match[2]==='' ? Infinity : Number(match[2]);
          if (min>64 || (max!==Infinity && max>64) || max<min)
            throw new Error("Counted quantifier exceeds expansion limit");
          pos+=match[0].length;
          if (source[pos]==='?') pos++;
          if (max===Infinity && atom.length!==1)
            throw new Error("Repeated disjunction cannot be finitely expanded");
          if (atom.length===1) {
            const term='('+atom[0]+')';
            atom=[term.repeat(min)+(max===Infinity ? term+'*' : (term+'?').repeat(max-min))];
          } else {
            let required=[''];
            for (let i=0;i<min;i++) required=bounded(concat(required,atom));
            let optional=[''], count=[''];
            for (let i=min;i<max;i++) {
              count=bounded(concat(count,atom));
              optional=bounded(optional.concat(count));
            }
            atom=bounded(concat(required,optional));
          }
        } else if (q==='?' || q==='*' || q==='+') {
          pos++;
          if (source[pos]==='?') pos++; // Greediness does not affect a boolean match.
          if (atom.length>1) {
            if (q!=='?') throw new Error("Repeated disjunction cannot be finitely expanded");
            atom=atom.concat(['']);
          } else atom=['('+atom[0]+')'+q];
        }
        parts=bounded(concat(parts,atom));
      }
      if (group) throw new Error("Unclosed pattern group");
      return bounded(out.concat(parts));
    }
    return Array.from(new Set(alternatives(false)));
  }
});
