const SUPABASE_URL = 'https://nzxcgnpubmtrldahzgma.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_ONTmaq5lpo-fjChiIx0fUQ_j6RKNtHT';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const CAT_LABELS = {
  fuel: '⛽ Palivo',
  service: '🔧 Servis & opravy',
  stk: '📋 STK & emise',
  insurance: '🛡️ Pojištění & známky',
  tires: '🛞 Pneumatiky & pneuservis',
  other: '🧼 Mytí & ostatní'
};

const state = {
  vehicles: [],
  vehicleId: localStorage.getItem('garaz_veh_id') || null,
  tab: 'dashboard',
  serviceSubtab: 'rules',
  expensePeriod: 'year',
  rules: [],
  services: [],
  fuels: [],
  tires: [],
  issues: [],
  docs: []
};

const $ = (id) => document.getElementById(id);
const fmtNum = (n) => (n == null || isNaN(n) ? '–' : Number(n).toLocaleString('cs-CZ'));
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('cs-CZ') : '–');
const todayStr = () => new Date().toISOString().split('T')[0];

function netCost(gross, vatDeducted) {
  const val = Number(gross || 0);
  return vatDeducted ? val / 1.21 : val;
}

function serviceGross(s) {
  return Number(s.cost_parts || 0) + Number(s.cost_labor || 0);
}

function toast(msg, isErr = false) {
  const el = $('toast');
  el.textContent = msg;
  el.style.background = isErr ? '#ef4444' : '#10b981';
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 2600);
}

function copyText(text, label) {
  if (!text) return;
  navigator.clipboard.writeText(text);
  toast(`${label} zkopírováno`);
}

function openModal(html) {
  $('modal-body').innerHTML = html;
  $('modal-backdrop').classList.remove('hidden');
}

function closeModal() {
  $('modal-backdrop').classList.add('hidden');
}

$('modal-backdrop').addEventListener('click', (e) => {
  if (e.target.id === 'modal-backdrop') closeModal();
});

// ================= AUTH =================
async function initAuth() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) showApp();
  sb.auth.onAuthStateChange((_ev, sess) => {
    if (sess) showApp();
    else {
      $('app-screen').classList.add('hidden');
      $('auth-screen').classList.remove('hidden');
    }
  });
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-err').textContent = '';
  const { error } = await sb.auth.signInWithPassword({
    email: $('login-email').value.trim(),
    password: $('login-password').value
  });
  if (error) $('login-err').textContent = 'Chybné přihlášení: ' + error.message;
});

$('logout-btn').addEventListener('click', () => sb.auth.signOut());

async function showApp() {
  $('auth-screen').classList.add('hidden');
  $('app-screen').classList.remove('hidden');
  await loadVehicles();
}

// ================= DATA LOADING =================
async function loadVehicles() {
  const { data, error } = await sb.from('car_vehicles').select('*').order('created_at');
  if (error) return toast(error.message, true);
  state.vehicles = data || [];
  if (!state.vehicles.length) {
    renderNoVehicle();
    return;
  }
  if (!state.vehicles.find((v) => v.id === state.vehicleId)) {
    state.vehicleId = state.vehicles[0].id;
    localStorage.setItem('garaz_veh_id', state.vehicleId);
  }
  renderHeader();
  await loadVehicleData();
}

function currentVehicle() {
  return state.vehicles.find((v) => v.id === state.vehicleId);
}

async function loadVehicleData() {
  const vid = state.vehicleId;
  const [r, s, f, t, i, d] = await Promise.all([
    sb.from('car_maintenance_rules').select('*').eq('vehicle_id', vid),
    sb.from('car_service_logs').select('*').eq('vehicle_id', vid).order('date', { ascending: false }),
    sb.from('car_fuel_logs').select('*').eq('vehicle_id', vid).order('odometer', { ascending: false }),
    sb.from('car_tires').select('*').eq('vehicle_id', vid).order('season'),
    sb.from('car_issues_backlog').select('*').eq('vehicle_id', vid).order('created_at', { ascending: false }),
    sb.from('car_documents').select('*').eq('vehicle_id', vid).order('created_at', { ascending: false })
  ]);
  state.rules = r.data || [];
  state.services = s.data || [];
  state.fuels = f.data || [];
  state.tires = t.data || [];
  state.issues = i.data || [];
  state.docs = d.data || [];
  renderHeader();
  renderTab();
}

function renderHeader() {
  const sel = $('vehicle-select');
  sel.innerHTML = state.vehicles.map((v) => `<option value="${v.id}" ${v.id === state.vehicleId ? 'selected' : ''}>${v.name}</option>`).join('');
  const v = currentVehicle();
  $('odo-btn').textContent = v ? `${fmtNum(v.current_odometer)} km ✏️` : '0 km';
}

$('vehicle-select').addEventListener('change', (e) => {
  state.vehicleId = e.target.value;
  localStorage.setItem('garaz_veh_id', state.vehicleId);
  loadVehicleData();
});

$('add-veh-btn').addEventListener('click', () => openVehicleModal());

$('odo-btn').addEventListener('click', () => {
  const v = currentVehicle();
  if (!v) return;
  openModal(`
    <h3>Aktualizovat tachometr</h3>
    <form id="odo-form">
      <label>Aktuální stav (km)</label>
      <input type="number" id="new-odo" value="${v.current_odometer || 0}" required />
      <button class="btn btn-block" style="margin-top:14px">Uložit</button>
    </form>
  `);
  $('odo-form').onsubmit = async (e) => {
    e.preventDefault();
    const val = parseInt($('new-odo').value, 10);
    await sb.from('car_vehicles').update({ current_odometer: val }).eq('id', v.id);
    v.current_odometer = val;
    closeModal();
    toast('Tachometr aktualizován');
    renderHeader();
    renderTab();
  };
});

