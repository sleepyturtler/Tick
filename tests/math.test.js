const { assert, test } = require('./lib');
const { safeMath, parseEquation } = require('../src/math');
const solve = (s, n) => parseEquation(s)?.solve(n);

test('plain expressions still evaluate as before', () => {
    assert.equal(safeMath('2+3*4'), 14);
    assert.equal(safeMath('3x4'), 12);          // x between numbers is still "times" outside equations
    assert.equal(safeMath('|-5|'), 5);
    assert.equal(safeMath('pi^2'), 10);
    assert.equal(safeMath('5!'), 120);
    assert.equal(safeMath('2(3+4)'), 14);
    assert.equal(safeMath('x'), null);
    assert.equal(safeMath('lamine'), null);
});
test('linear equation counts when the expected number solves it', () => {
    assert.deepEqual(solve('2x+3=13', 5), { status: 'ok', value: 5 });
    assert.deepEqual(solve('x/2=3', 6), { status: 'ok', value: 6 });
    assert.deepEqual(solve('x+x=10', 5), { status: 'ok', value: 5 });
});
test('a wrong count reports the whole number the equation means, however far away', () => {
    assert.deepEqual(solve('2x+3=13', 6), { status: 'wrong', value: 5 });
    assert.deepEqual(solve('2x+3=13', 500), { status: 'wrong', value: 5 });
    assert.deepEqual(solve('x+1=2001', 7), { status: 'wrong', value: 2000 });
});
test('quadratics and equations with several solutions accept any of them', () => {
    assert.equal(solve('x^2=25', 5).status, 'ok');
    assert.equal(solve('x^2=25', -5).status, 'ok');
    assert.equal(solve('(x-1)(x-2)(x-3)=0', 2).status, 'ok');
    assert.equal(solve('|x-10|=3', 7).status, 'ok');
    assert.equal(solve('|x-10|=3', 13).status, 'ok');
});
test('identities and near-identities do not count', () => {
    for (const eq of ['x=x', '2x=x+x', 'abs(x)=x', 'floor(x/10)=3', 'x^2=x*x']) assert.equal(solve(eq, 35)?.status, 'degenerate', eq);
});
test('equations with no solution are not counts', () => {
    assert.equal(solve('x+1=x+2', 5).status, 'none');
    assert.equal(solve('0x=5', 3).status, 'none');
});
test('x equal to an expression follows the same rounding as the expression', () => {
    assert.equal(solve('x=2*pi', 6).status, 'ok');
    assert.deepEqual(solve('x=2*pi', 7), { status: 'wrong', value: 6 });
    assert.equal(solve('5!=x', 120).status, 'ok');
});
test('x is always the variable in an equation, including 2x3 and x2', () => {
    assert.equal(solve('2x3=24', 4).status, 'ok');
    assert.equal(solve('x2=14', 7).status, 'ok');
});
test('things that are not equations with x are ignored', () => {
    for (const s of ['1+1=2', 'x=', '=x', 'x=7=7', '2*x=lamine', 'x'.repeat(200) + '=1']) assert.equal(parseEquation(s), null, s);
});
test('the solver is cheap enough to run on every message', () => {
    const t = Date.now();
    for (let k = 0; k < 200; k++) { solve('x^2+3x=7', 1000 + k); solve('2x+3=13', 9 + k); }
    assert.ok(Date.now() - t < 1500, `took ${Date.now() - t}ms`);
});
