(() => {
  const STORAGE_KEY = 'stillwater-journal-v1';
  const currencySymbols = { USD: '$', INR: '₹', EUR: '€', GBP: '£', CAD: '$', AUD: '$' };
  const todayISO = () => new Date().toLocaleDateString('en-CA');
  const makeId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const defaultState = () => ({ activeAccountId: null, accounts: [], trades: [] });
  let legacyState = null;
  try { const saved=JSON.parse(localStorage.getItem(STORAGE_KEY)); if(saved&&Array.isArray(saved.accounts)&&Array.isArray(saved.trades)) legacyState=saved; } catch {}
  let state = defaultState();
  let user = null;
  let authMode = 'login';
  let backendReady = false;
  let migrationAvailable = false;
  let migrationDismissed = false;
  let saveVersion = 0;
  let savePending = false;
  let saveBusy = false;
  let currentPage = 'dashboard';
  let period = 'all';
  let metric = 'money';
  let calendarMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  let calendarMode = 'pnl';
  let selectedDate = '';
  let selectedSide = 'Long';
  let pendingChartImage = null;
  let pendingChartName = '';
  let toastTimer;

  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const main = $('#main-content');
  const appShell = $('#app-shell');
  const authScreen = $('#auth-screen');
  const tradeDialog = $('#trade-dialog');
  const accountDialog = $('#account-dialog');
  const accountSelect = $('#account-select');
  const activeAccount = () => state.accounts.find(a => a.id === state.activeAccountId) || state.accounts[0] || null;
  async function apiCall(path, options = {}) {
    const headers={...(options.headers||{})};
    if(options.body) headers['Content-Type']='application/json';
    const response=await fetch(path,{credentials:'same-origin',...options,headers});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok){const error=new Error(payload.error||'Request failed');error.status=response.status;throw error;}
    return payload;
  }
  function setSyncStatus(text, failed = false) {
    const el=$('#sync-status'); if(!el)return; el.textContent=text; el.classList.toggle('sync-error',failed); el.title=failed?'Click to retry saving your journal':'Your latest journal changes are saved to your account';
  }
  function save() {
    if(!user)return false;
    saveVersion++;savePending=true;render();setSyncStatus('Saving…');flushSave();return true;
  }
  async function flushSave() {
    if(saveBusy||!savePending||!user)return;
    saveBusy=true;savePending=false;const version=saveVersion,snapshot=JSON.stringify(state);
    try{await apiCall('/api/data',{method:'PUT',body:snapshot});if(version===saveVersion)setSyncStatus('Saved to your account');}
    catch{if(version===saveVersion){setSyncStatus('Save failed · retry',true);toast('Could not save to the database. Your changes are still on this screen.');}}
    finally{saveBusy=false;if(savePending)flushSave();}
  }
  function renderAuth(message = '') {
    appShell.classList.add('hidden');authScreen.classList.remove('hidden');
    const connected=backendReady,registering=authMode==='register';
    const loginForm=`<form id="auth-form" class="auth-form">${registering?'<label>Your name<input id="auth-name" autocomplete="name" required maxlength="60" placeholder="Display name" /></label>':''}<label>Email<input id="auth-email" type="email" autocomplete="email" required maxlength="254" placeholder="you@example.com" /></label><label>Password<input id="auth-password" type="password" autocomplete="${registering?'new-password':'current-password'}" required minlength="10" maxlength="128" placeholder="At least 10 characters" /></label><p class="auth-error ${message?'':'hidden'}" id="auth-error" role="alert">${esc(message)}</p><button class="button primary auth-submit" type="submit">${registering?'Create account':'Sign in'}</button></form><p class="auth-switch-copy">${registering?'Already have an account?':'New trader?'} <button id="auth-switch" class="text-button">${registering?'Sign in':'Create account'}</button></p>`;
    const serverNote=`<div class="server-note"><strong>Run the local server</strong><span>Double-click <b>start.bat</b> in the app folder. Then open the app here:</span><a class="button primary" href="http://127.0.0.1:8000">Open The Abbys</a><code>http://127.0.0.1:8000</code>${legacyState?'<button id="export-legacy" class="button secondary" type="button">Export old browser journal</button>':''}<button id="retry-server" class="button secondary" type="button">Try again</button></div>${message?`<p class="auth-error">${esc(message)}</p>`:''}`;
    authScreen.innerHTML=`<section class="auth-card"><a class="brand auth-brand" href="#"><span class="brand-mark">◉</span><span>The Abbys</span></a><p class="eyebrow">PRIVATE TRADING JOURNAL</p><h1>${connected?(registering?'Create your account':'Welcome back'):'Database server not connected'}</h1><p class="subtle auth-intro">${connected?'Your trades and chart notes are private to your trader account.':'Start the backend server first, then open its local app address.'}</p>${connected?loginForm:serverNote}<div class="auth-security"><span class="privacy-dot"></span> Each trader’s records are stored separately in SQLite.</div></section>`;
    if(connected){
      $('#auth-form').addEventListener('submit',submitAuth);
      $('#auth-switch').addEventListener('click',()=>{authMode=registering?'login':'register';renderAuth();});
    } else {
      $('#retry-server').addEventListener('click',boot);
      $('#export-legacy')?.addEventListener('click',exportLegacyBackup);
    }
  }
  async function submitAuth(event) {
    event.preventDefault();const button=$('.auth-submit');button.disabled=true;button.textContent=authMode==='register'?'Creating…':'Signing in…';
    try{
      const payload={email:$('#auth-email').value.trim(),password:$('#auth-password').value};
      if(authMode==='register')payload.name=$('#auth-name').value.trim();
      const result=await apiCall(`/api/${authMode}`,{method:'POST',body:JSON.stringify(payload)});
      await establishSession(result);
    }catch(error){
      backendReady=error.status!==undefined;
      renderAuth(error.message||'Could not sign in. Try again.');
    }
  }
  async function establishSession(result) {
    user=result.user;state=result.data||defaultState();
    migrationAvailable=!state.accounts.length&&Boolean(legacyState&&(legacyState.accounts.length||legacyState.trades.length));migrationDismissed=false;
    backendReady=true;appShell.classList.remove('hidden');authScreen.classList.add('hidden');
    const created=ensureState();render();setSyncStatus('Connected to your account');
    if(created&&!migrationAvailable)save();
  }
  async function boot() {
    try{const result=await apiCall('/api/session');backendReady=true;await establishSession(result);}
    catch(error){if(error.status===401){backendReady=true;renderAuth();}else{backendReady=false;renderAuth('Start the backend, then choose Try again.');}}
  }
  async function logout() {
    try{await apiCall('/api/logout',{method:'POST'});}catch{}
    user=null;state=defaultState();migrationAvailable=false;savePending=false;saveVersion++;authMode='login';renderAuth();
  }
  const symbol = (account = activeAccount()) => currencySymbols[account?.currency || 'USD'] || '$';
  const money = (n, account = activeAccount(), showPlus = false) => {
    const val = Number(n || 0);
    const abs = Math.abs(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${val < 0 ? '−' : showPlus && val > 0 ? '+' : ''}${symbol(account)}${abs}`;
  };
  const signedMoney = (n, account = activeAccount()) => `${Number(n) > 0 ? '+' : Number(n) < 0 ? '−' : ''}${symbol(account)}${Math.abs(Number(n || 0)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const net = t => Number(t.pnl || 0) - Number(t.fees || 0);
  const accountTrades = (accountId = activeAccount()?.id) => state.trades.filter(t => t.accountId === accountId);
  const sortedTrades = (trades = accountTrades()) => [...trades].sort((a, b) => `${b.date}T${b.entry || '00:00'}`.localeCompare(`${a.date}T${a.entry || '00:00'}`));
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dateLabel = (iso, options = { month: 'short', day: 'numeric', year: 'numeric' }) => iso ? new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, options) : '';
  const timeLabel = t => t ? new Date(`2000-01-01T${t}`).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const sum = arr => arr.reduce((s, t) => s + net(t), 0);
  const periodTrades = () => {
    const trades = accountTrades();
    if (period === 'all') return trades;
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (period === 'today') return trades.filter(t => t.date === todayISO());
    if (period === 'week') { start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); return trades.filter(t => t.date >= start.toLocaleDateString('en-CA')); }
    start.setDate(1); return trades.filter(t => t.date >= start.toLocaleDateString('en-CA'));
  };
  const currentDayTrades = () => accountTrades().filter(t => t.date === todayISO());

  function toast(message) {
    const el = $('#toast'); el.textContent = message; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }
  function ensureState() {
    let changed=false;
    if (!state.accounts.length) {
      const a = { id: makeId(), name: 'Personal account', type: 'Personal', currency: 'USD', balance: 0, target: 0, maxLoss: 0, dailyLoss: 0, maxTrades: 0, maxLosses: 0 };
      state.accounts.push(a); state.activeAccountId = a.id; changed=true;
    }
    if (!state.activeAccountId || !state.accounts.some(a => a.id === state.activeAccountId)) { state.activeAccountId = state.accounts[0].id; changed=true; }
    return changed;
  }
  function renderAccountSelect() {
    ensureState(); accountSelect.innerHTML = state.accounts.map(a => `<option value="${esc(a.id)}" ${a.id === state.activeAccountId ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
  }
  function render() {
    if(!user)return;
    appShell.classList.remove('hidden');authScreen.classList.add('hidden');
    $('#user-label').textContent=user.name||user.email;
    renderAccountSelect();
    $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === currentPage));
    if (currentPage === 'dashboard') renderDashboard();
    else if (currentPage === 'journal') renderJournal();
    else if (currentPage === 'calendar') renderCalendar();
    else if (currentPage === 'reviews') renderReviews();
    else renderSettings();
    renderMigrationBanner();
  }
  function renderMigrationBanner() {
    if(!migrationAvailable||migrationDismissed)return;
    main.insertAdjacentHTML('afterbegin',`<section class="migration-banner"><div><strong>Found a journal saved in this browser</strong><span>Merge its ${legacyState.trades.length} trade(s) and account settings into ${esc(user.email)}?</span></div><div class="migration-actions"><button id="migration-dismiss" class="button secondary small">Skip</button><button id="migration-import" class="button primary small">Import my journal</button></div></section>`);
    $('#migration-import').addEventListener('click',importLegacyJournal);
    $('#migration-dismiss').addEventListener('click',()=>{migrationAvailable=false;migrationDismissed=true;render();if(!state.trades.length)save();});
  }
  async function importLegacyJournal() {
    if(!legacyState||!confirm(`Merge ${legacyState.trades.length} browser trade(s) into ${user.email}'s account?`))return;
    const incoming=JSON.parse(JSON.stringify(state));
    if(incoming.accounts.length===1&&incoming.accounts[0].name==='Personal account'&&!incoming.trades.length){incoming.accounts=[];incoming.activeAccountId=null;}
    const accountMap=new Map(),usedIds=new Set(incoming.accounts.map(a=>a.id));
    for(const oldAccount of legacyState.accounts){
      const current=incoming.accounts.find(a=>a.id===oldAccount.id);
      if(current&&current.name===oldAccount.name&&current.currency===oldAccount.currency){accountMap.set(oldAccount.id,current.id);continue;}
      const copy={...oldAccount};if(usedIds.has(copy.id))copy.id=makeId();usedIds.add(copy.id);accountMap.set(oldAccount.id,copy.id);incoming.accounts.push(copy);
    }
    const tradeIds=new Set(incoming.trades.map(t=>t.id));
    for(const oldTrade of legacyState.trades){const copy={...oldTrade,accountId:accountMap.get(oldTrade.accountId)||oldTrade.accountId};if(tradeIds.has(copy.id))copy.id=makeId();tradeIds.add(copy.id);incoming.trades.push(copy);}
    if(!incoming.activeAccountId||!incoming.accounts.some(a=>a.id===incoming.activeAccountId))incoming.activeAccountId=accountMap.get(legacyState.activeAccountId)||incoming.accounts[0]?.id||null;
    if(!incoming.accounts.length){const a={id:makeId(),name:'Personal account',type:'Personal',currency:'USD',balance:0,target:0,maxLoss:0,dailyLoss:0,maxTrades:0,maxLosses:0};incoming.accounts.push(a);incoming.activeAccountId=a.id;}
    try{await apiCall('/api/data',{method:'PUT',body:JSON.stringify(incoming)});state=incoming;migrationAvailable=false;migrationDismissed=true;localStorage.removeItem(STORAGE_KEY);render();setSyncStatus('Saved to your account');toast('Browser journal merged into your account.');}
    catch(error){render();toast(error.message||'Could not import the browser journal.');}
  }
  function pageHead(title, subtitle, button = '') {
    return `<div class="page-head"><div><p class="eyebrow">${dateLabel(todayISO(), { weekday: 'long', month: 'long', day: 'numeric' })}</p><h1>${title}</h1><p class="subtle">${subtitle}</p></div><div class="head-actions">${button}</div></div>`;
  }
  function getDailyInfo() {
    const a = activeAccount(), day = currentDayTrades(), pnl = sum(day);
    const losses = [...day].sort((x, y) => `${x.date}T${x.entry || ''}`.localeCompare(`${y.date}T${y.entry || ''}`)).reduce((count, t) => net(t) < 0 ? count + 1 : 0, 0);
    return { a, day, pnl, losses, dailyUsed: Math.max(0, -pnl) };
  }
  function rulesHtml() {
    const { a, day, dailyUsed, losses } = getDailyInfo();
    const rules = [];
    if (Number(a.dailyLoss) > 0) rules.push({ label: `Daily loss limit ${money(a.dailyLoss, a)}`, value: `${money(dailyUsed, a)} / ${money(a.dailyLoss, a)}`, ok: dailyUsed < Number(a.dailyLoss), warn: dailyUsed >= Number(a.dailyLoss) });
    if (Number(a.maxTrades) > 0) rules.push({ label: `Max ${a.maxTrades} trades`, value: `${day.length} / ${a.maxTrades}`, ok: day.length < Number(a.maxTrades), warn: day.length >= Number(a.maxTrades) });
    if (Number(a.maxLosses) > 0) rules.push({ label: `Stop after ${a.maxLosses} losses`, value: `${losses} / ${a.maxLosses}`, ok: losses < Number(a.maxLosses), warn: losses >= Number(a.maxLosses) });
    if (!rules.length) return `<div class="empty-state" style="min-height:120px"><div><strong>No limits set yet</strong><p>Add personal guardrails in account settings.</p></div></div>`;
    return rules.map(r => `<div class="rule-row ${r.ok ? 'ok' : 'warn'}"><span class="rule-dot">✓</span><span>${esc(r.label)}</span><span class="rule-value">${esc(r.value)}</span>${r.warn ? '<span class="rule-status">LIMIT REACHED</span>' : ''}</div>`).join('');
  }
  function compactMoney(value, account) {
    const abs=Math.abs(value),unit=abs>=1000000?`${(abs/1000000).toFixed(1)}m`:abs>=1000?`${(abs/1000).toFixed(1)}k`:Math.round(abs).toString();
    return `${value<0?'−':''}${symbol(account)}${unit}`;
  }
  function cumulativePnlSvg(trades, account) {
    if(!trades.length)return `<div class="chart-empty">Your cumulative P&amp;L will appear after you log a trade.</div>`;
    const daily=new Map();trades.forEach(t=>daily.set(t.date,(daily.get(t.date)||0)+net(t)));
    const entries=[...daily.entries()].sort((a,b)=>a[0].localeCompare(b[0]));let cumulative=0;
    const values=[0,...entries.map(([,value])=>(cumulative+=value))],min=Math.min(0,...values),max=Math.max(0,...values),span=max-min||1;
    const left=88,right=18,top=20,bottom=218,plotW=1000-left-right,plotH=bottom-top;
    const xAt=i=>left+(i/(values.length-1||1))*plotW,yAt=v=>top+((max-v)/span)*plotH,zeroY=yAt(0);
    const points=values.map((v,i)=>`${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' '),area=`${xAt(0)},${zeroY} ${points} ${xAt(values.length-1)},${zeroY}`;
    const ticks=Array.from({length:5},(_,i)=>{const v=max-span*i/4,y=top+plotH*i/4;return `<path class="cum-gridline" d="M${left} ${y}H982"/><text class="cum-axis-label" x="${left-10}" y="${y+4}" text-anchor="end">${esc(compactMoney(v,account))}</text>`;}).join('');
    const marks=[0,Math.floor((entries.length-1)/2),entries.length-1].filter((v,i,a)=>a.indexOf(v)===i);
    const labels=marks.map(i=>`<text class="cum-axis-label" x="${xAt(i+1)}" y="242" text-anchor="${entries.length===1?'end':i===0?'start':i===entries.length-1?'end':'middle'}">${esc(dateLabel(entries[i][0],{month:'short',day:'numeric'}))}</text>`).join('');
    const dots=entries.map(([date,value],i)=>`<circle class="cum-point" cx="${xAt(i+1)}" cy="${yAt(values[i+1])}" r="3"><title>${esc(dateLabel(date))}: ${esc(signedMoney(value,account))} · cumulative ${esc(signedMoney(values[i+1],account))}</title></circle>`).join('');
    return `<svg class="cumulative-chart ${cumulative>=0?'gain':'loss'}" viewBox="0 0 1000 256" preserveAspectRatio="none" role="img" aria-label="Cumulative daily net profit and loss"><defs><linearGradient id="cumulative-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" class="cum-gradient-top"/><stop offset="1" class="cum-gradient-bottom"/></linearGradient></defs>${ticks}<path class="cum-zero-line" d="M${left} ${zeroY}H982"/><polygon class="cum-area" points="${area}"/><polyline class="cum-line" points="${points}"/>${dots}${labels}</svg>`;
  }
  function abbysScore(trades) {
    const winners=trades.filter(t=>net(t)>0),losers=trades.filter(t=>net(t)<0),grossWins=winners.reduce((s,t)=>s+net(t),0),grossLoss=Math.abs(losers.reduce((s,t)=>s+net(t),0));
    const daily=new Map();trades.forEach(t=>daily.set(t.date,(daily.get(t.date)||0)+net(t)));
    const activeDays=[...daily.values()],greenDays=activeDays.filter(v=>v>0).length;let running=0,peak=0,maxDrawdown=0;
    [...daily.entries()].sort((a,b)=>a[0].localeCompare(b[0])).forEach(([,v])=>{running+=v;peak=Math.max(peak,running);maxDrawdown=Math.max(maxDrawdown,peak-running);});
    const clamp=v=>Math.max(0,Math.min(100,v)),winRate=trades.length?winners.length/trades.length*100:0,consistency=activeDays.length?greenDays/activeDays.length*100:0;
    const pf=grossLoss?grossWins/grossLoss:(grossWins?Infinity:0),profitFactor=pf===Infinity?100:clamp(pf*50),avgWin=winners.length?grossWins/winners.length:0,avgLoss=losers.length?grossLoss/losers.length:0;
    const winLoss=avgLoss?clamp(avgWin/avgLoss/2*100):(winners.length?100:0),netResult=sum(trades),recovery=maxDrawdown?clamp(netResult/maxDrawdown/2*100):(netResult>0?100:0),maxDrawdownScore=trades.length?(peak?clamp(100-maxDrawdown/peak*100):(maxDrawdown?0:100)):0;
    const dimensions=[['Win rate',winRate],['Consistency',consistency],['Profit factor',profitFactor],['Avg win/loss',winLoss],['Recovery factor',recovery],['Max drawdown',maxDrawdownScore]].map(([label,value])=>({label,value:Math.round(value)}));
    return {score:trades.length?Math.round(dimensions.reduce((s,d)=>s+d.value,0)/dimensions.length):0,dimensions,count:trades.length};
  }
  function abbysRadarSvg(dimensions) {
    const cx=230,cy=170,r=112,n=dimensions.length,coord=(i,scale)=>{const angle=-Math.PI/2+i*2*Math.PI/n;return [cx+Math.cos(angle)*scale,cy+Math.sin(angle)*scale];};
    const grids=[20,40,60,80,100].map(level=>`<polygon class="radar-grid" points="${dimensions.map((_,i)=>coord(i,r*level/100).join(',')).join(' ')}"/>`).join('');
    const axes=dimensions.map((_,i)=>{const [x,y]=coord(i,r);return `<path class="radar-axis" d="M${cx} ${cy}L${x} ${y}"/>`;}).join('');
    const labels=dimensions.map((d,i)=>{const [x,y]=coord(i,r+27),anchor=x<cx-8?'end':x>cx+8?'start':'middle';return `<text class="radar-label" x="${x}" y="${y+4}" text-anchor="${anchor}">${esc(d.label)}</text>`;}).join('');
    const shape=dimensions.map((d,i)=>coord(i,r*d.value/100).join(',')).join(' '),nodes=dimensions.map(d=>{const i=dimensions.indexOf(d),[x,y]=coord(i,r*d.value/100);return `<circle class="radar-node" cx="${x}" cy="${y}" r="3"/>`;}).join('');
    return `<svg class="abbys-radar" viewBox="0 0 460 340" role="img" aria-label="The Abbys Score radar chart"><defs><linearGradient id="radar-fill" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#718f81" stop-opacity=".55"/><stop offset="1" stop-color="#607c6f" stop-opacity=".24"/></linearGradient></defs>${grids}${axes}<polygon class="radar-data" points="${shape}"/>${nodes}${labels}</svg>`;
  }
  function abbysScoreRows(score) {
    return score.dimensions.map(d=>`<div class="score-row"><div class="score-row-label"><span>${esc(d.label)}</span><span>${d.value}</span></div><div class="score-track"><span style="width:${d.value}%"></span></div></div>`).join('');
  }
  function dailyPnlSvg(trades, account) {
    const byDate = new Map();
    trades.forEach(t => byDate.set(t.date, (byDate.get(t.date) || 0) + net(t)));
    const now = new Date(), today = todayISO();
    let dates = [];
    if (period === 'today') dates = [today];
    else if (period === 'week') {
      const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
      dates = Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setDate(monday.getDate() + i); return d.toLocaleDateString('en-CA'); });
    } else if (period === 'month') {
      const daysSoFar = now.getDate();
      dates = Array.from({ length: daysSoFar }, (_, i) => new Date(now.getFullYear(), now.getMonth(), i + 1).toLocaleDateString('en-CA'));
    } else {
      dates = [...byDate.keys()].sort().slice(-21);
    }
    if (!dates.length) return `<div class="pnl-chart-empty">Log a few trades to see your daily profit and loss here.</div>`;
    const values = dates.map(date => byDate.get(date) || 0), maxValue = Math.max(1, ...values.map(v => Math.abs(v)));
    const left = 38, right = 16, base = 142, maxBar = 96, plotWidth = 1000 - left - right, slot = plotWidth / dates.length, barWidth = Math.max(5, Math.min(34, slot * .54));
    const labelStep = Math.max(1, Math.ceil(dates.length / 9));
    const bars = values.map((v, i) => {
      const x = left + slot * i + (slot - barWidth) / 2, h = v === 0 ? 2 : Math.max(2, Math.abs(v) / maxValue * maxBar), y = v > 0 ? base - h : base;
      const cls = v > 0 ? 'pnl-bar-profit' : v < 0 ? 'pnl-bar-loss' : 'pnl-bar-zero';
      const label = dateLabel(dates[i], { month: 'short', day: 'numeric' });
      const title = `${label}: ${signedMoney(v, account)}`;
      const valueLabel = dates.length <= 14 && v !== 0 ? `<text x="${x + barWidth/2}" y="${v>0?Math.max(14,y-7):y+h+14}" text-anchor="middle" class="pnl-value ${v>0?'positive':'negative'}">${esc(signedMoney(v,account))}</text>` : '';
      const axisLabel = i % labelStep === 0 || i === dates.length - 1 ? `<text x="${x + barWidth/2}" y="226" text-anchor="middle" class="pnl-label">${esc(dateLabel(dates[i], { month: 'short', day: 'numeric' }))}</text>` : '';
      return `<g><title>${esc(title)}</title><rect class="${cls}" x="${x}" y="${y}" width="${barWidth}" height="${h}" rx="${Math.min(4,barWidth/3)}"/>${valueLabel}${axisLabel}</g>`;
    }).join('');
    const greenDays = values.filter(v => v > 0).length, redDays = values.filter(v => v < 0).length;
    return `<div class="pnl-chart-summary"><span>${greenDays} profit days</span><span>${redDays} loss days</span><span>${dates.length} days shown</span></div><svg class="pnl-chart" viewBox="0 0 1000 240" preserveAspectRatio="none" role="img" aria-label="Daily profit and loss bar chart"><path class="pnl-grid" d="M${left} 46H984 M${left} 94H984 M${left} 190H984"/><path class="pnl-baseline" d="M${left} ${base}H984"/>${bars}</svg>`;
  }
  function renderDashboard() {
    const a = activeAccount(), trades = periodTrades(), pnl = sum(trades), wins = trades.filter(t => net(t) > 0).length, losses = trades.filter(t => net(t) < 0).length;
    const winRate = trades.length ? Math.round(wins / trades.length * 100) : 0;
    const totalRisk = trades.reduce((s, t) => s + Number(t.risk || 0), 0);
    const avgR = trades.filter(t => Number(t.risk) > 0).map(t => net(t) / Number(t.risk)).reduce((s, r, _, arr) => s + r / arr.length, 0);
    const grossWins = trades.filter(t => net(t) > 0).reduce((s, t) => s + net(t), 0), grossLoss = Math.abs(trades.filter(t => net(t) < 0).reduce((s, t) => s + net(t), 0));
    const profitFactor = grossLoss ? grossWins / grossLoss : (grossWins ? Infinity : 0);
    const allNet = sum(accountTrades()), balance = Number(a.balance || 0) + allNet, remainingTarget = Math.max(0, Number(a.target || 0) - allNet), room = Number(a.maxLoss || 0) ? Math.max(0, Number(a.maxLoss || 0) + allNet) : 0;
    const { dailyUsed } = getDailyInfo(), dailyPercent = Number(a.dailyLoss) ? Math.min(100, dailyUsed / Number(a.dailyLoss) * 100) : 0;
    const circumference = 2 * Math.PI * 34;
    const rangeLabel = { today: 'TODAY', week: 'THIS WEEK', month: 'THIS MONTH', all: 'ALL TIME' }[period];
    const score = abbysScore(trades);
    const metricValue = metric === 'money' ? signedMoney(pnl, a) : metric === 'r' ? `${trades.filter(t => Number(t.risk) > 0).length ? trades.filter(t => Number(t.risk) > 0).reduce((s, t) => s + net(t) / Number(t.risk), 0).toFixed(2) : '0.00'}R` : metric === 'points' ? `${trades.reduce((s, t) => s + Number(t.points || 0), 0).toFixed(2)} pts` : `${a.balance ? (pnl / Number(a.balance) * 100).toFixed(2) : '0.00'}%`;
    const metricClass = metric === 'money' ? (pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : '') : '';
    main.innerHTML = `${pageHead('Your trading, at a glance', `${esc(a.name)} · ${esc(a.type)} account`, `<button class="button secondary" id="dashboard-review">Review performance</button><button class="button primary" id="new-trade">＋ Log trade</button>`)}
      <div class="grid dashboard-grid">
        <div>
          <section class="panel hero-panel"><div class="panel-head"><div><p class="eyebrow">${rangeLabel} · NET P&amp;L</p><div class="hero-stats"><span><strong>${trades.length}</strong> trades</span><span><strong>${wins}W · ${losses}L</strong></span><span><strong>${winRate}%</strong> win rate</span></div></div><div class="period-tabs">${[['today','Today'],['week','Week'],['month','Month'],['all','All']].map(([key,label]) => `<button data-period="${key}" class="${period === key ? 'active' : ''}">${label}</button>`).join('')}</div></div>
            <div class="hero-value ${metricClass}">${esc(metricValue)}</div>
            <div class="hero-bottom"><span class="mono">${trades.length ? 'Review the process behind each result' : 'Log your first trade to see your progress'}</span><div class="metric-switch">${[['money','$'],['r','R'],['points','PTS'],['percent','%']].map(([key,label]) => `<button data-metric="${key}" class="${metric === key ? 'active' : ''}">${label}</button>`).join('')}</div></div>
          </section>
          <div class="stat-row">
            <div class="stat-card"><p class="stat-label">Win rate</p><p class="stat-value">${trades.length ? winRate + '%' : '—'}</p><p class="stat-foot">${wins} wins · ${losses} losses</p></div>
            <div class="stat-card"><p class="stat-label">Average R</p><p class="stat-value">${trades.some(t => Number(t.risk) > 0) ? avgR.toFixed(2) + 'R' : '—'}</p><p class="stat-foot">Across trades with risk logged</p></div>
            <div class="stat-card"><p class="stat-label">Profit factor</p><p class="stat-value">${profitFactor === Infinity ? '∞' : profitFactor ? profitFactor.toFixed(2) : '—'}</p><p class="stat-foot">Gross wins ÷ gross losses</p></div>
            <div class="stat-card"><p class="stat-label">Risk logged</p><p class="stat-value">${totalRisk ? money(totalRisk, a) : '—'}</p><p class="stat-foot">${trades.filter(t => Number(t.risk) > 0).length} trades with planned risk</p></div>
          </div>
          <section class="panel section-gap"><div class="panel-head"><div><h2 class="panel-title">Daily profit &amp; loss</h2><p class="panel-subtitle">${rangeLabel} · positive and negative net results by day</p></div><div class="pnl-chart-legend"><span><i class="profit-key"></i>Profit</span><span><i class="loss-key"></i>Loss</span></div></div><div class="pnl-chart-wrap">${dailyPnlSvg(trades,a)}</div></section>
          <section class="panel section-gap"><div class="panel-head"><div><h2 class="panel-title">Cumulative net P&amp;L</h2><p class="panel-subtitle">Daily net results added over time · ${rangeLabel.toLowerCase()}</p></div><span class="tag">${trades.length} ${trades.length === 1 ? 'TRADE' : 'TRADES'}</span></div><div class="equity-chart">${cumulativePnlSvg(trades,a)}</div></section>
          <section class="panel section-gap"><div class="panel-head"><div><h2 class="panel-title">The Abbys Score</h2><p class="panel-subtitle">A snapshot of six journal metrics · ${rangeLabel.toLowerCase()}</p></div><span class="tag">JOURNAL SCORE</span></div><div class="abbys-score-layout"><div class="abbys-radar-wrap">${abbysRadarSvg(score.dimensions)}</div><div class="abbys-score-summary"><div class="abbys-score-number">${score.score}<span>/100</span></div><p class="panel-subtitle">${score.count ? `Based on ${score.count} logged ${score.count===1?'trade':'trades'}` : 'Log trades to build your score'}</p><div class="score-rows">${abbysScoreRows(score)}</div></div></div><p class="score-note">Simple average of the six journal metrics above for the selected range. Informational only, not a trading signal.</p></section>
        </div>
        <div class="right-stack">
          <section class="panel account-card"><div class="panel-head"><div><h2 class="panel-title">Balance</h2><p class="panel-subtitle">${esc(a.name)}</p></div><span class="tag">${esc(a.type)}</span></div><div class="split-info"><div><div class="account-balance">${money(balance, a)}</div><div class="account-caption">Current balance</div></div>${Number(a.maxLoss) ? `<div class="loss-value"><span class="account-caption">Room to max loss</span><strong>${money(room, a)}</strong></div>` : ''}</div>${Number(a.target) ? `<div class="progress-track"><div class="progress-fill ${allNet >= Number(a.target) ? 'warn' : ''}" style="width:${Math.min(100,Math.max(0,allNet/Number(a.target)*100))}%"></div></div><div class="split-info" style="margin-top:8px"><span class="mono">${money(Math.max(0,allNet), a)} toward target</span><span class="mono">${money(remainingTarget,a)} to go</span></div>` : ''}</section>
          <section class="panel"><div class="panel-head"><div><h2 class="panel-title">Daily stop</h2><p class="panel-subtitle">Your limit for today</p></div><span class="tag">${Number(a.dailyLoss) ? 'TRACKING' : 'NOT SET'}</span></div><div class="daily-stop"><div class="stop-ring"><svg viewBox="0 0 80 80"><circle class="ring-bg" cx="40" cy="40" r="34"/><circle class="ring-value" cx="40" cy="40" r="34" stroke-dasharray="${circumference}" stroke-dashoffset="${circumference * (1 - dailyPercent / 100)}"/></svg><strong>${Math.round(dailyPercent)}%</strong></div><div class="stop-copy"><strong>${Number(a.dailyLoss) ? `${money(Math.max(0, Number(a.dailyLoss) - dailyUsed), a)} left` : 'No daily limit set'}</strong><span>${Number(a.dailyLoss) ? `${money(dailyUsed,a)} used of ${money(a.dailyLoss,a)}` : 'Add one to track your daily loss.'}</span></div></div></section>
          <section class="panel rules-panel"><div class="panel-head"><div><h2 class="panel-title">Today’s guardrails</h2><p class="panel-subtitle">Progress from your saved trades</p></div><button class="text-button" id="edit-account-rules">Edit</button></div><div style="margin-top:7px">${rulesHtml()}</div></section>
        </div>
      </div>
      <div class="grid bottom-grid"><section class="panel"><div class="panel-head"><div><h2 class="panel-title">Recent trades</h2><p class="panel-subtitle">Your latest journal entries</p></div><button class="text-button" id="all-trades">View all →</button></div>${renderTradeRows(sortedTrades().slice(0,4))}</section><section class="panel calendar-panel"><div class="panel-head"><div><h2 class="panel-title">Trading calendar</h2><p class="panel-subtitle">${dateLabel(todayISO(), { month: 'long', year: 'numeric' })}</p></div><button class="text-button" id="open-calendar">Open calendar →</button></div>${miniCalendar()}</section></div>`;
    wirePageButtons();
  }
  function renderTradeRows(trades) {
    if (!trades.length) return `<div class="empty-state"><div><strong>No trades logged yet</strong><p>Start with the result, then add a note or chart when you review.</p></div></div>`;
    return `<div class="trade-list">${trades.map(t => `<div class="trade-row" data-edit-trade="${esc(t.id)}"><div class="trade-instrument"><span class="side-mark">${t.side === 'Short' ? '↘' : '↗'}</span><div><strong>${esc(t.instrument)} <span class="tag">${esc(t.side)}</span></strong><span>${dateLabel(t.date,{month:'short',day:'numeric'})}${t.entry ? ' · ' + timeLabel(t.entry) : ''}</span></div></div><span class="trade-meta">${esc(t.strategy || t.session || 'No setup tagged')}</span><span class="trade-meta">${Number(t.risk) ? `${(net(t)/Number(t.risk)).toFixed(2)}R` : (t.grade ? `Grade ${esc(t.grade)}` : '')}</span><div class="trade-row-actions"><strong class="trade-result ${net(t)>0?'positive':net(t)<0?'negative':''}">${signedMoney(net(t))}</strong><span class="row-arrow">›</span></div></div>`).join('')}</div>`;
  }
  function wirePageButtons() {
    $('#new-trade')?.addEventListener('click', () => openTrade());
    $('#dashboard-review')?.addEventListener('click', () => navigate('reviews'));
    $('#all-trades')?.addEventListener('click', () => navigate('journal'));
    $('#open-calendar')?.addEventListener('click', () => navigate('calendar'));
    $('#edit-account-rules')?.addEventListener('click', () => openAccount(activeAccount().id));
    $$('[data-period]').forEach(b => b.addEventListener('click', () => { period = b.dataset.period; render(); }));
    $$('[data-metric]').forEach(b => b.addEventListener('click', () => { metric = b.dataset.metric; render(); }));
    $$('[data-edit-trade]').forEach(row => row.addEventListener('click', () => openTrade(row.dataset.editTrade)));
    $$('.cal-day[data-date]').forEach(cell => cell.addEventListener('click', () => { selectedDate = cell.dataset.date; navigate('calendar'); }));
  }
  function miniCalendar() {
    const now = new Date(), year = now.getFullYear(), month = now.getMonth(), first = new Date(year, month, 1), offset = (first.getDay() + 6) % 7;
    const byDate = new Map(); accountTrades().forEach(t => byDate.set(t.date, (byDate.get(t.date) || 0) + net(t)));
    let cells = '';
    const totalCells = Math.ceil((offset + new Date(year, month + 1, 0).getDate()) / 7) * 7;
    for (let i = 0; i < totalCells; i++) {
      const d = new Date(year, month, 1 - offset + i), iso = d.toLocaleDateString('en-CA'), same = d.getMonth() === month, val = byDate.get(iso) || 0;
      cells += `<button class="cal-day ${same?'':'outside'} ${val>0?'win':val<0?'loss':''} ${iso===todayISO()?'today':''}" data-date="${iso}"><span class="day-number">${d.getDate()}</span>${byDate.has(iso)?`<span class="day-pnl ${val>0?'positive':'negative'}">${signedMoney(val)}</span>`:''}</button>`;
    }
    return `<div class="calendar-week">${['M','T','W','T','F','S','S'].map(d => `<span class="cal-weekday">${d}</span>`).join('')}${cells}</div>`;
  }
  function renderJournal() {
    const trades = sortedTrades();
    main.innerHTML = `${pageHead('Journal', 'Every trade, with the context you want to remember.', `<button class="button primary" id="new-trade">＋ Log trade</button>`)}
      <section class="panel"><div class="panel-head"><div><h2 class="panel-title">Trade history</h2><p class="panel-subtitle">${trades.length} ${trades.length === 1 ? 'entry' : 'entries'} · ${esc(activeAccount().name)}</p></div><span class="tag">YOUR SQL ACCOUNT</span></div>
      <div class="journal-toolbar"><input id="journal-search" class="search-input" placeholder="Search instrument or setup…"/><select id="journal-result-filter" class="filter-select"><option value="all">All results</option><option value="win">Winners</option><option value="loss">Losers</option><option value="rule">Rule followed</option><option value="missed">Rule missed</option></select><select id="journal-month-filter" class="filter-select"><option value="all">All dates</option>${[...new Set(trades.map(t => t.date.slice(0,7)))].sort().reverse().map(m => `<option value="${m}">${new Date(`${m}-01T12:00:00`).toLocaleDateString(undefined,{month:'long',year:'numeric'})}</option>`).join('')}</select></div>
      <div class="journal-table-head"><span>TRADE</span><span>SETUP</span><span>GRADE / RULES</span><span style="text-align:right">R MULTIPLE</span><span style="text-align:right">NET P&amp;L</span></div><div id="journal-results"></div></section>`;
    $('#new-trade').addEventListener('click', () => openTrade());
    const apply = () => {
      const q = $('#journal-search').value.toLowerCase(), result = $('#journal-result-filter').value, month = $('#journal-month-filter').value;
      const filtered = trades.filter(t => (!q || `${t.instrument} ${t.strategy} ${t.session} ${t.note}`.toLowerCase().includes(q)) && (result === 'all' || (result === 'win' && net(t)>0) || (result === 'loss' && net(t)<0) || (result === 'rule' && t.followedRules) || (result === 'missed' && !t.followedRules)) && (month === 'all' || t.date.startsWith(month)));
      $('#journal-results').innerHTML = filtered.length ? filtered.map(t => `<div class="journal-row" data-edit-trade="${esc(t.id)}"><div class="journal-primary"><strong>${esc(t.instrument)} <span class="tag">${esc(t.side)}</span></strong><span>${dateLabel(t.date)}${t.entry ? ` · ${timeLabel(t.entry)}` : ''}</span></div><div class="journal-detail">${esc(t.strategy || '—')}${t.session ? ` · ${esc(t.session)}` : ''}</div><div class="journal-detail">${t.grade ? `Grade ${esc(t.grade)}` : 'No grade'} · ${t.followedRules ? 'Plan followed' : 'Plan missed'}</div><div class="r-multiple">${Number(t.risk) ? `${(net(t)/Number(t.risk)).toFixed(2)}R` : '—'}</div><div class="pnl ${net(t)>0?'positive':net(t)<0?'negative':''}">${signedMoney(net(t))}</div></div>`).join('') : `<div class="empty-state"><div><strong>No matching trades</strong><p>Try changing the search or filters.</p></div></div>`;
      $$('#journal-results [data-edit-trade]').forEach(row => row.addEventListener('click', () => openTrade(row.dataset.editTrade)));
    };
    ['journal-search','journal-result-filter','journal-month-filter'].forEach(id => $(`#${id}`).addEventListener(id === 'journal-search' ? 'input' : 'change', apply)); apply();
  }
  function renderCalendar() {
    const year = calendarMonth.getFullYear(), month = calendarMonth.getMonth(), first = new Date(year, month, 1), days = new Date(year, month + 1, 0).getDate(), offset = (first.getDay() + 6) % 7;
    const byDate = new Map(); accountTrades().forEach(t => { const entry = byDate.get(t.date) || { pnl:0,count:0,trades:[] }; entry.pnl += net(t); entry.count++; entry.trades.push(t); byDate.set(t.date, entry); });
    let cells=''; const totalCells = Math.ceil((offset + days) / 7) * 7;
    for (let i=0;i<totalCells;i++) { const day=i-offset+1, d=new Date(year,month,day), iso=d.toLocaleDateString('en-CA'), same=d.getMonth()===month, data=byDate.get(iso), val=data?.pnl||0; cells += `<button class="cal-day ${same?'':'outside'} ${val>0?'win':val<0?'loss':''} ${iso===todayISO()?'today':''} ${iso===selectedDate?'selected':''}" data-date="${iso}"><span class="day-number">${d.getDate()}</span>${data?`<span class="day-pnl ${val>0?'positive':val<0?'negative':''}">${calendarMode==='journal'?`${data.count} ${data.count===1?'trade':'trades'}`:signedMoney(val)}</span>`:''}</button>`; }
    const monthTrades = accountTrades().filter(t => t.date.startsWith(`${year}-${String(month+1).padStart(2,'0')}`));
    const monthPnl = sum(monthTrades), greenDays = [...byDate.entries()].filter(([d,v])=>d.startsWith(`${year}-${String(month+1).padStart(2,'0')}`)&&v.pnl>0).length;
    main.innerHTML = `${pageHead('Trading calendar', 'See your consistency and results, day by day.', `<div class="calendar-legend"><span><i class="legend-dot green"></i>Profitable</span><span><i class="legend-dot red"></i>Loss</span></div><button class="button primary" id="new-trade">＋ Log trade</button>`)}
      <section class="panel calendar-panel"><div class="panel-head"><div><h2 class="panel-title">${signedMoney(monthPnl)} <span class="subtle">· ${monthTrades.length} trades · ${greenDays} green days</span></h2><p class="panel-subtitle">${esc(activeAccount().name)}</p></div><div class="month-control"><button class="month-arrow" id="month-prev" aria-label="Previous month">‹</button><h2>${calendarMonth.toLocaleDateString(undefined,{month:'long',year:'numeric'})}</h2><button class="month-arrow" id="month-next" aria-label="Next month">›</button></div><div class="segmented"><button data-calendar-mode="pnl" class="${calendarMode==='pnl'?'selected':''}">P&amp;L</button><button data-calendar-mode="journal" class="${calendarMode==='journal'?'selected':''}">Journal</button></div></div>
      <div class="calendar-week">${['MON','TUE','WED','THU','FRI','SAT','SUN'].map(d=>`<span class="cal-weekday">${d}</span>`).join('')}${cells}</div>
      ${selectedDate?`<div class="calendar-detail"><div class="panel-head"><div><h3 class="panel-title">${dateLabel(selectedDate,{weekday:'long',month:'long',day:'numeric',year:'numeric'})}</h3><p class="panel-subtitle">${byDate.get(selectedDate)?.count || 0} trades · ${signedMoney(byDate.get(selectedDate)?.pnl || 0)}</p></div><button class="text-button" id="clear-selected-date">Clear selection</button></div>${renderTradeRows(sortedTrades(byDate.get(selectedDate)?.trades||[]))}</div>`:''}</section>`;
    $('#new-trade').addEventListener('click', () => openTrade());
    $('#month-prev').addEventListener('click', () => { calendarMonth = new Date(year, month - 1, 1); renderCalendar(); });
    $('#month-next').addEventListener('click', () => { calendarMonth = new Date(year, month + 1, 1); renderCalendar(); });
    $$('[data-calendar-mode]').forEach(b=>b.addEventListener('click',()=>{calendarMode=b.dataset.calendarMode;renderCalendar();}));
    $$('.cal-day[data-date]').forEach(c=>c.addEventListener('click',()=>{selectedDate=c.dataset.date;renderCalendar();}));
    $('#clear-selected-date')?.addEventListener('click',()=>{selectedDate='';renderCalendar();});
    $$('[data-edit-trade]').forEach(row=>row.addEventListener('click',()=>openTrade(row.dataset.editTrade)));
  }
  function breakdown(trades, prop) {
    const groups = new Map(); trades.forEach(t => { const key = t[prop] || 'Untagged'; const entry=groups.get(key)||{pnl:0,count:0}; entry.pnl+=net(t);entry.count++;groups.set(key,entry); });
    const values=[...groups.entries()].sort((a,b)=>b[1].pnl-a[1].pnl).slice(0,7), max=Math.max(1,...values.map(x=>Math.abs(x[1].pnl)));
    return values.length ? `<div class="breakdown-list">${values.map(([key,v])=>`<div class="breakdown-row"><span>${esc(key)}</span><div class="breakdown-track"><span style="width:${Math.max(3,Math.abs(v.pnl)/max*100)}%;${v.pnl<0?'background:#b87979':''}"></span></div><span class="breakdown-value ${v.pnl>0?'positive':v.pnl<0?'negative':''}">${signedMoney(v.pnl)} · ${v.count}</span></div>`).join('')}</div>` : `<div class="empty-state" style="min-height:100px"><div><strong>Not enough data yet</strong><p>Tag trades with a setup or session to see patterns.</p></div></div>`;
  }
  function renderReviews() {
    const trades=accountTrades(), wins=trades.filter(t=>net(t)>0), losses=trades.filter(t=>net(t)<0), avgWin=wins.length?wins.reduce((s,t)=>s+net(t),0)/wins.length:0, avgLoss=losses.length?Math.abs(losses.reduce((s,t)=>s+net(t),0)/losses.length):0, avgRTrades=trades.filter(t=>Number(t.risk)>0), avgR=avgRTrades.length?avgRTrades.reduce((s,t)=>s+net(t)/Number(t.risk),0)/avgRTrades.length:0, ruleTrades=trades.filter(t=>t.followedRules), rulePnl=ruleTrades.length?sum(ruleTrades):0;
    main.innerHTML=`${pageHead('Review your edge', 'Look for repeatable patterns in your own trades.', `<button class="button secondary" id="review-to-journal">Open journal →</button>`)}
      <div class="grid review-grid"><section class="panel review-stat"><p class="stat-label">Win rate</p><p class="stat-value">${trades.length?Math.round(wins.length/trades.length*100)+'%':'—'}</p><p class="stat-foot">${wins.length} wins from ${trades.length} trades</p></section><section class="panel review-stat"><p class="stat-label">Average winner</p><p class="stat-value positive">${wins.length?money(avgWin):'—'}</p><p class="stat-foot">After fees</p></section><section class="panel review-stat"><p class="stat-label">Average loser</p><p class="stat-value negative">${losses.length?money(avgLoss):'—'}</p><p class="stat-foot">After fees</p></section><section class="panel review-stat"><p class="stat-label">Average R</p><p class="stat-value">${avgRTrades.length?avgR.toFixed(2)+'R':'—'}</p><p class="stat-foot">${avgRTrades.length} trades with planned risk</p></section><section class="panel review-stat"><p class="stat-label">Rule adherence</p><p class="stat-value">${trades.length?Math.round(ruleTrades.length/trades.length*100)+'%':'—'}</p><p class="stat-foot">${ruleTrades.length} trades marked on plan</p></section><section class="panel review-stat"><p class="stat-label">P&amp;L on plan</p><p class="stat-value ${rulePnl>0?'positive':rulePnl<0?'negative':''}">${ruleTrades.length?signedMoney(rulePnl):'—'}</p><p class="stat-foot">${ruleTrades.length} trades marked on plan</p></section></div>
      <div class="grid bottom-grid section-gap"><section class="panel"><div class="panel-head"><div><h2 class="panel-title">By setup</h2><p class="panel-subtitle">Net P&amp;L · trade count</p></div></div>${breakdown(trades,'strategy')}</section><section class="panel"><div class="panel-head"><div><h2 class="panel-title">By session</h2><p class="panel-subtitle">Net P&amp;L · trade count</p></div></div>${breakdown(trades,'session')}</section></div>
      <section class="panel section-gap"><div class="panel-head"><div><h2 class="panel-title">Review prompts</h2><p class="panel-subtitle">Use these questions when you look back at a session.</p></div></div><div class="grid review-grid" style="margin-top:18px"><div class="stat-card"><p class="stat-label">01 · Process</p><p class="stat-foot" style="font-size:13px;color:#d0d3d0">Did I wait for my setup, size the risk, and respect my stop?</p></div><div class="stat-card"><p class="stat-label">02 · Pattern</p><p class="stat-foot" style="font-size:13px;color:#d0d3d0">Which setup or session is producing my clearest decisions?</p></div><div class="stat-card"><p class="stat-label">03 · Adjustment</p><p class="stat-foot" style="font-size:13px;color:#d0d3d0">What one small change will I carry into the next session?</p></div></div></section>`;
    $('#review-to-journal').addEventListener('click',()=>navigate('journal'));
  }
  function renderSettings() {
    main.innerHTML=`${pageHead('Settings', 'Accounts, backups, and how your journal is stored.', `<button class="button primary" id="new-account">＋ Add account</button>`)}
      <div class="settings-layout"><section class="panel"><div class="panel-head"><div><h2 class="panel-title">Accounts</h2><p class="panel-subtitle">Keep personal, evaluation, or funded accounts separate.</p></div></div>${state.accounts.map(a=>`<div class="settings-account"><div><strong>${esc(a.name)} ${a.id===state.activeAccountId?'<span class="tag">ACTIVE</span>':''}</strong><span>${esc(a.type)} · ${a.currency} · Start ${money(a.balance,a)}</span></div><div class="settings-actions"><button class="button secondary small" data-edit-account="${esc(a.id)}">Edit</button>${state.accounts.length>1?`<button class="button danger-button small" data-delete-account="${esc(a.id)}">Delete</button>`:''}</div></div>`).join('')}</section>
      <section class="panel"><div class="panel-head"><div><h2 class="panel-title">Your data</h2><p class="panel-subtitle">Back up or restore your account’s journal.</p></div></div><div class="privacy-card" style="margin-top:19px"><span class="privacy-icon">⌑</span><div><b>Stored in your SQL account</b>Each trader’s accounts, trades, and chart images are separated by login. The journal does not connect to a broker.</div></div><div class="data-actions"><button class="button secondary" id="export-data">Download backup</button><button class="button secondary" id="import-data">Import backup</button></div><div class="settings-account" style="margin-top:22px"><div><strong>Reset journal</strong><span>Remove all trades and accounts stored in your account.</span></div><button class="button danger-button small" id="reset-data">Reset</button></div></section></div>`;
    $('#new-account').addEventListener('click',()=>openAccount());
    $$('[data-edit-account]').forEach(b=>b.addEventListener('click',()=>openAccount(b.dataset.editAccount)));
    $$('[data-delete-account]').forEach(b=>b.addEventListener('click',()=>deleteAccount(b.dataset.deleteAccount)));
    $('#export-data').addEventListener('click',exportBackup); $('#import-data').addEventListener('click',()=>$('#import-file').click());
    $('#reset-data').addEventListener('click',()=>{if(confirm('Delete all journal data stored in your account? This cannot be undone unless you have a backup.')){migrationAvailable=false;migrationDismissed=true;state=defaultState();ensureState();save();toast('Journal reset.');}});
  }
  function navigate(page) { currentPage=page; render(); window.scrollTo({top:0,behavior:'smooth'}); }
  function showChartPreview(dataUrl, fileName='Chart image') {
    $('#chart-preview-image').src=dataUrl; $('#chart-preview-name').textContent=fileName; $('#chart-preview').classList.remove('hidden'); $('#chart-drop').classList.add('hidden');
  }
  function clearChartPreview() {
    pendingChartImage=null; pendingChartName=''; $('#chart-preview-image').removeAttribute('src'); $('#chart-preview').classList.add('hidden'); $('#chart-drop').classList.remove('hidden'); $('#chart-file').value='';
  }
  function blobToDataUrl(blob) {
    return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob);});
  }
  async function compressChartImage(file) {
    if(!file?.type?.startsWith('image/')) throw new Error('Choose an image file.');
    if(file.size>12*1024*1024) throw new Error('That image is over 12 MB. Choose a smaller screenshot.');
    const bitmap=await createImageBitmap(file); let scale=Math.min(1,1400/Math.max(bitmap.width,bitmap.height));
    const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d');
    let best=null;
    for(let i=0;i<9;i++){
      canvas.width=Math.max(1,Math.round(bitmap.width*scale)); canvas.height=Math.max(1,Math.round(bitmap.height*scale));
      ctx.clearRect(0,0,canvas.width,canvas.height); ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
      const quality=[.9,.84,.78,.72,.68,.64,.6,.56,.52][i];
      best=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',quality));
      if(best && (best.size<=180*1024 || (i===8 && best.size<=320*1024))) break;
      if(i===2||i===4||i===6) scale*=.84;
    }
    bitmap.close?.();
    if(!best || best.size>320*1024) throw new Error('This chart image is too large to save. Try cropping it and uploading again.');
    return blobToDataUrl(best);
  }
  async function acceptChartFile(file) {
    if(!file)return;
    const name=file.name||'Pasted chart image', saveButton=$('#save-trade-button'); $('#chart-drop').classList.add('busy'); saveButton.disabled=true; saveButton.textContent='Adding image…';
    try{pendingChartImage=await compressChartImage(file);pendingChartName=name;showChartPreview(pendingChartImage,name);}
    catch(error){toast(error.message||'Could not read that chart image.');}
    finally{$('#chart-drop').classList.remove('busy');saveButton.disabled=false;saveButton.textContent='Save trade';}
  }
  function openTrade(id=null) {
    const t=id?state.trades.find(x=>x.id===id):null;
    $('#trade-form').reset(); $('#trade-id').value=t?.id||''; $('#trade-dialog-title').textContent=t?'Edit trade':'Log a trade';
    $('#trade-instrument').value=t?.instrument||''; $('#trade-date').value=t?.date||todayISO(); $('#trade-pnl').value=t?.pnl??''; $('#trade-fees').value=t?.fees??''; $('#trade-points').value=t?.points??''; $('#trade-risk').value=t?.risk??''; $('#trade-quantity').value=t?.quantity??'';
    $('#trade-entry').value=t?.entry||''; $('#trade-exit').value=t?.exit||''; $('#trade-session').value=t?.session||''; $('#trade-strategy').value=t?.strategy||''; $('#trade-grade').value=t?.grade||''; $('#trade-chart').value=t?.chart||''; $('#trade-note').value=t?.note||''; $('#trade-followed-rules').checked=t?.followedRules??true;
    selectedSide=t?.side||'Long'; $$('.direction-toggle button').forEach(b=>b.classList.toggle('selected',b.dataset.side===selectedSide)); $('#risk-currency').textContent=symbol(); $('#delete-trade').classList.toggle('hidden',!t);
    pendingChartImage=t?.chartImage||null; pendingChartName=t?.chartImageName||''; $('#chart-file').value='';
    if(pendingChartImage) showChartPreview(pendingChartImage,pendingChartName||'Saved chart image'); else clearChartPreview();
    updateResultPreview(); tradeDialog.showModal();
  }
  function updateResultPreview() { const pnl=Number($('#trade-pnl').value||0)-Number($('#trade-fees').value||0); $('#result-preview').textContent=signedMoney(pnl); $('#result-preview').className=`result-preview ${pnl>0?'positive':pnl<0?'negative':''}`; }
  function saveTrade(e) {
    e.preventDefault(); const id=$('#trade-id').value, old=state.trades.find(t=>t.id===id), data={id:id||makeId(),accountId:activeAccount().id,date:$('#trade-date').value,instrument:$('#trade-instrument').value.trim().toUpperCase(),side:selectedSide,pnl:Number($('#trade-pnl').value||0),fees:Number($('#trade-fees').value||0),points:Number($('#trade-points').value||0),risk:Number($('#trade-risk').value||0),quantity:Number($('#trade-quantity').value||0),entry:$('#trade-entry').value,exit:$('#trade-exit').value,session:$('#trade-session').value,strategy:$('#trade-strategy').value.trim(),grade:$('#trade-grade').value,chart:$('#trade-chart').value.trim(),chartImage:pendingChartImage,chartImageName:pendingChartImage?pendingChartName:'',note:$('#trade-note').value.trim(),followedRules:$('#trade-followed-rules').checked,createdAt:old?.createdAt||new Date().toISOString()};
    if (!data.date || !data.instrument) return;
    const previousTrades=[...state.trades];
    if (old) state.trades=state.trades.map(t=>t.id===id?data:t); else state.trades.push(data);
    tradeDialog.close(); if(!save()){state.trades=previousTrades;render();tradeDialog.showModal();return;} toast(old?'Trade updated.':'Trade added.');
  }
  function openAccount(id=null) {
    const a=id?state.accounts.find(x=>x.id===id):null; $('#account-form').reset(); $('#account-id').value=a?.id||''; $('#account-dialog-title').textContent=a?'Edit account':'Add an account';
    $('#account-name').value=a?.name||''; $('#account-type').value=a?.type||'Personal'; $('#account-currency').value=a?.currency||'USD'; $('#account-balance').value=a?.balance??''; $('#account-target').value=a?.target||''; $('#account-max-loss').value=a?.maxLoss||''; $('#account-daily-loss').value=a?.dailyLoss||''; $('#account-max-trades').value=a?.maxTrades||''; $('#account-max-losses').value=a?.maxLosses||''; accountDialog.showModal();
  }
  function saveAccount(e) {
    e.preventDefault(); const id=$('#account-id').value, a={id:id||makeId(),name:$('#account-name').value.trim(),type:$('#account-type').value,currency:$('#account-currency').value,balance:Number($('#account-balance').value||0),target:Number($('#account-target').value||0),maxLoss:Number($('#account-max-loss').value||0),dailyLoss:Number($('#account-daily-loss').value||0),maxTrades:Number($('#account-max-trades').value||0),maxLosses:Number($('#account-max-losses').value||0)};
    if(!a.name)return; if(id) state.accounts=state.accounts.map(x=>x.id===id?a:x); else {state.accounts.push(a);state.activeAccountId=a.id;} accountDialog.close();save();toast(id?'Account updated.':'Account added.');
  }
  function deleteAccount(id) {
    const a=state.accounts.find(x=>x.id===id); if(!a||state.accounts.length<=1)return;
    if(confirm(`Delete “${a.name}” and its ${accountTrades(id).length} trade(s)?`)){state.accounts=state.accounts.filter(x=>x.id!==id);state.trades=state.trades.filter(t=>t.accountId!==id);if(state.activeAccountId===id)state.activeAccountId=state.accounts[0].id;save();toast('Account deleted.');}
  }
  function exportBackup() {
    const blob=new Blob([JSON.stringify({app:'The Abbys Trading Journal',version:1,exportedAt:new Date().toISOString(),...state},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`the-abbys-journal-${todayISO()}.json`;a.click();URL.revokeObjectURL(url);toast('Backup downloaded.');
  }
  function exportLegacyBackup() {
    if(!legacyState)return;
    const blob=new Blob([JSON.stringify({app:'The Abbys Browser Journal Backup',version:1,exportedAt:new Date().toISOString(),...legacyState},null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`the-abbys-local-journal-${todayISO()}.json`;a.click();URL.revokeObjectURL(url);toast('Browser journal backup downloaded.');
  }
  function importBackup(e) {
    const file=e.target.files?.[0];if(!file)return;const reader=new FileReader();
    reader.onload=()=>{
      try{
        const imported=JSON.parse(reader.result);if(!Array.isArray(imported.accounts)||!Array.isArray(imported.trades))throw new Error('Invalid backup');
        if(!confirm(`Replace the current account journal with this backup? It contains ${imported.trades.length} trade(s).`))return;
        state={accounts:imported.accounts,trades:imported.trades,activeAccountId:imported.activeAccountId||imported.accounts[0]?.id};migrationAvailable=false;migrationDismissed=true;ensureState();save();toast('Backup imported to your account.');
      }catch{alert('This file does not look like a The Abbys journal backup.');}
    };reader.readAsText(file);e.target.value='';
  }

  $$('.nav-item').forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.page)));
  accountSelect.addEventListener('change',()=>{state.activeAccountId=accountSelect.value;save();});
  $('#add-account-top').addEventListener('click',()=>openAccount()); $('#settings-top').addEventListener('click',()=>navigate('settings'));
  $('#logout-top').addEventListener('click',logout);
  $('#sync-status').addEventListener('click',()=>{if($('#sync-status').classList.contains('sync-error'))save();});
  $('#export-footer').addEventListener('click',exportBackup); $('#import-file').addEventListener('change',importBackup);
  $('#trade-form').addEventListener('submit',saveTrade); $('#account-form').addEventListener('submit',saveAccount);
  $$('.close-dialog').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
  $$('.direction-toggle button').forEach(b=>b.addEventListener('click',()=>{selectedSide=b.dataset.side;$$('.direction-toggle button').forEach(x=>x.classList.toggle('selected',x===b));}));
  const chartDrop=$('#chart-drop'), chartFile=$('#chart-file');
  chartDrop.addEventListener('click',()=>chartFile.click());
  chartDrop.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();chartFile.click();}});
  chartDrop.addEventListener('dragover',e=>{e.preventDefault();chartDrop.classList.add('drag-over');});
  chartDrop.addEventListener('dragleave',()=>chartDrop.classList.remove('drag-over'));
  chartDrop.addEventListener('drop',e=>{e.preventDefault();chartDrop.classList.remove('drag-over');acceptChartFile(e.dataTransfer.files?.[0]);});
  chartFile.addEventListener('change',e=>{const file=e.target.files?.[0];e.target.value='';acceptChartFile(file);});
  $('#chart-replace').addEventListener('click',()=>chartFile.click());
  $('#chart-remove').addEventListener('click',clearChartPreview);
  document.addEventListener('paste',e=>{if(!tradeDialog.open)return;const image=[...(e.clipboardData?.items||[])].find(item=>item.type.startsWith('image/'));if(image){const file=image.getAsFile();if(file){e.preventDefault();acceptChartFile(file);}}});
  ['trade-pnl','trade-fees'].forEach(id=>$('#'+id).addEventListener('input',updateResultPreview));
  $$('.quick-results button').forEach(b=>b.addEventListener('click',()=>{const risk=Number($('#trade-risk').value||0);if(!risk){toast('Enter planned risk first to use R shortcuts.');$('#trade-risk').focus();return;}$('#trade-pnl').value=(risk*Number(b.dataset.r)).toFixed(2);updateResultPreview();}));
  $('#delete-trade').addEventListener('click',()=>{const id=$('#trade-id').value;if(!id)return;if(confirm('Delete this trade from your journal?')){state.trades=state.trades.filter(t=>t.id!==id);tradeDialog.close();save();toast('Trade deleted.');}});
  [tradeDialog,accountDialog].forEach(d=>d.addEventListener('click',e=>{if(e.target===d)d.close();}));
  boot();
})();