// ================= LOGIC HELPERS =================
function evalRule(rule, odo) {
  const now = new Date();
  let daysLeft = null;
  let kmLeft = null;
  if (rule.next_due_date) {
    daysLeft = Math.ceil((new Date(rule.next_due_date) - now) / 86400000);
  }
  if (rule.next_due_km != null && odo != null) {
    kmLeft = rule.next_due_km - odo;
  }
  const warnDays = rule.warn_days_before || 30;
  const warnKm = rule.warn_km_before || 1000;

  let status = 'green';
  let score = 999999;
  if ((daysLeft !== null && daysLeft <= warnDays) || (kmLeft !== null && kmLeft <= warnKm)) status = 'red';
  else if ((daysLeft !== null && daysLeft <= warnDays * 2) || (kmLeft !== null && kmLeft <= warnKm * 2.5)) status = 'orange';

  if (daysLeft !== null) score = Math.min(score, daysLeft);
  if (kmLeft !== null) score = Math.min(score, kmLeft / 40);
  return { status, daysLeft, kmLeft, score };
}

function calcFuelStats() {
  const asc = [...state.fuels].sort((a, b) => a.odometer - b.odometer);
  const perLog = {};
  let prevFull = null;
  let accLiters = 0;
  let totalDist = 0;
  let totalLiters = 0;

  for (const log of asc) {
    if (!prevFull) {
      if (log.is_full_tank) prevFull = log;
      continue;
    }
    accLiters += Number(log.liters);
    if (log.is_full_tank) {
      const dist = log.odometer - prevFull.odometer;
      if (dist > 0) {
        const cons = (accLiters / dist) * 100;
        perLog[log.id] = cons;
        totalDist += dist;
        totalLiters += accLiters;
      }
      prevFull = log;
      accLiters = 0;
    }
  }
  const avg = totalDist > 0 ? (totalLiters / totalDist) * 100 : null;
  return { avg, perLog };
}

// ================= NAVIGATION =================
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.tab = btn.dataset.tab;
    renderTab();
  });
});

$('fab-btn').addEventListener('click', () => {
  if (!currentVehicle()) return openVehicleModal();
  openModal(`
    <h3>Rychlý zápis</h3>
    <div style="display:grid; gap:10px;">
      <button class="btn" onclick="openFuelModal()">⛽ Zapsat tankování</button>
      <button class="btn btn-sec" onclick="openServiceModal()">🔧 Zapsat servis / STK / výdaj</button>
      <button class="btn btn-sec" onclick="openRuleModal()">📅 Přidat hlídaný interval (STK, olej...)</button>
      <button class="btn btn-sec" onclick="openIssueModal()">📝 Závada do backlogu</button>
    </div>
  `);
});

function renderNoVehicle() {
  $('vehicle-select').innerHTML = '';
  $('odo-btn').textContent = '0 km';
  $('content').innerHTML = `
    <div class="card empty">
      <h3>Zatím nemáš přidané žádné auto</h3>
      <p>Přidej první vozidlo a začni sledovat servis, STK a tankování.</p>
      <button class="btn" onclick="openVehicleModal()">➕ Přidat první auto</button>
    </div>
  `;
}

function renderTab() {
  if (!currentVehicle()) return renderNoVehicle();
  if (state.tab === 'dashboard') renderDashboard();
  if (state.tab === 'service') renderService();
  if (state.tab === 'fuel') renderFuel();
  if (state.tab === 'expenses') renderExpenses();
  if (state.tab === 'tech') renderTech();
}

// ================= TAB 1: DASHBOARD =================
function renderDashboard() {
  const v = currentVehicle();
  const { avg } = calcFuelStats();
  const year = String(new Date().getFullYear());
  const yearFuel = state.fuels.filter((f) => f.date?.startsWith(year)).reduce((s, f) => s + netCost(f.total_cost, f.vat_deducted), 0);
  const yearServ = state.services.filter((s) => s.date?.startsWith(year)).reduce((sum, s) => sum + netCost(serviceGross(s), s.vat_deducted), 0);
  const totalCost = state.fuels.reduce((s, f) => s + netCost(f.total_cost, f.vat_deducted), 0) + state.services.reduce((sum, s) => sum + netCost(serviceGross(s), s.vat_deducted), 0);
  const odos = [...state.fuels.map((f) => f.odometer), ...state.services.map((s) => s.odometer)].filter(Boolean);
  const trackedKm = odos.length > 1 ? Math.max(...odos) - Math.min(...odos) : 0;
  const tco = trackedKm > 50 ? (totalCost / trackedKm).toFixed(2) + ' Kč' : '–';
  const openIssues = state.issues.filter((i) => i.status === 'open').length;

  const rankedRules = state.rules
    .map((r) => ({ r, ev: evalRule(r, v.current_odometer) }))
    .sort((a, b) => a.ev.score - b.ev.score)
    .slice(0, 5);

  $('content').innerHTML = `
    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-label">Průměrná spotřeba</div><div class="kpi-val">${avg ? avg.toFixed(2) + ' l' : '–'}</div></div>
      <div class="kpi"><div class="kpi-label">Náklady ${year} (čisté)</div><div class="kpi-val">${fmtNum(Math.round(yearFuel + yearServ))} Kč</div></div>
      <div class="kpi"><div class="kpi-label">Cena za 1 km (TCO)</div><div class="kpi-val">${tco}</div></div>
      <div class="kpi"><div class="kpi-label">Otevřené závady</div><div class="kpi-val">${openIssues}</div></div>
    </div>

    <h2>Semafor – co se blíží</h2>
    ${rankedRules.length ? rankedRules.map(({ r, ev }) => renderRuleCard(r, ev)).join('') : '<div class="card empty">Zatím nemáš žádné hlídané intervaly. Přidej STK, olej nebo pojistku přes tlačítko +.</div>'}
  `;
}

