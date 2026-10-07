const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT || 3000);
const MEMPOOL_API_BASE = (process.env.MEMPOOL_API_BASE || 'https://mempool.space/api').replace(/\/$/, '');

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'});
  res.end(data);
}

function riskFromIndicators(indicators) {
  const score = indicators.reduce((n, x) => n + (x.weight || 0), 0);
  if (score >= 6) return 'High';
  if (score >= 3) return 'Moderate';
  return 'Low';
}

function analyzeUrl(raw) {
  const indicators = [];
  const facts = [];
  let u;
  try { u = new URL(raw); } catch { return { error: 'Enter a valid URL, including https:// or http://.' }; }
  if (!['http:', 'https:'].includes(u.protocol)) return { error: 'Only HTTP/HTTPS URLs are supported.' };
  facts.push(`Protocol: ${u.protocol.replace(':','').toUpperCase()}`);
  facts.push(`Hostname: ${u.hostname}`);
  if (u.protocol !== 'https:') indicators.push({title:'No HTTPS', detail:'The URL does not use HTTPS.', weight:2});
  if (u.hostname.includes('xn--')) indicators.push({title:'Punycode hostname', detail:'The hostname contains xn--, which can be used for internationalized domain names and look-alike domains.', weight:2});
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname)) indicators.push({title:'IP-address URL', detail:'The URL uses a numeric IP address instead of a conventional domain.', weight:2});
  const text = `${u.hostname}${u.pathname}${u.search}`.toLowerCase();
  const terms = [
    ['guaranteed returns|guaranteed profit|risk-free', 'Guaranteed-return language', 3],
    ['withdrawal fee|unlock fee|release fee|tax to withdraw', 'Withdrawal/unlock fee language', 3],
    ['double your|100% profit|instant profit', 'Aggressive profit claim', 2],
    ['seed phrase|private key|recovery phrase', 'Credential/seed-phrase language', 4]
  ];
  for (const [pattern,title,weight] of terms) if (new RegExp(pattern).test(text)) indicators.push({title, detail:'The URL contains a term associated with elevated crypto-fraud risk.', weight});
  if (u.hostname.split('.').length > 3) indicators.push({title:'Unusually deep hostname', detail:'The hostname has multiple subdomain levels.', weight:1});
  return { input: raw, normalized: u.href, facts, indicators, risk: riskFromIndicators(indicators), limitations:['URL heuristics are not proof of fraud.','This check does not establish ownership or intent.','No private credentials should ever be entered into this service.'] };
}

async function mempool(pathname) {
  const r = await fetch(`${MEMPOOL_API_BASE}${pathname}`, {headers:{'Accept':'application/json'}, signal:AbortSignal.timeout(10000)});
  if (!r.ok) throw new Error(`Mempool API returned HTTP ${r.status}`);
  return await r.json();
}

async function checkBitcoin(type, value) {
  if (!value || typeof value !== 'string') throw new Error('Missing Bitcoin value.');
  if (type === 'address') {
    const data = await mempool(`/address/${encodeURIComponent(value)}`);
    const txCount = (data.chain_stats?.tx_count || 0) + (data.mempool_stats?.tx_count || 0);
    return {type, value, source:'Mempool', observed:{tx_count:txCount, chain_stats:data.chain_stats, mempool_stats:data.mempool_stats}, risk:'Low', indicators:[], limitations:['Blockchain activity alone does not prove legitimacy or fraud.','A low-risk result is not a safety guarantee.']};
  }
  if (type === 'transaction') {
    const data = await mempool(`/tx/${encodeURIComponent(value)}`);
    return {type, value, source:'Mempool', observed:{txid:data.txid, status:data.status, fee:data.fee, size:data.size, weight:data.weight, vin_count:data.vin?.length, vout_count:data.vout?.length}, risk:'Low', indicators:[], limitations:['Transaction confirmation and structure do not prove the recipient is legitimate.','A low-risk result is not a safety guarantee.']};
  }
  throw new Error('Unsupported Bitcoin check type.');
}

async function body(req) {
  let s=''; for await (const chunk of req) { s += chunk; if (s.length > 100000) throw new Error('Request too large.'); }
  return JSON.parse(s || '{}');
}

async function api(req,res) {
  try {
    if (req.method === 'POST' && req.url === '/api/website-check') return json(res,200,analyzeUrl((await body(req)).url));
    if (req.method === 'POST' && req.url === '/api/bitcoin-check') {
      const b=await body(req); return json(res,200,await checkBitcoin(b.type,b.value));
    }
    if (req.method === 'POST' && req.url === '/api/combined-report') {
      const b=await body(req); const report={created_at:new Date().toISOString(), inputs:{website:b.url||null,address:b.address||null,transaction:b.transaction||null}, website:null,address:null,transaction:null, errors:[]};
      if (b.url) report.website=analyzeUrl(b.url);
      for (const [key,type] of [['address','address'],['transaction','transaction']]) if (b[key]) { try { report[key]=await checkBitcoin(type,b[key]); } catch(e){ report.errors.push({item:key,message:e.message}); } }
      const risks=[report.website?.risk,report.address?.risk,report.transaction?.risk].filter(Boolean);
      report.overall_risk=risks.includes('High')?'High':risks.includes('Moderate')?'Moderate':'Low';
      report.disclaimer='Risk indicators are informational and may be incomplete or inaccurate. This report is not proof of fraud, ownership, criminal conduct, or safety.';
      return json(res,200,report);
    }
    if (req.method === 'GET' && req.url === '/api/health') return json(res,200,{ok:true,time:new Date().toISOString(),mempool_api_base:MEMPOOL_API_BASE});
    return json(res,404,{error:'Not found'});
  } catch(e) { return json(res,400,{error:e.message || 'Request failed'}); }
}

const server=http.createServer((req,res)=>{
  if (req.url.startsWith('/api/')) return api(req,res);
  let file=req.url==='/'?'/index.html':req.url;
  const filePath=path.join(__dirname,'public',path.normalize(file).replace(/^([.][.][/\\])+/,''));
  if (!filePath.startsWith(path.join(__dirname,'public'))) return json(res,403,{error:'Forbidden'});
  fs.readFile(filePath,(err,data)=>{ if(err){res.writeHead(404);return res.end('Not found');} const ext=path.extname(filePath); const type=ext==='.html'?'text/html':ext==='.js'?'text/javascript':'text/css'; res.writeHead(200,{'Content-Type':`${type}; charset=utf-8`}); res.end(data); });
});
server.listen(PORT,()=>console.log(`Check Before You Send running on http://localhost:${PORT}`));
