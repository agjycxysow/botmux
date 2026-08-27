import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  LogisticsConversationStore,
  type LogisticsConversationFilters,
} from '../services/logistics-conversation-store.js';

export interface LogisticsAnalyticsServerOptions {
  dataDir: string;
  databasePath?: string;
  host?: string;
  port?: number;
  accessToken?: string;
}

function escapeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const content = escapeJson(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(content),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(content);
}

function filters(url: URL): LogisticsConversationFilters {
  const needsReview = url.searchParams.get('needsReview');
  return {
    from: url.searchParams.get('from') ?? undefined,
    to: url.searchParams.get('to') ?? undefined,
    larkAppId: url.searchParams.get('bot') ?? undefined,
    businessCategory: url.searchParams.get('lb') ?? undefined,
    problemType: url.searchParams.get('lp') ?? undefined,
    resolutionStatus: url.searchParams.get('resolution') ?? undefined,
    dataStatus: (url.searchParams.get('dataStatus') as LogisticsConversationFilters['dataStatus']) ?? undefined,
    ...(needsReview === 'true' || needsReview === 'false'
      ? { needsReview: needsReview === 'true' } : {}),
  };
}

function safeEqual(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest();
  const b = createHash('sha256').update(right).digest();
  return timingSafeEqual(a, b);
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function authorized(req: IncomingMessage, url: URL, token: string | undefined): boolean {
  if (!token) return true;
  const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  return safeEqual(bearer || (cookies(req).botmux_analytics ?? ''), token)
    || safeEqual(url.searchParams.get('t') ?? '', token);
}

function exchangeQueryToken(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (!url.searchParams.has('t')) return false;
  const token = url.searchParams.get('t') ?? '';
  url.searchParams.delete('t');
  const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '').toLowerCase();
  const secure = forwardedProto === 'https' || Boolean((req.socket as { encrypted?: boolean }).encrypted);
  res.writeHead(302, {
    location: `${url.pathname}${url.search}`,
    'set-cookie': `botmux_analytics=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure ? '; Secure' : ''}`,
    'cache-control': 'no-store',
  });
  res.end();
  return true;
}