function renderRuleCard(r, ev) {
  const badgeClass = ev.status === 'red' ? 'b-red' : ev.status === 'orange' ? 'b-orange' : 'b-green';
  const badgeText = ev.status === 'red' ? 'Hoří / po termínu' : ev.status === 'orange' ? 'Blíží se' : 'V klidu';
  const parts = [];
  if (ev.daysLeft !== null) parts.push(ev.daysLeft < 0 ? `${Math.abs(ev.daysLeft)} dní po termínu` : `za ${ev.daysLeft} dní (${fmtDate(r.next_due_date)})`);
  if (ev.kmLeft !== null) parts.push(ev.kmLeft < 0 ? `${fmtNum(Math.abs(ev.kmLeft))} km přes` : `zbývá ${fmtNum(ev.kmLeft)} km`);

  return `
    <div class="card">
      <div class="row-wrap">
        <div>
          <strong>${r.title}</strong>
          <div class="subtext">${parts.join(' • ') || 'Bez termínu'}</div>
        </div>
        <span class="badge ${badgeClass}">${badgeText}</span>
      </div>
      <div class="row" style="margin-top:10px;">
        <button class="btn btn-sm btn-sec" onclick="completeRule('${r.id}')">✅ Splněno</button>
        <button class="btn btn-sm btn-danger" onclick="deleteItem('car_maintenance_rules','${r.id}')">Smazat</button>
      </div>
    </div>
  `;
}

// ================= TAB 2: SERVICE =================
function renderService() {
  const v = currentVehicle();
  const sub = state.serviceSubtab;
  let body = '';

  if (sub === 'rules') {
    const list = state.rules.map((r) => ({ r, ev: evalRule(r, v.current_odometer) })).sort((a, b) => a.ev.score - b.ev.score);
    body = `<button class="btn btn-block" style="margin-bottom:12px" onclick="openRuleModal()">➕ Přidat interval</button>` +
      (list.length ? list.map(({ r, ev }) => renderRuleCard(r, ev)).join('') : '<div class="card empty">Žádné intervaly.</div>');
  } else if (sub === 'logs') {
    body = `<button class="btn btn-block" style="margin-bottom:12px" onclick="openServiceModal()">➕ Přidat servis / STK / výdaj</button>` +
      (state.services.length ? state.services.map((s) => {
        const gross = serviceGross(s);
        const net = netCost(gross, s.vat_deducted);
        const cat = CAT_LABELS[s.category || 'service'] || CAT_LABELS.service;
        return `
          <div class="card">
            <div class="row-wrap">
              <div>
                <strong>${s.title}</strong>
                <div class="subtext">${cat} • ${fmtDate(s.date)} ${s.odometer ? '• ' + fmtNum(s.odometer) + ' km' : ''} ${s.workshop_name ? '• ' + s.workshop_name : ''}</div>
              </div>
              <div style="text-align:right">
                <strong>${fmtNum(Math.round(net))} Kč</strong>
                ${s.vat_deducted ? `<div class="subtext" style="color:#6ee7b7">-DPH (z ${fmtNum(Math.round(gross))})</div>` : ''}
              </div>
            </div>
            ${s.description ? `<div class="subtext" style="margin-top:8px; color:var(--text)">${s.description}</div>` : ''}
            ${s.parts_used ? `<div class="subtext">Díly: ${s.parts_used}</div>` : ''}
            <div class="row" style="margin-top:10px;">
              ${s.receipt_url ? `<button class="btn btn-sm btn-sec" onclick="openDoc('${s.receipt_url}')">📎 Faktura</button>` : '<span></span>'}
              <button class="btn btn-sm btn-danger" onclick="deleteItem('car_service_logs','${s.id}')">Smazat</button>
            </div>
          </div>
        `;
      }).join('') : '<div class="card empty">Servisní knížka je zatím prázdná.</div>');
  } else {
    body = `<button class="btn btn-block" style="margin-bottom:12px" onclick="openIssueModal()">➕ Přidat závadu k řešení</button>` +
      (state.issues.length ? state.issues.map((i) => `
        <div class="card" style="${i.status === 'resolved' ? 'opacity:0.55' : ''}">
          <div class="row-wrap">
            <div>
              <strong>${i.status === 'resolved' ? '<s>' + i.title + '</s>' : i.title}</strong>
              ${i.notes ? `<div class="subtext">${i.notes}</div>` : ''}
            </div>
            <span class="badge ${i.priority === 'high' ? 'b-red' : i.priority === 'medium' ? 'b-orange' : 'b-gray'}">${i.priority}</span>
          </div>
          <div class="row" style="margin-top:10px;">
            <button class="btn btn-sm btn-sec" onclick="toggleIssue('${i.id}','${i.status}')">${i.status === 'open' ? '✅ Vyřešeno' : '↩️ Znovu otevřít'}</button>
            <button class="btn btn-sm btn-danger" onclick="deleteItem('car_issues_backlog','${i.id}')">Smazat</button>
          </div>
        </div>
      `).join('') : '<div class="card empty">Žádné nahlášené závady.</div>');
  }

  $('content').innerHTML = `
    <div class="subtabs">
      <button class="subtab ${sub === 'rules' ? 'active' : ''}" onclick="setServiceSub('rules')">Intervaly</button>
      <button class="subtab ${sub === 'logs' ? 'active' : ''}" onclick="setServiceSub('logs')">Knížka</button>
      <button class="subtab ${sub === 'issues' ? 'active' : ''}" onclick="setServiceSub('issues')">Backlog</button>
    </div>
    ${body}
  `;
}

