/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";
// Equivalent finite expansion for backends without regex disjunction. This is
// NOT a filter-list parser. Unsupported constructs reject rather than widen.
var ContentPolicyPatterns = Object.freeze({
  expand(source, caseSensitive = true) {
    let pos=0;
    const limit=512;
    // Policy URLs are serialized ASCII URLs. Lower built-in classes to an
    // explicit ASCII set; the backend regex subset has no built-in classes.
    function characterClass(source) {
      const test=new RegExp('^'+source+'$',caseSensitive ? '' : 'i');
      const ranges=[];
      const hex=value=>'\\x'+('0'+value.toString(16)).slice(-2);
      for (let code=1;code<128;code++) {
        if (!test.test(String.fromCharCode(code))) continue;
        const first=code;
        while (code+1<128 && test.test(String.fromCharCode(code+1))) code++;
        ranges.push(first===code ? hex(first) : hex(first)+'-'+hex(code));
      }
      if (!ranges.length) throw new Error('Character class cannot match an ASCII URL');
      return '['+ranges.join('')+']';
    }
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
          atom=[/\\[dDsSwWuxc0]/.test(text) ? characterClass(text) : text];
        } else if (c==='\\') {
          if (pos===source.length) throw new Error("Trailing escape");
          const next=source[pos++];
          if (/[0-9bBpPkK]/.test(next)) throw new Error("Unsupported pattern escape");
          if (next==='x' || next==='u') {
            const size=next==='x' ? 2 : 4, digits=source.slice(pos,pos+size);
            if (digits.length!==size || !/^[0-9a-f]+$/i.test(digits)) throw new Error('Invalid hexadecimal escape');
            const value=parseInt(digits,16);
            if (!value || value>127) throw new Error('Character cannot occur in a serialized ASCII URL');
            pos+=size;
            atom=['\\x'+('0'+value.toString(16)).slice(-2)];
          } else atom=[/[dDsSwW]/.test(next) ? characterClass('[\\'+next+']') : '\\'+next];
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
    const result=Array.from(new Set(alternatives(false)));
    if (result.some(pattern=>pattern.length>8192)) throw new Error('Expanded pattern exceeds size limit');
    return result;
  }
});
