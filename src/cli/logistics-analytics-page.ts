export function renderLogisticsAnalyticsPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>物流专家 · 会话概览</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #15243a;
      --muted: #65748b;
      --line: #dce4ef;
      --surface: #ffffff;
      --canvas: #f3f6fb;
      --brand: #2f63d8;
      --brand-soft: #eaf0ff;
      --warning: #a86100;
      --warning-soft: #fff4dc;
      --danger: #b42318;
      --danger-soft: #fff0ee;
      --success: #18794e;
      --success-soft: #e8f7ef;
      font-family: Inter, "Noto Sans SC", "Microsoft YaHei", sans-serif;
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--canvas); color: var(--ink); }
    button, input, select { font: inherit; }
    button { cursor: pointer; }
    .shell { width: min(1480px, 100%); margin: 0 auto; padding: 28px; }
    .page-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
    .eyebrow { margin: 0 0 8px; color: var(--brand); font-size: 12px; font-weight: 800; letter-spacing: .08em; }
    h1 { margin: 0; font-size: clamp(26px, 4vw, 38px); letter-spacing: -.03em; }
    h2 { margin: 0; font-size: 18px; }
    .subtitle { margin: 10px 0 0; color: var(--muted); }
    .run-summary { min-width: 310px; padding: 16px 18px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); box-shadow: 0 8px 24px #1f3a6610; }
    .run-summary strong { display: block; margin-bottom: 8px; }
    .run-summary p { margin: 5px 0; color: var(--muted); font-size: 13px; }
    .run-summary .stale { color: var(--warning); font-weight: 700; }
    .run-summary .unavailable { color: var(--danger); font-weight: 700; }
    .filters, .panel, .metric { border: 1px solid var(--line); border-radius: 14px; background: var(--surface); box-shadow: 0 8px 24px #1f3a660b; }
    .filters { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin: 24px 0 14px; padding: 16px; }
    .field { display: grid; gap: 6px; min-width: 0; }
    .field span { color: var(--muted); font-size: 12px; font-weight: 700; }
    .field input, .field select { width: 100%; height: 38px; padding: 0 10px; border: 1px solid var(--line); border-radius: 9px; color: var(--ink); background: #fbfcff; }
    .filter-actions { display: flex; align-items: end; gap: 8px; }
    .primary, .secondary { min-height: 38px; border-radius: 9px; padding: 0 14px; font-weight: 800; }
    .primary { border: 0; color: #fff; background: var(--brand); }
    .secondary { border: 1px solid var(--line); color: var(--ink); background: #fff; }
    .state { min-height: 0; margin: 12px 0; padding: 0; color: var(--muted); }
    .state.visible { padding: 12px 14px; border-radius: 10px; background: #eef3fb; }
    .state.error { color: var(--danger); background: var(--danger-soft); }
    .state.empty { color: var(--muted); background: #eef3fb; }
    .metrics { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
    .metric { min-height: 104px; padding: 16px; }
    .metric .label { color: var(--muted); font-size: 13px; }
    .metric .value { display: block; margin-top: 12px; font-size: 27px; letter-spacing: -.03em; }
    .metric .detail { display: block; margin-top: 5px; color: var(--muted); font-size: 12px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 14px; }
    .panel { min-width: 0; padding: 20px; }
    .panel-header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 16px; }
    .panel-header span { color: var(--muted); font-size: 12px; }
    .distribution { display: grid; gap: 10px; }
    .distribution-item { display: grid; grid-template-columns: minmax(140px, 1.2fr) minmax(80px, 2fr) 48px; gap: 10px; align-items: center; width: 100%; padding: 0; border: 0; color: var(--ink); background: transparent; text-align: left; }
    .distribution-item:hover .distribution-label { color: var(--brand); }
    .distribution-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .distribution-track { height: 12px; overflow: hidden; border-radius: 999px; background: #edf1f7; }
    .distribution-bar { height: 100%; min-width: 2px; border-radius: inherit; background: var(--brand); }
    .distribution-count { color: var(--muted); text-align: right; font-variant-numeric: tabular-nums; }
    .trend { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(94px, 1fr); gap: 10px; min-height: 230px; overflow-x: auto; align-items: end; padding: 14px 2px 0; border-bottom: 1px solid var(--line); }
    .trend-item { display: grid; grid-template-rows: 24px 150px auto; gap: 6px; align-items: end; min-width: 86px; text-align: center; }
    .trend-count { color: var(--muted); font-size: 11px; }
    .trend-bars { display: flex; align-items: end; justify-content: center; gap: 3px; height: 150px; }
    .trend-bar { width: 13px; min-height: 2px; border-radius: 5px 5px 0 0; }
    .trend-bar.total { background: #9db7f7; }
    .trend-bar.captured { background: #4b82e9; }
    .trend-bar.labeled { background: #2e9d70; }
    .trend-day { color: var(--muted); font-size: 11px; white-space: nowrap; }
    .table-panel { margin-top: 14px; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; min-width: 930px; }
    th, td { padding: 12px 10px; border-bottom: 1px solid #e8edf4; text-align: left; vertical-align: middle; white-space: nowrap; }
    th { color: var(--muted); font-size: 12px; font-weight: 800; }
    td { font-size: 13px; }
    .topic-title { max-width: 240px; overflow: hidden; text-overflow: ellipsis; }
    .bot-name { font-weight: 700; }
    .tag { display: inline-flex; align-items: center; min-height: 26px; padding: 3px 9px; border-radius: 999px; color: var(--brand); background: var(--brand-soft); font-size: 12px; }
    .tag.warning { color: var(--warning); background: var(--warning-soft); }
    .tag.danger { color: var(--danger); background: var(--danger-soft); }
    .tag.success { color: var(--success); background: var(--success-soft); }
    .detail-button { border: 0; color: var(--brand); background: transparent; font-weight: 800; }
    .pagination { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 16px; }
    .pagination-info { color: var(--muted); font-size: 13px; }
    .pagination-actions { display: flex; gap: 8px; }
    .pagination button:disabled { cursor: not-allowed; opacity: .45; }
    dialog { width: min(860px, calc(100vw - 28px)); max-height: 82vh; padding: 0; border: 0; border-radius: 16px; color: var(--ink); box-shadow: 0 24px 80px #14233d44; }
    dialog::backdrop { background: #14233d88; }
    .dialog-header { display: flex; justify-content: space-between; gap: 12px; padding: 18px 22px; border-bottom: 1px solid var(--line); }
    .dialog-header button { border: 1px solid var(--line); border-radius: 8px; padding: 5px 10px; color: var(--ink); background: #fff; }
    .dialog-body { max-height: calc(82vh - 70px); overflow: auto; padding: 20px 22px; }
    .detail-tags { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; }
    .messages { display: grid; gap: 10px; }
    .message { padding: 12px 14px; border-radius: 10px; background: #f3f6fb; }
    .message.assistant { background: #edf3ff; }
    .message-meta { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 7px; color: var(--muted); font-size: 12px; }
    .message-content { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.6; }
    @media (max-width: 1100px) {
      .filters { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }
    @media (max-width: 760px) {
      .shell { padding: 16px; }
      .page-header { display: grid; }
      .run-summary { min-width: 0; }
      .filters, .metrics, .grid { grid-template-columns: 1fr 1fr; }
      .filter-actions { align-items: stretch; }
      .filter-actions button { flex: 1; }
    }
    @media (max-width: 480px) {
      .filters, .metrics, .grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="page-header">
      <div>
        <p class="eyebrow">READ-ONLY ANALYTICS</p>
        <h1>物流专家 · 会话概览</h1>
        <p class="subtitle">按根话题主要目标统计；当前口径固定为六类，未知状态保留在解决率分母。</p>
      </div>
      <section class="run-summary" aria-live="polite" id="run-summary">
        <strong>调度状态</strong>
        <p id="run-state">加载中…</p>
        <p id="run-times"></p>
      </section>
    </header>

    <form class="filters" id="filters">
      <label class="field"><span>开始日期</span><input type="date" name="from"></label>
      <label class="field"><span>结束日期（含当天）</span><input type="date" name="to"></label>
      <label class="field"><span>Bot</span><input name="bot" placeholder="可选 Bot"></label>
      <label class="field"><span>LB</span><select name="lb"><option value="">全部 LB</option></select></label>
      <label class="field"><span>LP</span><select name="lp"><option value="">全部 LP</option></select></label>
      <label class="field"><span>解决状态</span><select name="resolution"><option value="">全部状态</option></select></label>
      <label class="field"><span>采集状态</span><select name="dataStatus"><option value="">全部采集状态</option></select></label>
      <label class="field"><span>标签处理状态</span><select name="labelStatus"><option value="">全部标签状态</option></select></label>
      <label class="field"><span>待复核</span><select name="needsReview"><option value="">全部</option><option value="true">待复核</option><option value="false">无需复核</option></select></label>
      <div class="filter-actions">
        <button class="primary" type="submit">查询</button>
        <button class="secondary" type="button" id="all-history">全部历史</button>
      </div>
    </form>

    <div class="state" id="state" aria-live="polite"></div>
    <section class="metrics" id="metrics" aria-label="概览计数"></section>

    <section class="panel table-panel">
      <div class="panel-header"><h2>六类解决率</h2><span>unknown 和进行中进入分母，invalid 排除</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>分类</th><th>话题数</th><th>已解决</th><th>进行中</th><th>未知</th><th>解决率</th></tr></thead>
          <tbody id="category-summary"></tbody>
        </table>
      </div>
    </section>

    <section class="grid">
      <article class="panel">
        <div class="panel-header"><h2>LB 分布</h2><span>点击分类可筛选</span></div>
        <div class="distribution" id="lb-distribution"></div>
      </article>
      <article class="panel">
        <div class="panel-header"><h2>LP 分布</h2><span>点击分类可筛选</span></div>
        <div class="distribution" id="lp-distribution"></div>
      </article>
    </section>

    <section class="panel" style="margin-top:14px">
      <div class="panel-header"><h2>按日趋势</h2><span>话题、采集和当前有效标签数量</span></div>
      <div class="trend" id="trend"></div>
    </section>

    <section class="panel table-panel">
      <div class="panel-header"><h2>话题明细</h2><span id="data-time">数据更新时间：—</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>话题</th><th>Bot</th><th>采集状态</th><th>标签状态</th><th>LB</th><th>LP</th><th>解决状态</th><th>数据时间</th><th></th></tr></thead>
          <tbody id="sessions"></tbody>
        </table>
      </div>
      <div class="pagination">
        <span class="pagination-info" id="pagination-info"></span>
        <div class="pagination-actions"><button class="secondary" type="button" id="previous">上一页</button><button class="secondary" type="button" id="next">下一页</button></div>
      </div>
    </section>
  </main>

  <dialog id="detail-dialog">
    <div class="dialog-header"><strong id="detail-title">话题详情</strong><button type="button" id="detail-close">关闭</button></div>
    <div class="dialog-body" id="detail-body"></div>
  </dialog>

  <script>
  (() => {
    'use strict';
    const TAXONOMY = {
      lb: {
        LB01: '电子面单 / 在线寄件', LB02: '发货 / 履约', LB03: '订单 / 售后 / 协商',
        LB04: '物流工具 / 页面平台', LB05: '数据 / 报表业务', LB06: '研发与助手运行环境', LB99: '其他 / 待复核'
      },
      lp: {
        LP01: '前端埋点查询', LP02: '业务数据查询', LP03: '线上问题排查',
        LP04: '业务功能咨询', LP05: '商家反馈分析', LP99: '其他'
      }
    };
    const RESOLUTION = { resolved: '已解决', in_progress: '进行中', unknown: '未知' };
    const CAPTURE = { pending: '待采集', running: '采集中', captured: '已采集', partial: '部分采集', failed: '采集失败', conflict: '采集冲突' };
    const LABEL = { not_ready: '未就绪', pending: '待打标', running: '打标中', failed: '打标失败', labeled: '已打标' };
    const RUN = { running: '运行中', succeeded: '已完成', partial: '部分完成/有待处理', failed: '更新失败' };
    const form = document.getElementById('filters');
    const state = document.getElementById('state');
    const metrics = document.getElementById('metrics');
    const sessions = document.getElementById('sessions');
    const queryFields = ['from', 'to', 'bot', 'lb', 'lp', 'resolution', 'dataStatus', 'labelStatus', 'needsReview'];
    let offset = 0;
    let loadSerial = 0;
    let detailSerial = 0;

    const make = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = String(text);
      return node;
    };
    const formatNumber = value => new Intl.NumberFormat('zh-CN').format(Number(value || 0));
    const formatDate = value => value ? new Date(Number(value)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '—';
    const formatDay = value => value ? String(value).slice(5) : '—';
    const formatCode = (group, value) => value ? String(value) + ' · ' + (TAXONOMY[group][value] || value) : '未打标';
    const statusClass = value => value === 'failed' || value === 'conflict' ? 'tag danger' : value === 'partial' || value === 'pending' || value === 'running' ? 'tag warning' : value === 'captured' || value === 'labeled' ? 'tag success' : 'tag';
    const percent = (part, whole) => whole ? (Number(part || 0) * 100 / Number(whole)).toFixed(1) + '%' : '—';
    const shanghaiParts = date => {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
      const values = {}; parts.forEach(part => { values[part.type] = part.value; });
      return values;
    };
    const shanghaiDay = date => { const parts = shanghaiParts(date); return parts.year + '-' + parts.month + '-' + parts.day; };
    const defaultFrom = () => shanghaiDay(new Date(Date.now() - 29 * 24 * 60 * 60 * 1000));
    const defaultTo = () => shanghaiDay(new Date());
    const option = (select, value, text) => select.appendChild(new Option(text, value));
    Object.entries(TAXONOMY.lb).forEach(([code, label]) => option(form.elements.lb, code, code + ' · ' + label));
    Object.entries(TAXONOMY.lp).forEach(([code, label]) => option(form.elements.lp, code, code + ' · ' + label));
    Object.entries(RESOLUTION).forEach(([code, label]) => option(form.elements.resolution, code, label));
    Object.entries(CAPTURE).forEach(([code, label]) => option(form.elements.dataStatus, code, label));
    Object.entries(LABEL).forEach(([code, label]) => option(form.elements.labelStatus, code, label));

    function setFormFromUrl() {
      const params = new URLSearchParams(location.search);
      queryFields.forEach(name => {
        const element = form.elements[name];
        if (element) element.value = params.get(name) || '';
      });
      const hasQuery = params.toString() !== '';
      if (!hasQuery && !params.has('from')) form.elements.from.value = defaultFrom();
      if (!hasQuery && !params.has('to')) form.elements.to.value = defaultTo();
      const rawOffset = params.get('offset');
      offset = rawOffset && /^\\d+$/.test(rawOffset) ? Number(rawOffset) : 0;
    }

    function currentQuery(includeOffset) {
      const params = new URLSearchParams();
      queryFields.forEach(name => {
        const value = String(form.elements[name].value || '');
        if (value || name === 'from' || name === 'to') params.set(name, value);
      });
      if (includeOffset && offset > 0) params.set('offset', String(offset));
      return params;
    }

    function navigate(nextOffset, replace) {
      offset = Math.max(0, Number(nextOffset) || 0);
      const query = currentQuery(true);
      history[replace ? 'replaceState' : 'pushState']({}, '', location.pathname + (query.toString() ? '?' + query.toString() : ''));
      load();
    }

    async function api(path, params) {
      const response = await fetch(path + (params && params.toString() ? '?' + params.toString() : ''), { credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 401) throw new Error('401：当前请求未授权');
      if (!response.ok) {
        let code = '请求失败';
        try { const body = await response.json(); code = body.error || code; } catch { /* text response is not needed here */ }
        throw new Error(String(code));
      }
      return response.json();
    }

    function setState(message, kind) {
      state.textContent = message || '';
      state.className = message ? 'state visible ' + (kind || '') : 'state';
    }

    function renderRunStatus(status) {
      const stateNode = document.getElementById('run-state');
      const timesNode = document.getElementById('run-times');
      if (!status || status.available !== true) {
        stateNode.className = 'unavailable';
        stateNode.textContent = '尚无调度记录/状态不可用';
        timesNode.textContent = '';
        return;
      }
      stateNode.className = status.status === 'failed' || status.status === 'partial' ? 'stale' : '';
      stateNode.textContent = '本轮：' + (RUN[status.status] || status.status);
      const capture = status.lastSuccessfulCaptureAt ? '采集最近全部成功：' + formatDate(status.lastSuccessfulCaptureAt) : '采集最近全部成功：尚未全部完成';
      const label = status.lastSuccessfulLabelAt ? '打标最近全部成功：' + formatDate(status.lastSuccessfulLabelAt) : '打标最近全部成功：尚未全部完成';
      const finished = status.finishedAt ? '最近批次完成：' + formatDate(status.finishedAt) : '最近批次完成：—';
      const batchStale = !!status.finishedAt && Date.now() - Number(status.finishedAt) > 2 * 60 * 60 * 1000;
      timesNode.textContent = finished + '；' + capture + '；' + label + (batchStale ? '；调度延迟' : '');
      timesNode.className = batchStale ? 'stale' : '';
    }

    function renderMetrics(summary) {
      const pending = Number(summary.totalTopics || 0) - Number(summary.labeledTopics || 0);
      const values = [
        ['总话题', summary.totalTopics, ''],
        ['已采集', summary.capturedTopics, '采集覆盖率 ' + percent(summary.capturedTopics, summary.totalTopics)],
        ['已打标', summary.labeledTopics, '打标覆盖率 ' + percent(summary.labeledTopics, summary.totalTopics)],
        ['已解决', summary.resolved, '当前有效标签'],
        ['进行中', summary.inProgress, '当前有效标签'],
        ['未知', summary.unknown, '当前有效标签'],
        ['待处理', pending, '未完成采集或打标'],
        ['待复核', summary.needsReview, '当前有效标签']
      ];
      metrics.textContent = '';
      values.forEach(item => {
        const card = make('article', 'metric');
        card.appendChild(make('span', 'label', item[0]));
        card.appendChild(make('strong', 'value', formatNumber(item[1])));
        if (item[2]) card.appendChild(make('span', 'detail', item[2]));
        metrics.appendChild(card);
      });
    }

    function renderCategories(rows) {
      const body = document.getElementById('category-summary');
      body.textContent = '';
      (rows || []).forEach(row => {
        const tr = document.createElement('tr');
        [
          formatCode('lp', row.taskType),
          formatNumber(row.topicCount),
          formatNumber(row.resolvedCount),
          formatNumber(row.inProgressCount),
          formatNumber(row.unknownCount),
          row.resolutionRate === null ? '—' : (Number(row.resolutionRate) * 100).toFixed(1) + '%'
        ].forEach(value => tr.appendChild(make('td', '', value)));
        body.appendChild(tr);
      });
    }

    function renderDistribution(target, values, group) {
      target.textContent = '';
      if (!values || !values.length) { target.appendChild(make('p', 'state empty visible', '暂无分布数据')); return; }
      const max = Math.max(1, ...values.map(item => Number(item.count || 0)));
      values.forEach(item => {
        const button = make('button', 'distribution-item');
        button.type = 'button';
        const label = item.key === 'unlabeled' ? '未打标' : formatCode(group, item.key);
        button.appendChild(make('span', 'distribution-label', label));
        const track = make('span', 'distribution-track');
        const bar = make('span', 'distribution-bar');
        bar.style.width = String(Math.max(2, Number(item.count || 0) * 100 / max)) + '%';
        track.appendChild(bar);
        button.appendChild(track);
        button.appendChild(make('span', 'distribution-count', formatNumber(item.count)));
        if (item.key !== 'unlabeled') {
          button.addEventListener('click', () => {
            form.elements[group].value = item.key;
            navigate(0, false);
          });
        }
        target.appendChild(button);
      });
    }

    function renderTrend(points) {
      const target = document.getElementById('trend');
      target.textContent = '';
      if (!points || !points.length) { target.appendChild(make('p', 'state empty visible', '暂无趋势数据')); return; }
      const max = Math.max(1, ...points.map(point => Number(point.totalTopics || 0)));
      points.forEach(point => {
        const item = make('div', 'trend-item');
        item.appendChild(make('div', 'trend-count', '总 ' + formatNumber(point.totalTopics)));
        const bars = make('div', 'trend-bars');
        [['total', point.totalTopics], ['captured', point.capturedTopics], ['labeled', point.labeledTopics]].forEach(pair => {
          const bar = make('span', 'trend-bar ' + pair[0]);
          bar.title = pair[0] + ': ' + String(pair[1] || 0);
          bar.style.height = String(Math.max(2, Number(pair[1] || 0) * 140 / max)) + 'px';
          bars.appendChild(bar);
        });
        item.appendChild(bars);
        item.appendChild(make('div', 'trend-day', formatDay(point.day)));
        target.appendChild(item);
      });
    }

    function renderSessions(result) {
      sessions.textContent = '';
      (result.items || []).forEach(item => {
        const row = document.createElement('tr');
        const title = make('td', 'topic-title', item.title || '未命名话题');
        row.appendChild(title);
        row.appendChild(make('td', 'bot-name', item.botName || '未命名 Bot'));
        row.appendChild(make('td', '', ''));
        row.lastChild.appendChild(make('span', statusClass(item.captureStatus), CAPTURE[item.captureStatus] || item.captureStatus));
        row.appendChild(make('td', '', ''));
        row.lastChild.appendChild(make('span', statusClass(item.labelStatus), LABEL[item.labelStatus] || item.labelStatus));
        row.appendChild(make('td', '', formatCode('lb', item.lb)));
        row.appendChild(make('td', '', formatCode('lp', item.lp)));
        const resolutionCell = make('td', '', item.resolutionStatus ? (RESOLUTION[item.resolutionStatus] || item.resolutionStatus) : '—');
        row.appendChild(resolutionCell);
        row.appendChild(make('td', '', formatDate(item.dataTime)));
        const actionCell = make('td');
        const detailButton = make('button', 'detail-button', '查看详情');
        detailButton.type = 'button';
        detailButton.addEventListener('click', () => openDetail(item.topicPublicId));
        actionCell.appendChild(detailButton);
        row.appendChild(actionCell);
        sessions.appendChild(row);
      });
      if (!result.items || !result.items.length) {
        const row = document.createElement('tr');
        const cell = make('td', '', '暂无符合筛选条件的话题');
        cell.colSpan = 9;
        row.appendChild(cell);
        sessions.appendChild(row);
      }
      const total = Number(result.total || 0);
      const limit = Number(result.limit || 50);
      const currentOffset = Number(result.offset || 0);
      const first = total ? currentOffset + 1 : 0;
      const last = Math.min(total, currentOffset + limit);
      document.getElementById('pagination-info').textContent = '第 ' + first + '–' + last + ' 条，共 ' + total + ' 条';
      document.getElementById('previous').disabled = currentOffset <= 0;
      document.getElementById('next').disabled = currentOffset + limit >= total;
      document.getElementById('previous').onclick = () => navigate(Math.max(0, currentOffset - limit), false);
      document.getElementById('next').onclick = () => navigate(currentOffset + limit, false);
    }

    function renderDataTime(summary) {
      const text = summary.lastDataTime ? '数据更新时间：' + formatDate(summary.lastDataTime) : '数据更新时间：—';
      document.getElementById('data-time').textContent = text;
    }

    function appendTag(parent, text, className) { parent.appendChild(make('span', className || 'tag', text)); }

    async function openDetail(topicPublicId) {
      const serial = ++detailSerial;
      const dialog = document.getElementById('detail-dialog');
      const body = document.getElementById('detail-body');
      document.getElementById('detail-title').textContent = '话题详情';
      body.textContent = '加载中…';
      if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
      try {
        const item = await api('/api/sessions/' + encodeURIComponent(topicPublicId));
        if (serial !== detailSerial) return;
        document.getElementById('detail-title').textContent = item.title || '话题详情';
        body.textContent = '';
        const tags = make('div', 'detail-tags');
        appendTag(tags, CAPTURE[item.captureStatus] || item.captureStatus, statusClass(item.captureStatus));
        appendTag(tags, LABEL[item.labelStatus] || item.labelStatus, statusClass(item.labelStatus));
        if (item.lb) appendTag(tags, formatCode('lb', item.lb));
        if (item.lp) appendTag(tags, formatCode('lp', item.lp));
        if (item.resolutionStatus) appendTag(tags, RESOLUTION[item.resolutionStatus] || item.resolutionStatus);
        body.appendChild(tags);
        const messages = make('div', 'messages');
        (item.messages || []).forEach(message => {
          const block = make('article', 'message ' + (message.role === 'assistant' ? 'assistant' : 'user'));
          const meta = make('div', 'message-meta');
          meta.appendChild(make('strong', '', message.role === 'assistant' ? '助手' : '用户'));
          meta.appendChild(make('time', '', formatDate(message.occurredAt)));
          block.appendChild(meta);
          block.appendChild(make('div', 'message-content', message.content));
          messages.appendChild(block);
        });
        if (!item.messages || !item.messages.length) messages.appendChild(make('p', 'state empty visible', '暂无可展示消息'));
        body.appendChild(messages);
      } catch (error) {
        if (serial !== detailSerial) return;
        body.textContent = error instanceof Error ? error.message : String(error);
      }
    }

    async function load() {
      const serial = ++loadSerial;
      setState('加载中…');
      const query = currentQuery(true);
      const baseQuery = currentQuery(false);
      history.replaceState({}, '', location.pathname + (query.toString() ? '?' + query.toString() : ''));
      try {
        const results = await Promise.all([
          api('/api/overview', baseQuery),
          api('/api/trend', baseQuery),
          api('/api/distributions', baseQuery),
          api('/api/sessions', query),
          api('/api/status')
        ]);
        if (serial !== loadSerial) return;
        renderMetrics(results[0]);
        renderCategories(results[0].categories);
        renderTrend(results[1]);
        renderDistribution(document.getElementById('lb-distribution'), results[2].lb, 'lb');
        renderDistribution(document.getElementById('lp-distribution'), results[2].lp, 'lp');
        renderSessions(results[3]);
        renderDataTime(results[0]);
        renderRunStatus(results[4]);
        setState(results[3].total ? '' : '暂无符合当前筛选条件的数据', 'empty');
      } catch (error) {
        if (serial !== loadSerial) return;
        setState(error instanceof Error ? error.message : String(error), 'error');
        metrics.textContent = '';
        sessions.textContent = '';
      } finally { /* the latest request owns the rendered state */ }
    }

    form.addEventListener('submit', event => { event.preventDefault(); navigate(0, false); });
    document.getElementById('all-history').addEventListener('click', () => {
      form.elements.from.value = '';
      form.elements.to.value = '';
      navigate(0, false);
    });
    document.getElementById('detail-close').addEventListener('click', () => document.getElementById('detail-dialog').close());
    window.addEventListener('popstate', () => { setFormFromUrl(); load(); });
    setFormFromUrl();
    const initial = currentQuery(false);
    history.replaceState({}, '', location.pathname + (initial.toString() ? '?' + initial.toString() : ''));
    load();
  })();
  </script>
</body>
</html>`;
}