window.setServiceSub = (s) => { state.serviceSubtab = s; renderService(); };

// ================= TAB 3: FUEL =================
function renderFuel() {
  const { avg, perLog } = calcFuelStats();
  const sumFuelNet = state.fuels.reduce((s, f) => s + netCost(f.total_cost, f.vat_deducted), 0);
  const sumVatSaved = state.fuels.reduce((s, f) => s + (f.vat_deducted ? Number(f.total_cost) - netCost(f.total_cost, true) : 0), 0);

  $('content').innerHTML = `
    <div class="kpi-grid">
      <div class="kpi"><div class="kpi-label">Průměrná spotřeba</div><div class="kpi-val">${avg ? avg.toFixed(2) + ' l/100' : '–'}</div></div>
      <div class="kpi"><div class="kpi-label">Palivo čisté (-DPH)</div><div class="kpi-val">${fmtNum(Math.round(sumFuelNet))} Kč</div><div class="subtext">Vráceno DPH: ${fmtNum(Math.round(sumVatSaved))} Kč</div></div>
    </div>
    <button class="btn btn-block" style="margin-bottom:14px" onclick="openFuelModal()">⛽ Zapsat tankování</button>
    <h2>Historie tankování</h2>
    ${state.fuels.length ? state.fuels.map((f) => {
      const net = netCost(f.total_cost, f.vat_deducted);
      return `
      <div class="card">
        <div class="row-wrap">
          <div>
            <strong>${fmtDate(f.date)} • ${fmtNum(f.odometer)} km</strong>
            <div class="subtext">${f.liters} l (${f.price_per_liter ? f.price_per_liter + ' Kč/l' : ''}) ${f.station_name ? '• ' + f.station_name : ''} ${f.is_full_tank ? '• Plná' : '• Částečná'}</div>
          </div>
          <div style="text-align:right">
            <strong>${fmtNum(Math.round(net))} Kč</strong>
            ${f.vat_deducted ? `<div class="subtext" style="color:#6ee7b7">-DPH (z ${fmtNum(Math.round(f.total_cost))})</div>` : ''}
            ${perLog[f.id] ? `<div class="subtext" style="color:#93c5fd; font-weight:600">${perLog[f.id].toFixed(2)} l/100</div>` : ''}
          </div>
        </div>
        <div style="text-align:right; margin-top:8px;">
          <button class="btn btn-sm btn-danger" onclick="deleteItem('car_fuel_logs','${f.id}')">Smazat</button>
        </div>
      </div>
    `;
    }).join('') : '<div class="card empty">Zatím žádné tankování.</div>'}
  `;
}

// ================= TAB 4: EXPENSES =================
function renderExpenses() {
  const year = String(new Date().getFullYear());
  const isYear = state.expensePeriod === 'year';
  const fuels = isYear ? state.fuels.filter((f) => f.date?.startsWith(year)) : state.fuels;
  const servs = isYear ? state.services.filter((s) => s.date?.startsWith(year)) : state.services;

  const cats = { fuel: 0, service: 0, stk: 0, insurance: 0, tires: 0, other: 0 };
  let totalGross = 0;
  let totalNet = 0;

  fuels.forEach((f) => {
    const g = Number(f.total_cost || 0);
    const n = netCost(g, f.vat_deducted);
    cats.fuel += n;
    totalGross += g;
    totalNet += n;
  });

  servs.forEach((s) => {
    const g = serviceGross(s);
    const n = netCost(g, s.vat_deducted);
    const key = cats.hasOwnProperty(s.category) ? s.category : 'service';
    cats[key] += n;
    totalGross += g;
    totalNet += n;
  });

  const vatSaved = totalGross - totalNet;
  const rows = Object.entries(cats)
    .filter(([, val]) => val > 0)
    .sort((a, b) => b[1] - a[1]);

  $('content').innerHTML = `
    <div class="subtabs">
      <button class="subtab ${isYear ? 'active' : ''}" onclick="setExpPeriod('year')">Rok ${year}</button>
      <button class="subtab ${!isYear ? 'active' : ''}" onclick="setExpPeriod('all')">Celkem</button>
    </div>

    <div class="kpi-grid">
      <div class="kpi">
        <div class="kpi-label">Výdaje celkem (čisté)</div>
        <div class="kpi-val">${fmtNum(Math.round(totalNet))} Kč</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Ušetřeno na DPH</div>
        <div class="kpi-val" style="color:#6ee7b7">${fmtNum(Math.round(vatSaved))} Kč</div>
      </div>
    </div>

    <div class="row" style="margin-bottom:12px">
      <h2 style="margin:0">Rozdělení podle kategorií</h2>
      <button class="btn btn-sm" onclick="openServiceModal()">➕ Přidat výdaj</button>
    </div>

    ${rows.length ? `<div class="card">${rows.map(([k, val]) => {
      const pct = totalNet > 0 ? Math.round((val / totalNet) * 100) : 0;
      return `
        <div style="margin-bottom:14px;">
          <div class="row">
            <strong>${CAT_LABELS[k]}</strong>
            <span><strong>${fmtNum(Math.round(val))} Kč</strong> <span class="subtext">(${pct} %)</span></span>
          </div>
          <div class="bar-bg"><div class="bar-fill" style="width:${pct}%"></div></div>
        </div>
      `;
    }).join('')}</div>` : '<div class="card empty">V tomto období zatím nemáš žádné výdaje.</div>'}
  `;
}

