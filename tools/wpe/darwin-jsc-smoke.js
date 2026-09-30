// Run with the pinned WPE build's jsc, not system JavaScriptCore.
function hotArithmetic(value) { return ((value * 3) ^ 90) >>> 0; }
noInline(hotArithmetic);
let total = 0;
for (let i = 0; i < 1000000; ++i)
    total += hotArithmetic(i);
if (total !== 1499998501408)
    throw new Error("JavaScript arithmetic mismatch: " + total);
if (numberOfDFGCompiles(hotArithmetic) < 1)
    throw new Error("The hot function did not reach an optimizing JIT");

const bytes = new Uint8Array([
    0,97,115,109,1,0,0,0, 1,7,1,96,2,127,127,1,127, 3,2,1,0,
    7,7,1,3,97,100,100,0,0, 10,9,1,7,0,32,0,32,1,106,11
]);
const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes));
for (let i = 0; i < 100000; ++i) {
    const actual = instance.exports.add(i, 17);
    if (actual !== i + 17)
        throw new Error("WebAssembly result mismatch at " + i + ": " + actual);
}
print("PASS WPE Darwin JavaScript/JIT and WebAssembly execution");
