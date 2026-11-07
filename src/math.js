const SUP={'\u2070':'0','\u00b9':'1','\u00b2':'2','\u00b3':'3','\u2074':'4','\u2075':'5','\u2076':'6','\u2077':'7','\u2078':'8','\u2079':'9','\u207a':'+','\u207b':'-'};
class C{constructor(r=0,i=0){this.r=r;this.i=i;}static of(x){return x instanceof C?x:new C(+x,0);}add(b){b=C.of(b);return new C(this.r+b.r,this.i+b.i);}sub(b){b=C.of(b);return new C(this.r-b.r,this.i-b.i);}mul(b){b=C.of(b);return new C(this.r*b.r-this.i*b.i,this.r*b.i+this.i*b.r);}div(b){b=C.of(b);const d=b.r*b.r+b.i*b.i;if(!d)return new C(NaN,NaN);return new C((this.r*b.r+this.i*b.i)/d,(this.i*b.r-this.r*b.i)/d);}pow(b){b=C.of(b);if(this.r===0&&this.i===0)return(b.r===0&&b.i===0)?new C(1):new C(0);return this.ln().mul(b).exp();}ln(){return new C(Math.log(Math.hypot(this.r,this.i)),Math.atan2(this.i,this.r));}exp(){const e=Math.exp(this.r);return new C(e*Math.cos(this.i),e*Math.sin(this.i));}neg(){return new C(-this.r,-this.i);}sqrt(){const m=Math.hypot(this.r,this.i)**0.5,a=Math.atan2(this.i,this.r)/2;return new C(m*Math.cos(a),m*Math.sin(a));}cbrt(){const m=Math.hypot(this.r,this.i)**(1/3),a=Math.atan2(this.i,this.r)/3;return new C(m*Math.cos(a),m*Math.sin(a));}nthRoot(n){const m=Math.hypot(this.r,this.i)**(1/n),a=Math.atan2(this.i,this.r)/n;return new C(m*Math.cos(a),m*Math.sin(a));}isReal(tol=1e-6){return Math.abs(this.i)<=tol;}}
const CCONSTS={pi:new C(Math.PI),e:new C(Math.E),phi:new C((1+Math.sqrt(5))/2),tau:new C(Math.PI*2),sqrt2:new C(Math.SQRT2),i:new C(0,1)};
function lambertW(x){if(x<-1/Math.E)return NaN;let w=x<1?x:Math.log(x);for(let i=0;i<100;i++){const ew=Math.exp(w),f=w*ew-x,df=ew*(w+1);const dw=f/(df-(w+2)*f/(2*(w+1)));w-=dw;if(Math.abs(dw)<1e-12)break;}return w;}
const CFUNCS={floor:v=>new C(Math.floor(v.r)),ceil:v=>new C(Math.ceil(v.r)),round:v=>new C(Math.round(v.r)),abs:v=>new C(Math.hypot(v.r,v.i)),ln:v=>new C(Math.log(v.r)),log:v=>new C(Math.log10(v.r)),log2:v=>new C(Math.log2(v.r)),log10:v=>new C(Math.log10(v.r)),exp:v=>new C(Math.exp(v.r)),sin:v=>new C(Math.sin(v.r)),cos:v=>new C(Math.cos(v.r)),tan:v=>new C(Math.tan(v.r)),asin:v=>new C(Math.asin(v.r)),acos:v=>new C(Math.acos(v.r)),atan:v=>new C(Math.atan(v.r)),sinh:v=>new C(Math.sinh(v.r)),cosh:v=>new C(Math.cosh(v.r)),tanh:v=>new C(Math.tanh(v.r)),arcsin:v=>new C(Math.asin(v.r)),arccos:v=>new C(Math.acos(v.r)),arctan:v=>new C(Math.atan(v.r)),lambertw:v=>new C(lambertW(v.r)),lw:v=>new C(lambertW(v.r)),w:v=>new C(lambertW(v.r))};
const CONSTS={phi:(1+Math.sqrt(5))/2,pi:Math.PI,e:Math.E,tau:Math.PI*2,sqrt2:Math.SQRT2};
function factorial(v){if(!v.isReal())return new C(NaN,NaN);const n=v.r;if(n<0||Math.abs(n-Math.round(n))>1e-9)return new C(NaN,NaN);const r=Math.round(n);if(r>170)return new C(Infinity,0);let result=1;for(let i=2;i<=r;i++)result*=i;return new C(result,0);}
function safeMath(expr){
    let s=expr.trim(),norm='';
    for(let k=0;k<s.length;k++){if(SUP[s[k]]!==undefined){let sup='';while(k<s.length&&SUP[s[k]]!==undefined)sup+=SUP[s[k++]];norm+='^'+sup;k--;}else norm+=s[k];}
    s=norm.replace(/[\u00d7\u00b7\u2022]/g,'*').replace(/\u00f7/g,'/').replace(/\u2212/g,'-').replace(/\s+/g,'').toLowerCase();
    s=s.replace(/(?<=[\d)])x(?=[\d(])/g,'*').replace(/\*\*/g,'^').replace(/(\d+)\u221a/g,(_,n)=>`nrt${n}(`).replace(/\u221c/g,'nrt4(').replace(/\u221b/g,'cbrt(').replace(/\u221a/g,'sqrt(');
    if(/[+\-]{2,}/.test(s))return null;
    let tokens=[],k=0;
    while(k<s.length){if(/\d/.test(s[k])||s[k]==='.'){let n='';while(k<s.length&&(/\d/.test(s[k])||s[k]==='.')){ n+=s[k++];}tokens.push({t:'n',v:parseFloat(n)});}else if(/[a-z]/.test(s[k])){let id='';while(k<s.length&&/[a-z0-9]/.test(s[k]))id+=s[k++];tokens.push({t:'id',v:id});}else if('+-*/^(),!'.includes(s[k])){tokens.push({t:'op',v:s[k++]});}else k++;}
    const FUNCS=new Set(['sqrt','cbrt','floor','ceil','round','abs','ln','log','log2','log10','exp','sin','cos','tan','asin','acos','atan','arcsin','arccos','arctan','sinh','cosh','tanh','lambertw','lw','w','pow']);
    const isFunc=v=>FUNCS.has(v)||/^nrt\d+$/.test(v);
    const out=[];
    for(let j=0;j<tokens.length;j++){out.push(tokens[j]);const cur=tokens[j],nxt=tokens[j+1];if(!nxt)continue;const lOk=cur.t==='n'||(cur.t==='id'&&!isFunc(cur.v))||(cur.t==='op'&&(cur.v===')'||cur.v==='!'));const rOk=nxt.t==='n'||nxt.t==='id'||(nxt.t==='op'&&nxt.v==='(');const fc=nxt.t==='op'&&nxt.v==='('&&cur.t==='id'&&isFunc(cur.v);if(lOk&&rOk&&!fc)out.push({t:'op',v:'*'});}
    tokens=out;let pos=0;const peek=()=>tokens[pos],consume=()=>tokens[pos++];
    function parseExpr(){let l=parseTerm();while(peek()&&(peek().v==='+'||peek().v==='-')){const op=consume().v;const r=parseTerm();l=op==='+'?l.add(r):l.sub(r);}return l;}
    function parseTerm(){let l=parsePow();while(peek()&&(peek().v==='*'||peek().v==='/')){const op=consume().v;const r=parsePow();l=op==='*'?l.mul(r):l.div(r);}return l;}
    function parsePow(){const b=parseUnary();if(peek()&&peek().v==='^'){consume();return b.pow(parsePow());}return b;}
    function parseUnary(){if(peek()&&peek().v==='-'){consume();return parseUnary().neg();}if(peek()&&peek().v==='+'){consume();return parseUnary();}return parsePostfix();}
    function parsePostfix(){let v=parseAtom();while(peek()&&peek().v==='!'){consume();v=factorial(v);}return v;}
    function parseAtom(){const tok=peek();if(!tok)throw new Error('unexpected end');if(tok.t==='n'){consume();return new C(tok.v,0);}if(tok.t==='id'){consume();if(peek()&&peek().v==='('){consume();const arg=parseExpr();const arg2=peek()&&peek().v===','?(consume(),parseExpr()):null;if(peek()&&peek().v===')')consume();if(tok.v==='pow'){if(arg2===null)throw new Error('pow requires 2 args');return arg.pow(arg2);}if(tok.v==='sqrt')return arg2===null?arg.sqrt():arg.nthRoot(arg2.r);if(tok.v==='cbrt')return arg.cbrt();if(CFUNCS[tok.v])return CFUNCS[tok.v](arg);if(/^nrt(\d+)$/.test(tok.v))return arg.nthRoot(parseInt(tok.v.slice(3)));throw new Error('unknown fn: '+tok.v);}if(CCONSTS[tok.v])return CCONSTS[tok.v];throw new Error('unknown id: '+tok.v);}if(tok.t==='op'&&tok.v==='('){consume();const val=parseExpr();if(peek()&&peek().v===')')consume();return val;}throw new Error('unexpected: '+JSON.stringify(tok));}
    try{const res=parseExpr();if(!res.isReal()||!isFinite(res.r)||isNaN(res.r))return null;const r=Math.round(res.r);return Math.abs(r)>10_000_000?null:r;}catch{return null;}
}