window.setExpPeriod = (p) => { state.expensePeriod = p; renderExpenses(); };

// ================= TAB 5: TECH & DOCS =================
function renderTech() {
  const v = currentVehicle();
  const sp = v.specs || {};
  const em = v.emergency_contacts || {};

  $('content').innerHTML = `
    <div class="row" style="margin-bottom:10px">
      <h2 style="margin:0">Digitální techničák</h2>
      <button class="btn btn-sm btn-sec" onclick="openVehicleModal(true)">✏️ Upravit</button>
    </div>
    <div class="card">
      <div class="copy-row"><div><div class="subtext">VIN</div><strong>${v.vin || '–'}</strong></div><button class="btn btn-sm btn-sec" onclick="copyText('${v.vin || ''}','VIN')">📋</button></div>
      <div class="copy-row"><div><div class="subtext">SPZ</div><strong>${v.license_plate || '–'}</strong></div><button class="btn btn-sm btn-sec" onclick="copyText('${v.license_plate || ''}','SPZ')">📋</button></div>
      <div class="copy-row"><div><div class="subtext">Kód laku / Kód motoru</div><strong>${v.paint_code || '–'} / ${v.engine_code || '–'}</strong></div><button class="btn btn-sm btn-sec" onclick="copyText('${v.paint_code || ''}','Kód laku')">📋</button></div>
      <div class="copy-row"><div><div class="subtext">Olej</div><strong>${sp.oil || '–'}</strong></div></div>
      <div class="copy-row"><div><div class="subtext">Pneu & tlaky</div><strong>${sp.tires || '–'}</strong></div></div>
      <div class="copy-row"><div><div class="subtext">Stěrače / Žárovky / Baterie</div><strong>${[sp.wipers, sp.bulbs, sp.battery].filter(Boolean).join(' • ') || '–'}</strong></div></div>
      <div class="copy-row"><div><div class="subtext">Asistence / Mechanik</div><strong>${[em.assistance, em.mechanic].filter(Boolean).join(' • ') || '–'}</strong></div></div>
    </div>

    <div class="row" style="margin:18px 0 10px">
      <h2 style="margin:0">Pneumatiky</h2>
      <button class="btn btn-sm btn-sec" onclick="openTireModal()">➕ Přidat sadu</button>
    </div>
    ${state.tires.length ? state.tires.map((t) => `
      <div class="card">
        <div class="row-wrap">
          <div>
            <strong>${t.season === 'summer' ? '☀️ Letní' : t.season === 'winter' ? '❄️ Zimní' : '🌦️ Celoroční'} – ${t.brand_model}</strong>
            <div class="subtext">${t.dimensions || ''} ${t.dot_code ? '• DOT ' + t.dot_code : ''} ${t.tread_depth_mm ? '• ' + t.tread_depth_mm + ' mm' : ''}</div>
            <div class="subtext">Najeto: ${fmtNum(t.total_km)} km ${t.storage_location ? '• Uložení: ' + t.storage_location : ''}</div>
          </div>
          <span class="badge ${t.is_mounted ? 'b-green' : 'b-gray'}">${t.is_mounted ? 'Na autě' : 'Uskladněno'}</span>
        </div>
        <div class="row" style="margin-top:10px;">
          ${!t.is_mounted ? `<button class="btn btn-sm" onclick="mountTire('${t.id}')">🔄 Přezout na tuto sadu</button>` : '<span></span>'}
          <button class="btn btn-sm btn-danger" onclick="deleteItem('car_tires','${t.id}')">Smazat</button>
        </div>
      </div>
    `).join('') : '<div class="card empty">Zatím žádné sady pneu.</div>'}

    <div class="row" style="margin:18px 0 10px">
      <h2 style="margin:0">Trezor dokumentů</h2>
      <button class="btn btn-sm btn-sec" onclick="openDocModal()">➕ Nahrát soubor</button>
    </div>
    ${state.docs.length ? state.docs.map((d) => `
      <div class="card row">
        <div>
          <strong>${d.title}</strong>
          <div class="subtext">${d.valid_until ? 'Platnost do ' + fmtDate(d.valid_until) : d.doc_type}</div>
        </div>
        <div style="display:flex; gap:6px;">
          <button class="btn btn-sm btn-sec" onclick="openDoc('${d.file_url}')">Otevřít</button>
          <button class="btn btn-sm btn-danger" onclick="deleteItem('car_documents','${d.id}')">✕</button>
        </div>
      </div>
    `).join('') : '<div class="card empty">Zatím žádné dokumenty (zelená karta, TP, protokoly).</div>'}
  `;
}