function html(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>物流专家 · 数据概览</title><style>
:root{font-family:Inter,"Noto Sans SC","Microsoft YaHei",sans-serif;color:#162033;background:#f4f7fb}*{box-sizing:border-box}body{margin:0}.shell{max-width:1440px;margin:auto;padding:28px}.head{display:flex;justify-content:space-between;align-items:end;gap:20px}.head h1{margin:0;font-size:30px}.muted{color:#74819a}.filters,.card,.panel{background:#fff;border:1px solid #dfe6f1;border-radius:16px;box-shadow:0 5px 18px #24345a10}.filters{display:grid;grid-template-columns:repeat(8,minmax(120px,1fr));gap:10px;padding:16px;margin:22px 0}.filters input,.filters select,.filters button{height:40px;border:1px solid #d8e0ed;border-radius:10px;background:#f7f9fc;padding:0 12px}.filters button{background:#315bd8;color:#fff;border:0;font-weight:700;cursor:pointer}.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.card{padding:20px}.card b{display:block;font-size:32px;margin-top:10px}.grid{display:grid;grid-template-columns:2fr 1fr;gap:14px;margin-top:14px}.panel{padding:20px;min-height:280px}.panel h2{margin:0 0 16px}.trend{display:flex;align-items:end;gap:10px;height:190px;border-bottom:1px solid #dfe6f1;padding:0 8px}.bar-col{flex:1;min-width:20px;text-align:center}.bar{background:#9eb5f7;border-radius:8px 8px 0 0;min-height:2px}.bar-col small{font-size:11px;color:#75839d}.dist-row{display:grid;grid-template-columns:130px 1fr 40px;gap:8px;align-items:center;margin:12px 0}.dist-bar{height:14px;border-radius:7px;background:#4469dc}.sessions{margin-top:14px}.table-wrap{overflow:auto}.sessions table{width:100%;border-collapse:collapse}.sessions th,.sessions td{text-align:left;padding:13px 10px;border-bottom:1px solid #e7ecf4;white-space:nowrap}.tag{padding:4px 9px;border-radius:999px;background:#edf2ff;color:#315bd8;font-size:12px}.tag.review{background:#fff1d6;color:#985f00}.link{color:#315bd8;cursor:pointer;font-weight:700}.error{color:#b42318;background:#fff0ee;padding:12px;border-radius:10px;display:none}dialog{border:0;border-radius:16px;max-width:900px;width:90%;padding:0;box-shadow:0 18px 60px #0004}dialog::backdrop{background:#16203388}.dialog-head{display:flex;justify-content:space-between;padding:18px 22px;border-bottom:1px solid #e4e9f1}.dialog-body{padding:20px;max-height:70vh;overflow:auto}.msg{padding:12px;border-radius:12px;margin:8px 0;background:#f5f7fb}.msg.assistant{background:#edf3ff}.close{border:0;background:#eef2f7;border-radius:8px;padding:7px 10px;cursor:pointer}@media(max-width:900px){.filters{grid-template-columns:repeat(2,1fr)}.kpis{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}.shell{padding:16px}}
</style></head><body><main class="shell">
<div class="head"><div><h1>物流专家 · 数据概览</h1><div class="muted">BotMux 会话 SQLite · LB/LP · 自动解决状态</div></div><div class="muted" id="updated"></div></div>
<form class="filters" id="filters"><input type="date" name="from"><input type="date" name="to"><input name="bot" placeholder="Bot App ID"><select name="lb"><option value="">全部 LB</option></select><select name="lp"><option value="">全部 LP</option></select><select name="resolution"><option value="">全部解决状态</option><option>resolved</option><option>in_progress</option><option>unknown</option></select><select name="dataStatus"><option value="">全部数据状态</option><option value="pending">待回溯</option><option value="processing">回溯中</option><option value="missing_turn">缺少用户问题</option><option value="missing_answer">缺少最终回答</option><option value="history_failed">历史读取失败</option><option value="snapshot_ready">已生成快照</option><option value="labeled">已打标</option><option value="label_failed">打标失败</option><option value="skipped">特殊会话</option></select><select name="needsReview"><option value="">全部复核</option><option value="true">待复核</option><option value="false">无需复核</option></select><button>查询</button></form>
<div class="error" id="error"></div><section class="kpis" id="kpis"></section>
<section class="grid"><div class="panel"><h2>会话量与解决率趋势</h2><div class="trend" id="trend"></div></div><div class="panel"><h2>业务分类分布</h2><div id="business"></div></div></section>
<section class="panel sessions"><h2>会话明细</h2><div class="table-wrap"><table><thead><tr><th>会话</th><th>Bot</th><th>数据状态</th><th>标签</th><th>解决状态</th><th>评分</th><th>更新时间</th><th></th></tr></thead><tbody id="sessions"></tbody></table></div></section>
<dialog id="detail"><div class="dialog-head"><b id="detail-title">会话详情</b><button class="close" onclick="document.getElementById('detail').close()">关闭</button></div><div class="dialog-body" id="detail-body"></div></dialog>
</main><script>
const $=s=>document.querySelector(s), esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const params=new URLSearchParams(location.search); const form=$('#filters'); for(const [k,v] of params) if(form.elements[k]) form.elements[k].value=v;
if(!params.has('from')){const d=new Date(Date.now()-29*864e5); form.from.value=d.toISOString().slice(0,10)} if(!params.has('to'))form.to.value=new Date().toISOString().slice(0,10);
for(let i=1;i<=6;i++)form.lb.add(new Option('LB0'+i,'LB0'+i)); form.lb.add(new Option('LB99','LB99')); for(let i=1;i<=7;i++)form.lp.add(new Option('LP0'+i,'LP0'+i)); form.lp.add(new Option('LP99','LP99'));
function query(){const q=new URLSearchParams(new FormData(form));for(const[k,v]of[...q])if(!v)q.delete(k);return q} async function api(path,q=query()){const r=await fetch(path+'?'+q);if(!r.ok)throw new Error(await r.text());return r.json()}
function num(n){return new Intl.NumberFormat().format(n??0)} function pct(n){return ((n??0)*100).toFixed(1)+'%'} function time(n){return n?new Date(n).toLocaleString():'-'}
async function load(){try{$('#error').style.display='none';const q=query();history.replaceState(null,'','/overview?'+q);const [o,t,d,s]=await Promise.all([api('/api/overview',q),api('/api/trend',q),api('/api/distributions',q),api('/api/sessions',q)]);$('#updated').textContent='刷新于 '+new Date().toLocaleTimeString();const cards=[['总 Session',num(o.totalSessions)],['可分析会话',num(o.conversations)],['已生成快照',num(o.snapshotted)],['已打标',num(o.labeled)],['分析覆盖率',pct(o.analysisCoverage)],['打标覆盖率',pct(o.labelCoverage)],['回溯失败',num(o.failedBackfill)],['待人工复核',num(o.needsReview)],['问卷记录',num(o.surveyRecords)],['已回答问卷',num(o.answeredSurveys)],['自动解决率',pct(o.resolutionRate)],['平均满意度',o.averageRating??'-']];$('#kpis').innerHTML=cards.map(x=>'<div class="card"><span class="muted">'+x[0]+'</span><b>'+x[1]+'</b></div>').join('');const max=Math.max(1,...t.map(x=>x.totalSessions));$('#trend').innerHTML=t.map(x=>'<div class="bar-col"><div class="muted">'+pct(x.resolutionRate)+'</div><div class="bar" style="height:'+Math.max(2,x.totalSessions/max*135)+'px"></div><small>'+esc(x.day.slice(5))+'<br>'+x.conversations+'/'+x.totalSessions+'</small></div>').join('');const bm=Math.max(1,...d.business.map(x=>x.count));$('#business').innerHTML=d.business.map(x=>'<div class="dist-row"><span>'+esc(x.key)+'</span><i class="dist-bar" style="width:'+x.count/bm*100+'%"></i><b>'+x.count+'</b></div>').join('');$('#sessions').innerHTML=s.items.map(x=>'<tr><td>'+esc(x.title||x.sessionPublicId.slice(0,12))+'</td><td>'+esc(x.larkAppId)+'</td><td><span class="tag '+((x.dataStatus||'').includes('failed')?'review':'')+'">'+esc(x.dataStatus)+'</span></td><td><span class="tag">'+esc((x.businessCategory||'-')+' · '+(x.problemType||'-'))+'</span></td><td><span class="tag '+(x.needsReview?'review':'')+'">'+esc(x.resolutionStatus||x.taggingState)+'</span></td><td>'+esc(x.rating??'-')+'</td><td>'+time(x.updatedAt)+'</td><td>'+(x.conversationId?'<span class="link" data-key="'+esc(x.conversationId)+'">详情</span>':'-')+'</td></tr>').join('');document.querySelectorAll('[data-key]').forEach(el=>el.onclick=()=>show(el.dataset.key));}catch(e){$('#error').textContent=e.message;$('#error').style.display='block'}}
async function show(key){try{const x=await api('/api/sessions/'+encodeURIComponent(key),new URLSearchParams());$('#detail-title').textContent=x.title||x.sessionPublicId;$('#detail-body').innerHTML='<p><b>标签：</b>'+esc((x.businessCategory||'-')+' / '+(x.problemType||'-')+' / '+(x.resolutionStatus||'-'))+'</p><p><b>Harness：</b>'+esc(x.harnessRevision||'-')+'　<b>复核：</b>'+esc(x.manualReviewStatus)+'</p><p><b>原因：</b>'+esc(x.reviewReason||'-')+'</p>'+x.messages.map(m=>'<div class="msg '+m.role+'"><b>'+(m.role==='user'?'用户':'助手')+'</b><div>'+esc(m.content)+'</div></div>').join('');detail.showModal()}catch(e){alert(e.message)}}
form.onsubmit=e=>{e.preventDefault();load()};load();
</script></body></html>`;
}

function unauthorized(res: ServerResponse): void {
  res.writeHead(401, {
    'content-type': 'text/plain; charset=utf-8',
    'www-authenticate': 'Bearer realm="botmux-analytics"',
    'cache-control': 'no-store',
  });
  res.end('unauthorized');
}

export function createLogisticsAnalyticsServer(options: LogisticsAnalyticsServerOptions) {
  const path = options.databasePath ?? join(options.dataDir, 'botmux-conversations.sqlite');
  if (!existsSync(path)) throw new Error(`analytics_database_missing:${path}`);
  const store = new LogisticsConversationStore({ dataDir: options.dataDir, path, readOnly: true });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!authorized(req, url, options.accessToken)) return unauthorized(res);
    if (options.accessToken && exchangeQueryToken(req, res, url)) return;
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') return sendJson(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/api/overview') return sendJson(res, 200, store.summary(filters(url)));
      if (req.method === 'GET' && url.pathname === '/api/trend') return sendJson(res, 200, store.trend(filters(url)));
      if (req.method === 'GET' && url.pathname === '/api/distributions') return sendJson(res, 200, store.distributions(filters(url)));
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        return sendJson(res, 200, store.list(filters(url), { limit, offset }));
      }
      const detail = url.pathname.match(/^\/api\/sessions\/(.+)$/);
      if (req.method === 'GET' && detail) {
        const item = store.detail(decodeURIComponent(detail[1]!));
        return item ? sendJson(res, 200, item) : sendJson(res, 404, { error: 'not_found' });
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/overview')) {
        const body = html();
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(body),
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
          'x-content-type-options': 'nosniff',
          'x-frame-options': 'DENY',
          'referrer-policy': 'no-referrer',
        });
        return res.end(body);
      }
      sendJson(res, 404, { error: 'not_found' });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.on('close', () => store.close());
  return server;
}

function arg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index >= 0) return args[index + 1];
  return args.find(item => item.startsWith(`${flag}=`))?.slice(flag.length + 1);
}

export async function runLogisticsAnalyticsCommand(sub: string, args: string[], dataDir: string): Promise<void> {
  if (sub !== 'serve') {
    console.error('Usage: botmux analytics serve [--host 127.0.0.1] [--port 17870] [--db <path>]');
    process.exit(2);
  }
  const host = arg(args, '--host') ?? process.env.BOTMUX_ANALYTICS_HOST ?? '127.0.0.1';
  const port = Number(arg(args, '--port') ?? process.env.BOTMUX_ANALYTICS_PORT ?? 17870);
  const databasePath = resolve(arg(args, '--db') ?? process.env.BOTMUX_ANALYTICS_DB ?? join(dataDir, 'botmux-conversations.sqlite'));
  const accessToken = process.env.BOTMUX_ANALYTICS_TOKEN?.trim() || undefined;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid_analytics_port:${port}`);
  if (host !== '127.0.0.1' && host !== '::1' && !accessToken) {
    throw new Error('BOTMUX_ANALYTICS_TOKEN is required when binding beyond loopback');
  }
  const server = createLogisticsAnalyticsServer({ dataDir, databasePath, host, port, accessToken });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      console.log(`BotMux logistics analytics listening on http://${host}:${port}/overview`);
      resolvePromise();
    });
  });
  const stop = () => server.close(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await new Promise(() => {});
}