function generateExpressions(n){
    const cands=[],phi=(1+Math.sqrt(5))/2;
    const cs=[['phi',phi],['pi',Math.PI],['e',Math.E],['sqrt2',Math.SQRT2],['tau',Math.PI*2]];
    for(let b=2;b<=50;b++)for(let x=2;x<=8;x++)if(Math.pow(b,x)===n)cands.push(`${b}^${x}`);
    for(const[nm,v]of cs){for(let x=1;x<=20;x++)if(Math.round(Math.pow(v,x))===n){cands.push(`${nm}^${x}`);break;}for(let x=1;x<=10;x++){const b=Math.round(Math.pow(v,x)),d=n-b;if(d!==0&&Math.abs(d)<=20)cands.push(`${nm}^${x}${d>0?'+'+d:d}`);}}
    if(n>4)for(let a=2;a<=Math.sqrt(n);a++)if(n%a===0){cands.push(`${a}*${n/a}`);break;}
    if(n>8){outer:for(let a=2;a<=Math.cbrt(n);a++)if(n%a===0){const r=n/a;for(let b=a;b<=Math.sqrt(r);b++)if(r%b===0){cands.push(`${a}*${b}*${r/b}`);break outer;}}}
    if(n>2){const a=Math.max(1,Math.floor(n*0.35));cands.push(`${a}+${n-a}`);}
    cands.push(`${n+Math.round(n*0.6)+1}-${Math.round(n*0.6)+1}`,`${n*(n<=10?2:3)}/${n<=10?2:3}`);
    if(n>5)for(let a=2;a<=10;a++){const base=Math.floor(n/a)*a,d=n-base;if(base>0&&d>0&&d<a){cands.push(`${a}*${Math.floor(n/a)}+${d}`);break;}}
    const seen=new Set(),res=[];
    for(const c of cands.sort((a,b)=>(/[a-z]/.test(b)?1:0)-(/[a-z]/.test(a)?1:0)||a.length-b.length))if(!seen.has(c)&&res.length<3){seen.add(c);res.push(c);}
    if(res.length<3)res.push(`${n-1}+1`);if(res.length<3)res.push(`${n*2}/2`);if(res.length<3)res.push(`${n+3}-3`);
    return res.slice(0,3);
}

module.exports = { safeMath, generateExpressions, CONSTS };