// ================= MODALS & ACTIONS =================
window.openVehicleModal = (isEdit = false) => {
  const v = isEdit ? currentVehicle() : {};
  const sp = v.specs || {};
  const em = v.emergency_contacts || {};
  openModal(`
    <h3>${isEdit ? 'Upravit vozidlo' : 'Nové vozidlo'}</h3>
    <form id="veh-form">
      <label>Název (např. Škoda Octavia)</label><input id="v-name" required value="${v.name || ''}" />
      <div class="grid-2">
        <div><label>SPZ</label><input id="v-spz" value="${v.license_plate || ''}" /></div>
        <div><label>Stav km</label><input type="number" id="v-odo" value="${v.current_odometer || 0}" /></div>
      </div>
      <label>VIN</label><input id="v-vin" value="${v.vin || ''}" />
      <div class="grid-2">
        <div><label>Kód laku</label><input id="v-paint" value="${v.paint_code || ''}" /></div>
        <div><label>Kód motoru</label><input id="v-eng" value="${v.engine_code || ''}" /></div>
      </div>
      <label>Motorový olej (norma + objem)</label><input id="v-oil" value="${sp.oil || ''}" placeholder="5W-30 VW 504/507 (4.3 l)" />
      <label>Pneu & doporučené tlaky</label><input id="v-tires" value="${sp.tires || ''}" placeholder="205/55 R16 • 2.2 / 2.4 bar" />
      <div class="grid-2">
        <div><label>Stěrače</label><input id="v-wipers" value="${sp.wipers || ''}" placeholder="600 / 450 mm" /></div>
        <div><label>Žárovky</label><input id="v-bulbs" value="${sp.bulbs || ''}" placeholder="H7 / H1" /></div>
      </div>
      <label>Autobaterie</label><input id="v-bat" value="${sp.battery || ''}" placeholder="12V 70Ah EFB" />
      <div class="grid-2">
        <div><label>Asistence / pojistka</label><input id="v-asist" value="${em.assistance || ''}" /></div>
        <div><label>Mechanik</label><input id="v-mech" value="${em.mechanic || ''}" /></div>
      </div>
      <button class="btn btn-block" style="margin-top:14px">Uložit vozidlo</button>
    </form>
  `);
  $('veh-form').onsubmit = async (e) => {
    e.preventDefault();
    const payload = {
      name: $('v-name').value.trim(),
      license_plate: $('v-spz').value.trim(),
      current_odometer: parseInt($('v-odo').value, 10) || 0,
      vin: $('v-vin').value.trim(),
      paint_code: $('v-paint').value.trim(),
      engine_code: $('v-eng').value.trim(),
      specs: { oil: $('v-oil').value, tires: $('v-tires').value, wipers: $('v-wipers').value, bulbs: $('v-bulbs').value, battery: $('v-bat').value },
      emergency_contacts: { assistance: $('v-asist').value, mechanic: $('v-mech').value }
    };
    const res = isEdit
      ? await sb.from('car_vehicles').update(payload).eq('id', v.id)
      : await sb.from('car_vehicles').insert(payload).select().single();
    if (res.error) return toast(res.error.message, true);
    if (!isEdit && res.data) {
      state.vehicleId = res.data.id;
      localStorage.setItem('garaz_veh_id', state.vehicleId);
    }
    closeModal();
    toast('Uloženo');
    loadVehicles();
  };
};

window.openRuleModal = () => {
  openModal(`
    <h3>Nový hlídaný interval</h3>
    <form id="rule-form">
      <label>Název (např. Motorový olej, STK, POV)</label><input id="r-title" required />
      <label>Kategorie</label>
      <select id="r-cat"><option value="service">Servis</option><option value="legal">Legislativa (STK, známka)</option><option value="insurance">Pojištění</option></select>
      <div class="grid-2">
        <div><label>Příští termín (datum)</label><input type="date" id="r-date" /></div>
        <div><label>Příští termín (km)</label><input type="number" id="r-km" /></div>
      </div>
      <div class="grid-2">
        <div><label>Opakovat po (měsících)</label><input type="number" id="r-int-m" placeholder="např. 12 nebo 24" /></div>
        <div><label>Opakovat po (km)</label><input type="number" id="r-int-km" placeholder="např. 15000" /></div>
      </div>
      <div class="grid-2">
        <div><label>Upozornit dní předem</label><input type="number" id="r-wd" value="30" /></div>
        <div><label>Upozornit km předem</label><input type="number" id="r-wk" value="1000" /></div>
      </div>
      <button class="btn btn-block" style="margin-top:14px">Uložit interval</button>
    </form>
  `);
  $('rule-form').onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await sb.from('car_maintenance_rules').insert({
      vehicle_id: state.vehicleId,
      title: $('r-title').value.trim(),
      category: $('r-cat').value,
      next_due_date: $('r-date').value || null,
      next_due_km: parseInt($('r-km').value, 10) || null,
      interval_months: parseInt($('r-int-m').value, 10) || null,
      interval_km: parseInt($('r-int-km').value, 10) || null,
      warn_days_before: parseInt($('r-wd').value, 10) || 30,
      warn_km_before: parseInt($('r-wk').value, 10) || 1000
    });
    if (error) return toast(error.message, true);
    closeModal();
    toast('Interval uložen');
    loadVehicleData();
  };
};

window.completeRule = (ruleId) => {
  const rule = state.rules.find((r) => r.id === ruleId);
  if (rule) openServiceModal(rule);
};

