const { FLOOR_SIZE } = require('./config');

// ---------- modifiers ----------
const MODIFIERS = [
    { id:'every2',      label:'\u23e9 Count every 2nd number', desc:'Skip every other number! Only even numbers count.',            check:n=>n%2===0, next:n=>n+2 },
    { id:'every3',      label:'\u23e9 Count every 3rd number', desc:'Only multiples of 3!',                                         check:n=>n%3===0, next:n=>n+3 },
    { id:'primes',      label:'\u{1F522} Primes only',         desc:'Only prime numbers are valid!',                                check:isPrime,    next:nextPrime },
    { id:'fibonacci',   label:'\u{1F300} Fibonacci sequence',  desc:'Follow the Fibonacci sequence: 1, 1, 2, 3, 5, 8, 13\u2026',   check:isFibonacci,next:nextFibonacci },
    { id:'squares',     label:'\u{1F7E5} Perfect squares',     desc:'Only perfect squares! 1, 4, 9, 16, 25\u2026',                  check:n=>{const s=Math.round(Math.sqrt(n));return s*s===n;}, next:n=>{const s=Math.round(Math.sqrt(n));return(s+1)*(s+1);} },
    { id:'palindromes', label:'\u{1F504} Palindrome numbers',  desc:'Only numbers that read the same forwards and backwards!',     check:isPalindrome, next:nextPalindrome },
    { id:'lucky7',      label:'\u{1F340} Multiples of 7',      desc:'Lucky sevens! Only multiples of 7.',                           check:n=>n%7===0, next:n=>n+7 },
    { id:'triangular',  label:'\u{1F53A} Triangular numbers',  desc:'Only triangular numbers! 1, 3, 6, 10, 15, 21\u2026',          check:isTriangular, next:nextTriangular },
];
function isPrime(n) { if(n<2)return false;if(n===2)return true;if(n%2===0)return false;for(let i=3;i<=Math.sqrt(n);i+=2)if(n%i===0)return false;return true; }
function nextPrime(n) { let m=n+1;while(!isPrime(m))m++;return m; }
function isFibonacci(n) { const sq=x=>{const s=Math.round(Math.sqrt(x));return s*s===x;};return sq(5*n*n+4)||sq(5*n*n-4); }
function nextFibonacci(n) { let a=1,b=1;while(b<=n){const c=a+b;a=b;b=c;}return b; }
function isTriangular(n) { const x=(Math.sqrt(8*n+1)-1)/2;return Math.abs(x-Math.round(x))<1e-9; }
function nextTriangular(n) { let t=1,k=1;while(t<=n){k++;t=k*(k+1)/2;}return t; }
function isPalindrome(n) { const s=String(n);return s===s.split('').reverse().join(''); }
function nextPalindrome(n) { let m=n+1;while(!isPalindrome(m))m++;return m; }
function pickModifier() { return MODIFIERS[Math.floor(Math.random()*MODIFIERS.length)]; }
function getModifier(id) { return MODIFIERS.find(m=>m.id===id)??MODIFIERS[0]; }
function firstValidForModifier(modId) { const mod=getModifier(modId);let n=1;while(!mod.check(n))n++;return n; }

// The number the channel wants next. Countdown uses start+1 as "nothing counted yet", so the first number is 100, not 99.
function expectedNext(c) {
    if (c.countType === 'countdown') return c.current - 1;
    if (c.countType === 'modifiers') return c.current === 0 ? firstValidForModifier(c.modifier) : getModifier(c.modifier).next(c.current);
    return c.current + 1;
}
// What we tell players about "what's next". Modifiers only ever name the category, never the number.
const nextText = c => c.countType === 'modifiers' ? `Modifier: **${c.modifierLabel ?? 'none'}**` : `Next number: **${expectedNext(c)}**`;

function modeIntro(c) {
    switch (c.countType) {
        case 'simple': return 'Wrong messages are silently deleted and the count never resets. Start from **1**!';
        case 'countdown': return `Count **down** from **${c.countdownStart}** to **1**. Start with **${c.countdownStart}**!`;
        case 'modifiers': return `A modifier decides which numbers are valid \u2014 work out the pattern!\nModifier: **${c.modifierLabel}**\n${getModifier(c.modifier).desc}`;
        case 'floors': return `Count up! Every **${FLOOR_SIZE}** is a floor checkpoint \u2014 if the count is ruined you drop back to your highest checkpoint instead of 0. Start from **1**!`;
        default: return 'Wrong numbers and streaks reset the count to 0. Start from **1**!';
    }
}
function resetChannel(c, full = false) {
    if (full) c.checkpoint = 0;
    if (c.countType === 'countdown') c.current = c.countdownStart + 1;
    else if (c.countType === 'modifiers') { const m = pickModifier(); c.modifier = m.id; c.modifierLabel = m.label; c.current = 0; }
    else if (c.countType === 'floors') c.current = c.checkpoint || 0;
    else c.current = 0;
    c.lastUserId = null; c.consecutiveCount = 0; c.lastMessageId = null; delete c.pendingSave;
}

module.exports = { MODIFIERS, pickModifier, getModifier, firstValidForModifier, expectedNext, nextText, modeIntro, resetChannel };