window.openServiceModal = (rule = null) => {
  const v = currentVehicle();
  const defCat = rule ? (rule.category === 'legal' ? 'stk' : rule.category === 'insurance' ? 'insurance' : 'service') : 'service';
  openModal(`
    <h3>${rule ? 'Splnit: ' + rule.title : 'Nový servis / STK / výdaj'}</h3>
    <form id="serv-form">
      <label>Název úkonu</label><input id="s-title" required value="${rule ? rule.title : ''}" placeholder="např. STK + emise, Výměna oleje..." />
      <label>Kategorie výdaje</label>
      <select id="s-cat">
        <option value="service" ${defCat === 'service' ? 'selected' : ''}>🔧 Servis & opravy</option>
        <option value="stk" ${defCat === 'stk' ? 'selected' : ''}>📋 STK & emise</option>
        <option value="insurance" ${defCat === 'insurance' ? 'selected' : ''}>🛡️ Pojištění & známky</option>
        <option value="tires" ${defCat === 'tires' ? 'selected' : ''}>🛞 Pneumatiky & pneuservis</option>
        <option value="other" ${defCat === 'other' ? 'selected' : ''}>🧼 Mytí & ostatní</option>
      </select>
      <div class="grid-2">
        <div><label>Datum</label><input type="date" id="s-date" required value="${todayStr()}" /></div>
        <div><label>Tachometr (km)</label><input type="number" id="s-odo" value="${v.current_odometer || ''}" /></div>
      </div>
      <div class="grid-2">
        <div><label>Cena dílů / poplatek (Kč)</label><input type="number" step="0.01" id="s-parts" value="0" /></div>
        <div><label>Cena práce (Kč)</label><input type="number" step="0.01" id="s-labor" value="0" /></div>
      </div>
      <label style="display:flex; align-items:center; gap:8px; margin-top:12px;">
        <input type="checkbox" id="s-vat" style="width:auto" /> Odečíst DPH (21 %)
      </label>
      <label>Servis / stanice STK</label><input id="s-shop" />
      <label>Použité díly</label><input id="s-used" placeholder="např. Castrol 5W-30, filtr Mann" />
      <label>Poznámka</label><textarea id="s-desc"></textarea>
      <label>Faktura / účtenka (foto nebo PDF)</label><input type="file" id="s-file" accept="image/*,.pdf" />
      <button class="btn btn-block" style="margin-top:14px">Uložit záznam</button>
    </form>
  `);
  $('serv-form').onsubmit = async (e) => {
    e.preventDefault();
    let receiptPath = null;
    const file = $('s-file').files[0];
    if (file) {
      receiptPath = `${state.vehicleId}/receipt_${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const up = await sb.storage.from('car-docs').upload(receiptPath, file);
      if (up.error) return toast('Chyba nahrávání: ' + up.error.message, true);
    }
    const dateVal = $('s-date').value;
    const odoVal = parseInt($('s-odo').value, 10) || null;
    const { error } = await sb.from('car_service_logs').insert({
      vehicle_id: state.vehicleId,
      rule_id: rule ? rule.id : null,
      title: $('s-title').value.trim(),
      category: $('s-cat').value,
      date: dateVal,
      odometer: odoVal,
      cost_parts: parseFloat($('s-parts').value) || 0,
      cost_labor: parseFloat($('s-labor').value) || 0,
      vat_deducted: $('s-vat').checked,
      workshop_name: $('s-shop').value.trim(),
      parts_used: $('s-used').value.trim(),
      description: $('s-desc').value.trim(),
      receipt_url: receiptPath
    });
    if (error) return toast(error.message, true);

    if (rule) {
      const upd = { last_done_date: dateVal, last_done_km: odoVal };
      if (rule.interval_months) {
        const d = new Date(dateVal);
        d.setMonth(d.getMonth() + rule.interval_months);
        upd.next_due_date = d.toISOString().split('T')[0];
      }
      if (rule.interval_km && odoVal) upd.next_due_km = odoVal + rule.interval_km;
      await sb.from('car_maintenance_rules').update(upd).eq('id', rule.id);
    }
    closeModal();
    toast('Záznam uložen');
    await loadVehicles();
  };
};

window.openFuelModal = () => {
  const v = currentVehicle();
  openModal(`
    <h3>Zapsat tankování</h3>
    <form id="fuel-form">
      <div class="grid-2">
        <div><label>Datum</label><input type="date" id="f-date" required value="${todayStr()}" /></div>
        <div><label>Tachometr (km)</label><input type="number" id="f-odo" required value="${v.current_odometer || ''}" /></div>
      </div>
      <div class="grid-2">
        <div><label>Litry</label><input type="number" step="0.01" id="f-lit" required /></div>
        <div><label>Celková cena s DPH (Kč)</label><input type="number" step="0.01" id="f-cost" required /></div>
      </div>
      <label>Čerpací stanice</label><input id="f-st" placeholder="např. Benzina, EuroOil" />
      <label style="display:flex; align-items:center; gap:8px; margin-top:12px;">
        <input type="checkbox" id="f-full" checked style="width:auto" /> Plná nádrž (pro výpočet spotřeby)
      </label>
      <label style="display:flex; align-items:center; gap:8px; margin-top:8px;">
        <input type="checkbox" id="f-vat" style="width:auto" /> Odečíst DPH (21 %)
      </label>
      <button class="btn btn-block" style="margin-top:14px">Uložit tankování</button>
    </form>
  `);
  $('fuel-form').onsubmit = async (e) => {
    e.preventDefault();
    const lit = parseFloat($('f-lit').value);
    const cost = parseFloat($('f-cost').value);
    const { error } = await sb.from('car_fuel_logs').insert({
      vehicle_id: state.vehicleId,
      date: $('f-date').value,
      odometer: parseInt($('f-odo').value, 10),
      liters: lit,
      total_cost: cost,
      price_per_liter: lit > 0 ? +(cost / lit).toFixed(2) : null,
      station_name: $('f-st').value.trim(),
      is_full_tank: $('f-full').checked,
      vat_deducted: $('f-vat').checked
    });
    if (error) return toast(error.message, true);
    closeModal();
    toast('Tankování uloženo');
    await loadVehicles();
  };
};

window.openIssueModal = () => {
  openModal(`
    <h3>Nová závada do backlogu</h3>
    <form id="iss-form">
      <label>Popis problému</label><input id="i-title" required placeholder="např. klepe levý čep na retardéru" />
      <label>Priorita</label>
      <select id="i-prio"><option value="low">Nízká</option><option value="medium" selected>Střední</option><option value="high">Vysoká</option></select>
      <label>Poznámka</label><textarea id="i-notes"></textarea>
      <button class="btn btn-block" style="margin-top:14px">Uložit</button>
    </form>
  `);
  $('iss-form').onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await sb.from('car_issues_backlog').insert({
      vehicle_id: state.vehicleId,
      title: $('i-title').value.trim(),
      priority: $('i-prio').value,
      notes: $('i-notes').value.trim()
    });
    if (error) return toast(error.message, true);
    closeModal();
    toast('Přidáno do backlogu');
    loadVehicleData();
  };
};

window.toggleIssue = async (id, status) => {
  await sb.from('car_issues_backlog').update({ status: status === 'open' ? 'resolved' : 'open' }).eq('id', id);
  loadVehicleData();
};

window.openTireModal = () => {
  openModal(`
    <h3>Přidat sadu pneumatik</h3>
    <form id="tire-form">
      <label>Sezóna</label>
      <select id="t-sea"><option value="summer">Letní</option><option value="winter">Zimní</option><option value="all_season">Celoroční</option></select>
      <label>Značka a model</label><input id="t-brand" required placeholder="např. Continental WinterContact TS 870" />
      <div class="grid-2">
        <div><label>Rozměr</label><input id="t-dim" placeholder="205/55 R16" /></div>
        <div><label>DOT</label><input id="t-dot" placeholder="2424" /></div>
      </div>
      <div class="grid-2">
        <div><label>Dezén (mm)</label><input type="number" step="0.1" id="t-tr" /></div>
        <div><label>Uskladnění</label><input id="t-loc" placeholder="Sklep / pneuservis" /></div>
      </div>
      <button class="btn btn-block" style="margin-top:14px">Uložit sadu</button>
    </form>
  `);
  $('tire-form').onsubmit = async (e) => {
    e.preventDefault();
    const { error } = await sb.from('car_tires').insert({
      vehicle_id: state.vehicleId,
      season: $('t-sea').value,
      brand_model: $('t-brand').value.trim(),
      dimensions: $('t-dim').value.trim(),
      dot_code: $('t-dot').value.trim(),
      tread_depth_mm: parseFloat($('t-tr').value) || null,
      storage_location: $('t-loc').value.trim()
    });
    if (error) return toast(error.message, true);
    closeModal();
    toast('Sada uložena');
    loadVehicleData();
  };
};

window.mountTire = async (tireId) => {
  const odo = currentVehicle().current_odometer || 0;
  const old = state.tires.find((t) => t.is_mounted);
  if (old) {
    const added = old.mounted_at_km ? Math.max(0, odo - old.mounted_at_km) : 0;
    await sb.from('car_tires').update({ is_mounted: false, total_km: (old.total_km || 0) + added }).eq('id', old.id);
  }
  await sb.from('car_tires').update({ is_mounted: true, mounted_at_km: odo }).eq('id', tireId);
  toast('Přezuto a kilometry započteny');
  loadVehicleData();
};

window.openDocModal = () => {
  openModal(`
    <h3>Nahrát dokument</h3>
    <form id="doc-form">
      <label>Název (např. Zelená karta 2026)</label><input id="d-title" required />
      <label>Platnost do (volitelně)</label><input type="date" id="d-val" />
      <label>Soubor (PDF nebo fotka)</label><input type="file" id="d-file" required accept="image/*,.pdf" />
      <button class="btn btn-block" style="margin-top:14px">Nahrát</button>
    </form>
  `);
  $('doc-form').onsubmit = async (e) => {
    e.preventDefault();
    const file = $('d-file').files[0];
    const path = `${state.vehicleId}/doc_${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const up = await sb.storage.from('car-docs').upload(path, file);
    if (up.error) return toast(up.error.message, true);
    const { error } = await sb.from('car_documents').insert({
      vehicle_id: state.vehicleId,
      title: $('d-title').value.trim(),
      valid_until: $('d-val').value || null,
      file_url: path
    });
    if (error) return toast(error.message, true);
    closeModal();
    toast('Dokument nahrán');
    loadVehicleData();
  };
};

window.openDoc = async (path) => {
  const { data, error } = await sb.storage.from('car-docs').createSignedUrl(path, 300);
  if (error || !data?.signedUrl) return toast('Nepodařilo se otevřít soubor', true);
  window.open(data.signedUrl, '_blank');
};

window.deleteItem = async (table, id) => {
  if (!confirm('Opravdu smazat?')) return;
  await sb.from(table).delete().eq('id', id);
  toast('Smazáno');
  loadVehicleData();
};

initAuth();
