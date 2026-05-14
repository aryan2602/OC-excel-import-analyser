/* ============================================================
   IMPORT ANALYZER — app.js  (v2 — all fixes applied)
   ============================================================ */

// ── STATE ──────────────────────────────────────────────────────
const state = {
  view: 'checklist',
  db: { offerings: [], professions: [], specialties: [] },
  checklist: { data: null, selected: null, filter: { offering: '', status: '' } },
  assessment: { data: null, selected: null, filter: { offering: '', status: '' } },
  dbTab: 'offerings',
};

// ── BOOT ───────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  await loadDB();
  bindNav();
  bindFileInputs();   // FIX #7 — only binds input change, not zone click
  bindDragDrop();     // FIX #7 — zone click handled separately, no double-fire
  renderDBView();
  setView('checklist');
});

// ── DB LOADER ──────────────────────────────────────────────────
async function loadDB() {
  try {
    const [off, prof, spec] = await Promise.all([
      fetch('db/offering.json').then(r => r.json()),
      fetch('db/profession.json').then(r => r.json()),
      fetch('db/specialty.json').then(r => r.json()),
    ]);
    state.db.offerings = off;
    state.db.professions = prof;
    state.db.specialties = spec;
  } catch (e) {
    console.error('DB load failed:', e);
  }
}

// ── NAVIGATION ─────────────────────────────────────────────────
function bindNav() {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });
}

function setView(v) {
  state.view = v;
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  document.querySelectorAll('.view').forEach(el => {
    el.classList.toggle('active', el.id === `view-${v}`);
    el.classList.toggle('hidden', el.id !== `view-${v}`);
  });
  updateSidebar();
}

// ── FILE INPUTS — FIX #7: prevent repeated file-dialog triggers ─
function bindFileInputs() {
  const clInput = document.getElementById('file-checklist');
  const asInput = document.getElementById('file-assessment');

  clInput.addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) handleFile(f, 'checklist');
    // Reset so same file can be re-uploaded
    clInput.value = '';
  });
  asInput.addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) handleFile(f, 'assessment');
    asInput.value = '';
  });
}

function bindDragDrop() {
  ['checklist', 'assessment'].forEach(type => {
    const zone   = document.getElementById(`upload-${type}-zone`);
    const input  = document.getElementById(`file-${type}`);

    // FIX #7: Only the "Choose File" button inside the zone triggers the input.
    // Clicking anywhere else on the zone also triggers it — but we prevent the
    // zone's click from firing when the button itself is clicked (button already
    // opens the dialog directly via onclick in HTML, so we stop propagation).
    zone.addEventListener('click', e => {
      // Only open picker if the click came from the zone itself, not the button
      if (e.target.closest('.btn-primary')) return;
      input.click();
    });

    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) handleFile(file, type);
    });
  });
}

// ── FILE PARSING ───────────────────────────────────────────────
function handleFile(file, type) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const wb = XLSX.read(e.target.result, { type: 'binary', cellDates: true });
    if (type === 'checklist') {
      state.checklist.data     = parseChecklist(wb);
      state.checklist.selected = null;
      renderChecklistView();
      debugDuplicateIds();
    } else {
      state.assessment.data     = parseAssessment(wb);
      state.assessment.selected = null;
      renderAssessmentView();
    }
    updateSidebar();
  };
  reader.readAsBinaryString(file);
}

function sheetToArr(wb, name) {
  const ws = wb.Sheets[name];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json(ws, { defval: null });
}

// ── PARSE CHECKLIST ────────────────────────────────────────────
function parseChecklist(wb) {
  const checklists = sheetToArr(wb, 'Checklists');
  const sections   = sheetToArr(wb, 'Sections');
  const questions  = sheetToArr(wb, 'Questions');

  const sectMap = {};
  sections.forEach(s => {
    const code = s['Checklist Code'];
    if (!sectMap[code]) sectMap[code] = [];
    sectMap[code].push(s);
  });

  const qMap = {};
  questions.forEach(q => {
    const code = q['Checklist Code'];
    if (!qMap[code]) qMap[code] = [];
    qMap[code].push(q);
  });

  const result = checklists.map(cl => {
    const code       = cl['Checklist Code'];
    const clSections = sectMap[code] || [];
    const clQuestions = qMap[code] || [];
    const issues     = validateChecklist(cl, clSections, clQuestions);
    return {
      code,
      name: cl['Checklist Name'],
      type: cl['Checklist Type Code'],
      offering: cl['Offering'],
      profession: cl['Profession'],
      altProfession: cl['Alternate Profession'],
      specialty: cl['Specialty'],
      altSpecialty: cl['Alternate Specialty'],
      orgId: cl['Organization Id'],
      expiryUnit: cl['EXPIRY UNIT'],
      expiryValue: cl['Expiry Value'],
      clinicallyReviewed: cl['Clinically Reviewed'],
      clinicalReviewDate: cl['Clinical Review Date'],
      sections: buildSectionTree(clSections),
      sectionsFlat: clSections,
      questions: clQuestions,
      issues,
      status: issues.some(i => i.level === 'error') ? 'error'
            : issues.some(i => i.level === 'warning') ? 'warning' : 'ok',
    };
  });

  const globalIssues = analyzeChecklistGlobal(result);
  return { checklists: result, globalIssues, raw: { checklists, sections, questions } };
}

function validateChecklist(cl, sections, questions) {
  const issues = [];
  const { db } = state;

  if (!cl['Checklist Name'])  issues.push({ level: 'error',   msg: 'Missing Checklist Name' });
  if (!cl['Offering'])        issues.push({ level: 'error',   msg: 'Missing Offering' });
  if (!cl['Profession'])      issues.push({ level: 'error',   msg: 'Missing Profession' });
  if (!cl['Specialty'])       issues.push({ level: 'warning', msg: 'Missing Specialty' });
  if (!cl['EXPIRY UNIT'])     issues.push({ level: 'warning', msg: 'Missing Expiry Unit' });
  if (!cl['Expiry Value'])    issues.push({ level: 'warning', msg: 'Missing Expiry Value' });

  const offeringIds = db.offerings.map(o => o.id);
  if (cl['Offering'] && !offeringIds.includes(cl['Offering'])) {
    issues.push({ level: 'error', msg: `Offering "${cl['Offering']}" not found in DB` });
  }

  if (cl['Profession'] && cl['Offering']) {
    const match = db.professions.find(p => p.code === cl['Profession'] && p.offering_id === cl['Offering']);
    if (!match) {
      const anyMatch = db.professions.find(p => p.code === cl['Profession']);
      if (anyMatch) {
        issues.push({ level: 'warning', msg: `Profession "${cl['Profession']}" exists but not under offering "${cl['Offering']}" (found under ${anyMatch.offering_id})` });
      } else {
        issues.push({ level: 'error', msg: `Profession "${cl['Profession']}" not found in DB` });
      }
    }
  }

  if (cl['Specialty'] && cl['Profession'] && cl['Offering']) {
    const profMatch = db.professions.find(p => p.code === cl['Profession'] && p.offering_id === cl['Offering']);
    if (profMatch) {
      const specMatch = db.specialties.find(s => s.code === cl['Specialty'] && s.profession_id === profMatch.id);
      if (!specMatch) {
        const anySpec = db.specialties.find(s => s.code === cl['Specialty']);
        if (anySpec) {
          const anyProf = db.professions.find(p => p.id === anySpec.profession_id);
          issues.push({ level: 'warning', msg: `Specialty "${cl['Specialty']}" exists under profession "${anyProf?.code || '?'}" not "${cl['Profession']}"` });
        } else {
          issues.push({ level: 'error', msg: `Specialty "${cl['Specialty']}" not found in DB` });
        }
      }
    }
  }

  if (sections.length === 0) issues.push({ level: 'error', msg: 'No sections found for this checklist' });
  if (questions.length === 0) issues.push({ level: 'error', msg: 'No questions found for this checklist' });

  const sectionCodes = new Set(sections.map(s => s['Section Code']));
  const orphanQ = questions.filter(q => q['Section Code'] && !sectionCodes.has(q['Section Code']));
  if (orphanQ.length > 0) {
    issues.push({ level: 'error', msg: `${orphanQ.length} question(s) reference unknown section codes` });
  }

  const questionSectionCodes = new Set(questions.map(q => q['Section Code']).filter(Boolean));
  const parentSectionCodes   = new Set(sections.map(s => s['Parent Section Code']).filter(Boolean));

  sections.forEach(s => {
    const sectionCode = s['Section Code'];
    const isParent    = parentSectionCodes.has(sectionCode);
    if (isParent) return; // skip container sections — they don't hold questions directly

    const sectionName = s['Section Name'] || sectionCode;
    if (!questionSectionCodes.has(sectionCode)) {
      issues.push({
        level: 'warning',
        msg: `Section "${sectionName}" (${sectionCode}) has no questions assigned`,
      });
    }
  });
  return issues;
}

function buildSectionTree(sections) {
  const byCode = {};
  sections.forEach(s => { byCode[s['Section Code']] = { ...s, children: [] }; });
  const roots = [];
  sections.forEach(s => {
    const parent = s['Parent Section Code'];
    if (parent && byCode[parent]) {
      byCode[parent].children.push(byCode[s['Section Code']]);
    } else {
      roots.push(byCode[s['Section Code']]);
    }
  });
  return roots;
}

function analyzeChecklistGlobal(checklists) {
  const issues = [];
  const { db } = state;

  // New professions (offering|profession not in DB)
  const excelProfessions = new Set(checklists.map(c => `${c.offering}|${c.profession}`).filter(Boolean));
  const dbProfKeys = new Set(db.professions.map(p => `${p.offering_id}|${p.code}`));
  [...excelProfessions].filter(k => !dbProfKeys.has(k)).forEach(k => {
    const [off, prof] = k.split('|');
    issues.push({ level: 'info', type: 'new_profession', msg: `New profession in Excel: "${prof}" under "${off}"`, offering: off, code: prof });
  });

  // New specialties
  checklists.forEach(c => {
    if (!c.specialty || !c.profession || !c.offering) return;
    const profMatch = db.professions.find(p => p.code === c.profession && p.offering_id === c.offering);
    if (!profMatch) return;
    const specMatch = db.specialties.find(s => s.code === c.specialty && s.profession_id === profMatch.id);
    if (!specMatch) {
      issues.push({ level: 'info', type: 'new_specialty', msg: `New specialty in Excel: "${c.specialty}" for "${c.profession}" under "${c.offering}"`, offering: c.offering, profession: c.profession, code: c.specialty });
    }
  });

  // Duplicate codes
  const codes = checklists.map(c => c.code);
  const dupes = codes.filter((v, i) => codes.indexOf(v) !== i);
  [...new Set(dupes)].forEach(d => issues.push({ level: 'error', type: 'duplicate', msg: `Duplicate Checklist Code: "${d}"` }));

  // Offering format issues (spaces vs underscores)
  checklists.forEach(c => {
    if (c.offering && c.offering.includes(' ')) {
      issues.push({ level: 'warning', type: 'format', msg: `Offering "${c.offering}" contains spaces — expected format like HOME_HEALTH` });
    }
  });

  return issues;
}

// ── PARSE ASSESSMENT ───────────────────────────────────────────
function parseAssessment(wb) {
  const assessments = sheetToArr(wb, 'TestsBITeam');
  const questions   = sheetToArr(wb, 'QuestionsBiTeam');

  const qMap = {};
  questions.forEach(q => {
    const code = q['Assessment Code'];
    if (!qMap[code]) qMap[code] = [];
    qMap[code].push(q);
  });

  const result = assessments.map(a => {
    const code = a['Assessment Code'];
    const aqs  = qMap[code] || [];
    const issues = validateAssessment(a, aqs);
    return {
      code,
      title: a['Assessment Title'],
      offering: a['Offering'],
      profession: normStr(a['Subject Code / Profession']),
      specialty: a['Specialty'],
      altSpecialty: a['Alternative Specialty'],
      altProfession: a['Alternative Profession'],
      description: a['Description'],
      duration: a['Assessment Duration'],
      dueInDays: a['Assessment Due In Days'],
      maxAttempts: a['Max Attempts'],
      totalQuestionsStated: a['Total Questions'],
      passingPct: a['Passing Percentage'],
      shuffleQ: a['Shuffle Questions'],
      shuffleOpts: a['Shuffle Options'],
      showResult: a['Show Result'],
      qPerPage: a['Question Per Page'],
      active: a['Assessment Active'],
      expiryValue: a['Expiry Value'],
      expiryUnit: a['Expiry Unit'],
      clinicallyReviewed: a['Clinically Reviewed'],
      clinicalReviewDate: a['Clinical Review Date'],
      questions: aqs,
      issues,
      status: issues.some(i => i.level === 'error') ? 'error'
            : issues.some(i => i.level === 'warning') ? 'warning' : 'ok',
    };
  });

  const globalIssues = analyzeAssessmentGlobal(result);
  return { assessments: result, globalIssues, raw: { assessments, questions } };
}

function normStr(v) { return v ? String(v).trim() : v; }

function validateAssessment(a, questions) {
  const issues = [];
  const { db } = state;
  const offering   = normStr(a['Offering']);
  const profession = normStr(a['Subject Code / Profession']);

  if (!a['Assessment Title']) issues.push({ level: 'error', msg: 'Missing Assessment Title' });
  if (!offering)              issues.push({ level: 'error', msg: 'Missing Offering' });
  if (!profession)            issues.push({ level: 'error', msg: 'Missing Profession (Subject Code)' });

  const normalizedOffering = offering ? offering.replace(/\s+/g, '_').toUpperCase() : null;
  const offeringIds = db.offerings.map(o => o.id);
  if (normalizedOffering && !offeringIds.includes(normalizedOffering)) {
    issues.push({ level: 'error', msg: `Offering "${offering}" not found in DB (expected format like HOME_HEALTH)` });
  }

  if (profession && normalizedOffering) {
    const match = db.professions.find(p => p.code === profession && p.offering_id === normalizedOffering);
    if (!match) {
      const anyMatch = db.professions.find(p => p.code === profession);
      if (anyMatch) {
        issues.push({ level: 'warning', msg: `Profession "${profession}" found under "${anyMatch.offering_id}" not "${normalizedOffering}"` });
      } else {
        issues.push({ level: 'error', msg: `Profession "${profession}" not found in DB` });
      }
    }
  }

  if (a['Total Questions'] && questions.length <= a['Total Questions']) {
    issues.push({ level: 'warning', msg: `Total Questions stated: ${a['Total Questions']}, actual: ${questions.length}` });
  }
  if (questions.length === 0) issues.push({ level: 'error', msg: 'No questions found for this assessment' });

  let badOpts = 0;
  questions.forEach(q => {
    if (q['Options']) { try { JSON.parse(q['Options']); } catch { badOpts++; } }
  });
  if (badOpts > 0) issues.push({ level: 'error', msg: `${badOpts} question(s) have malformed Options JSON` });

  const missingAns = questions.filter(q => !q['Correct Answer']).length;
  if (missingAns > 0) issues.push({ level: 'error', msg: `${missingAns} question(s) missing Correct Answer` });

  const inactive = questions.filter(q => q['Question Active'] === 0 || q['Question Active'] === '0').length;
  if (inactive > 0) issues.push({ level: 'warning', msg: `${inactive} question(s) marked inactive` });

  if (!a['Expiry Value']) issues.push({ level: 'warning', msg: 'Missing Expiry Value' });

  return issues;
}

function analyzeAssessmentGlobal(assessments) {
  const issues = [];
  const { db } = state;

  const seen = new Set();
  assessments.forEach(a => {
    const offering = a.offering ? a.offering.replace(/\s+/g, '_').toUpperCase() : null;
    const key = `${offering}|${a.profession}`;
    if (!key || key === '|' || seen.has(key)) return;
    seen.add(key);
    if (offering && a.profession) {
      const match = db.professions.find(p => p.code === a.profession && p.offering_id === offering);
      if (!match) {
        issues.push({ level: 'info', type: 'new_profession', msg: `New profession: "${a.profession}" under "${a.offering}"`, offering: a.offering, code: a.profession });
      }
    }
  });

  const codes = assessments.map(a => a.code);
  const dupes = codes.filter((v, i) => codes.indexOf(v) !== i);
  [...new Set(dupes)].forEach(d => issues.push({ level: 'error', type: 'duplicate', msg: `Duplicate Assessment Code: "${d}"` }));

  return issues;
}

// ── SIDEBAR ────────────────────────────────────────────────────
function updateSidebar() {
  const title = document.getElementById('sidebar-title');
  const count = document.getElementById('sidebar-count');
  const list  = document.getElementById('sidebar-list');

  if (state.view === 'db') {
    title.textContent = 'DB Reference';
    count.textContent = '';
    list.innerHTML = `
      <li class="${state.dbTab === 'offerings' ? 'active' : ''}" onclick="switchDBTab('offerings')" style="cursor:pointer">📦 Offerings</li>
      <li class="${state.dbTab === 'professions' ? 'active' : ''}" onclick="switchDBTab('professions')" style="cursor:pointer">👤 Professions</li>
      <li class="${state.dbTab === 'specialties' ? 'active' : ''}" onclick="switchDBTab('specialties')" style="cursor:pointer">🏷️ Specialties</li>
    `;
    return;
  }

  const isChecklist = state.view === 'checklist';
  const data  = isChecklist ? state.checklist.data : state.assessment.data;
  const items = isChecklist ? data?.checklists : data?.assessments;
  title.textContent = isChecklist ? 'Checklists' : 'Assessments';

  if (!items || items.length === 0) {
    count.textContent = '0';
    list.innerHTML = '<li style="color:var(--text-muted);font-size:12px;padding:8px 10px">Upload a file to see items</li>';
    return;
  }

  const query = (document.getElementById('sidebar-search')?.value || '').toLowerCase();
  const filtered = items.filter(item => {
    const name = (isChecklist ? item.name : item.title) || '';
    return name.toLowerCase().includes(query) || (item.code || '').toLowerCase().includes(query);
  });

  count.textContent = filtered.length;
  const selectedCode = isChecklist ? state.checklist.selected : state.assessment.selected;

  list.innerHTML = filtered.map(item => {
    const name     = isChecklist ? item.name : item.title;
    const badge    = item.status === 'error' ? 'badge-err' : item.status === 'warning' ? 'badge-warn' : 'badge-ok';
    const badgeTxt = item.issues.length > 0 ? item.issues.length : '✓';
    const active   = item.code === selectedCode ? 'active' : '';
    return `<li class="${active}" onclick="selectItem('${esc(item.code)}')">
      <span class="si-name">${esc(name || item.code)}</span>
      <span class="si-badge ${badge}">${badgeTxt}</span>
    </li>`;
  }).join('');
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('sidebar-search').addEventListener('input', updateSidebar);
});

function selectItem(code) {
  if (state.view === 'checklist') {
    state.checklist.selected = code;
    scrollToCard(code);
  } else {
    state.assessment.selected = code;
    scrollToCard(code);
  }
  updateSidebar();
}

function scrollToCard(code) {
  const card = document.querySelector(`[data-code="${CSS.escape(code)}"]`);
  if (!card) return;

  // Collapse all others in same container
  const container = card.closest('.cards-list');
  if (container) {
    container.querySelectorAll('.detail-card').forEach(c => {
      c.querySelector('.card-body')?.classList.remove('open');
      c.querySelector('.card-chevron')?.classList.remove('open');
      c.querySelectorAll('.tree').forEach(t => t.classList.add('hidden'));
      c.querySelectorAll('.btn-sm[id^="btn-"]').forEach(b => { b.textContent = '▶ Show Tree'; });
    });
  }

  card.querySelector('.card-body')?.classList.add('open');
  card.querySelector('.card-chevron')?.classList.add('open');
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── RENDER CHECKLIST VIEW ──────────────────────────────────────
function renderChecklistView() {
  const d = state.checklist.data;
  if (!d) return;
  document.getElementById('upload-checklist-zone').style.display = 'none';
  const content = document.getElementById('checklist-content');
  content.classList.remove('hidden');

  const errCount  = d.checklists.filter(c => c.status === 'error').length;
  const warnCount = d.checklists.filter(c => c.status === 'warning').length;
  const okCount   = d.checklists.filter(c => c.status === 'ok').length;
  const newItems  = d.globalIssues.filter(i => i.type === 'new_profession' || i.type === 'new_specialty');
  const totalQ    = d.raw.questions.length;

  const uniqueOfferings = [...new Set(d.checklists.map(c => c.offering).filter(Boolean))];

  content.innerHTML = `
    <div class="summary-bar">
      <div class="stat-card"><div class="stat-num">${d.checklists.length}</div><div class="stat-lbl">Checklists</div></div>
      <div class="stat-card"><div class="stat-num">${d.raw.sections.length}</div><div class="stat-lbl">Sections</div></div>
      <div class="stat-card"><div class="stat-num">${totalQ}</div><div class="stat-lbl">Questions</div></div>
      <div class="stat-card" style="--num-color:var(--green)"><div class="stat-num" style="color:var(--green)">${okCount}</div><div class="stat-lbl">No Issues</div></div>
      <div class="stat-card issues"><div class="stat-num">${errCount}</div><div class="stat-lbl">With Errors</div></div>
      <div class="stat-card warn"><div class="stat-num">${warnCount}</div><div class="stat-lbl">With Warnings</div></div>
      <div class="stat-card new"><div class="stat-num">${newItems.length}</div><div class="stat-lbl">New DB Items</div></div>
    </div>

    ${renderGlobalIssues(d.globalIssues)}

    <div class="filter-bar">
      <span class="filter-label">Filter:</span>
      <select id="cl-filter-offering" onchange="applyChecklistFilter()">
        <option value="">All Offerings</option>
        ${uniqueOfferings.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
      </select>
      <select id="cl-filter-status" onchange="applyChecklistFilter()">
        <option value="">All Status</option>
        <option value="error">Errors Only</option>
        <option value="warning">Warnings Only</option>
        <option value="ok">OK Only</option>
      </select>
      <button class="btn-sm" onclick="expandAll('cl-cards')">Expand All</button>
      <button class="btn-sm" onclick="collapseAll('cl-cards')">Collapse All</button>
    </div>

    <div id="cl-cards" class="cards-list">
      ${d.checklists.map(cl => renderChecklistCard(cl)).join('')}
    </div>
  `;
}

function applyChecklistFilter() {
  const offering = document.getElementById('cl-filter-offering')?.value || '';
  const status   = document.getElementById('cl-filter-status')?.value || '';
  const d = state.checklist.data;
  if (!d) return;
  const filtered = d.checklists.filter(cl =>
    (!offering || cl.offering === offering) && (!status || cl.status === status)
  );
  document.getElementById('cl-cards').innerHTML = filtered.map(cl => renderChecklistCard(cl)).join('');
}

// ── RENDER ASSESSMENT VIEW ─────────────────────────────────────
function renderAssessmentView() {
  const d = state.assessment.data;
  if (!d) return;
  document.getElementById('upload-assessment-zone').style.display = 'none';
  const content = document.getElementById('assessment-content');
  content.classList.remove('hidden');

  const errCount  = d.assessments.filter(a => a.status === 'error').length;
  const warnCount = d.assessments.filter(a => a.status === 'warning').length;
  const okCount   = d.assessments.filter(a => a.status === 'ok').length;
  const newItems  = d.globalIssues.filter(i => i.type === 'new_profession');
  const totalQ    = d.raw.questions.length;
  const uniqueOfferings = [...new Set(d.assessments.map(a => a.offering).filter(Boolean))];

  content.innerHTML = `
    <div class="summary-bar">
      <div class="stat-card"><div class="stat-num">${d.assessments.length}</div><div class="stat-lbl">Assessments</div></div>
      <div class="stat-card"><div class="stat-num">${totalQ}</div><div class="stat-lbl">Total Questions</div></div>
      <div class="stat-card" style="--num-color:var(--green)"><div class="stat-num" style="color:var(--green)">${okCount}</div><div class="stat-lbl">No Issues</div></div>
      <div class="stat-card issues"><div class="stat-num">${errCount}</div><div class="stat-lbl">With Errors</div></div>
      <div class="stat-card warn"><div class="stat-num">${warnCount}</div><div class="stat-lbl">With Warnings</div></div>
      <div class="stat-card new"><div class="stat-num">${newItems.length}</div><div class="stat-lbl">New DB Items</div></div>
    </div>

    ${renderGlobalIssues(d.globalIssues)}

    <div class="filter-bar">
      <span class="filter-label">Filter:</span>
      <select id="as-filter-offering" onchange="applyAssessmentFilter()">
        <option value="">All Offerings</option>
        ${uniqueOfferings.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('')}
      </select>
      <select id="as-filter-status" onchange="applyAssessmentFilter()">
        <option value="">All Status</option>
        <option value="error">Errors Only</option>
        <option value="warning">Warnings Only</option>
        <option value="ok">OK Only</option>
      </select>
      <button class="btn-sm" onclick="expandAll('as-cards')">Expand All</button>
      <button class="btn-sm" onclick="collapseAll('as-cards')">Collapse All</button>
    </div>

    <div id="as-cards" class="cards-list">
      ${d.assessments.map(a => renderAssessmentCard(a)).join('')}
    </div>
  `;
}

function applyAssessmentFilter() {
  const offering = document.getElementById('as-filter-offering')?.value || '';
  const status   = document.getElementById('as-filter-status')?.value || '';
  const d = state.assessment.data;
  if (!d) return;
  const filtered = d.assessments.filter(a =>
    (!offering || a.offering === offering) && (!status || a.status === status)
  );
  document.getElementById('as-cards').innerHTML = filtered.map(a => renderAssessmentCard(a)).join('');
}

// ── GLOBAL ANALYSIS ────────────────────────────────────────────
function renderGlobalIssues(globalIssues) {
  if (!globalIssues.length) return '';

  const errors   = globalIssues.filter(i => i.level === 'error');
  const warnings = globalIssues.filter(i => i.level === 'warning');
  const newProfs = globalIssues.filter(i => i.type === 'new_profession');
  const newSpecs = globalIssues.filter(i => i.type === 'new_specialty');
  const dupes    = globalIssues.filter(i => i.type === 'duplicate');
  const formats  = globalIssues.filter(i => i.type === 'format');

  const hasIssues = errors.length || warnings.length || newProfs.length || newSpecs.length || dupes.length || formats.length;

  return `
    <div class="issues-panel">
      <div class="panel-header" onclick="togglePanel(this)">
        <div class="panel-title">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="${errors.length ? 'var(--red)' : warnings.length ? 'var(--amber)' : 'var(--indigo)'}"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 3.5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 018 4.5zm0 7a1 1 0 110-2 1 1 0 010 2z"/></svg>
          Global Analysis
          ${errors.length ? `<span class="tag-pill" style="background:var(--red-bg);color:var(--red);font-size:11px">${errors.length} errors</span>` : ''}
          ${warnings.length ? `<span class="tag-pill" style="background:var(--amber-bg);color:var(--amber);font-size:11px">${warnings.length} warnings</span>` : ''}
          ${(newProfs.length + newSpecs.length) ? `<span class="tag-pill" style="background:var(--indigo-bg);color:var(--indigo);font-size:11px">${newProfs.length + newSpecs.length} new DB items</span>` : ''}
        </div>
        <span class="panel-toggle open">›</span>
      </div>
      <div class="panel-body">
        ${errors.length ? `
          <div class="global-section">
            <div class="global-section-title global-section-title--error">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 3.5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 018 4.5zm0 7a1 1 0 110-2 1 1 0 010 2z"/></svg>
              Errors (${errors.length})
            </div>
            ${errors.map(i => `<div class="issue-item error"><div class="issue-dot"></div><div class="issue-text">${esc(i.msg)}</div></div>`).join('')}
          </div>` : ''}

        ${warnings.length ? `
          <div class="global-section">
            <div class="global-section-title global-section-title--warn">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M8.22 1.754a.25.25 0 00-.44 0L1.698 13.132a.25.25 0 00.22.368h12.164a.25.25 0 00.22-.368L8.22 1.754zm-1.763-.707c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0114.082 15H1.918a1.75 1.75 0 01-1.543-2.575L6.457 1.047zM9 11a1 1 0 11-2 0 1 1 0 012 0zm-.25-5.25a.75.75 0 00-1.5 0v2.5a.75.75 0 001.5 0v-2.5z"/></svg>
              Warnings (${warnings.length})
            </div>
            ${warnings.map(i => `<div class="issue-item warning"><div class="issue-dot"></div><div class="issue-text">${esc(i.msg)}</div></div>`).join('')}
          </div>` : ''}

        ${dupes.length ? `
          <div class="global-section">
            <div class="global-section-title global-section-title--error">Duplicate Codes (${dupes.length})</div>
            ${dupes.map(i => `<div class="issue-item error"><div class="issue-dot"></div><div class="issue-text">${esc(i.msg)}</div></div>`).join('')}
          </div>` : ''}

        ${formats.length ? `
          <div class="global-section">
            <div class="global-section-title global-section-title--warn">Format Issues (${formats.length})</div>
            ${formats.map(i => `<div class="issue-item warning"><div class="issue-dot"></div><div class="issue-text">${esc(i.msg)}</div></div>`).join('')}
          </div>` : ''}

        ${newProfs.length ? `
          <div class="global-section">
            <div class="global-section-title global-section-title--info">New Professions Not in DB (${newProfs.length})</div>
            <div class="new-items-grid">
              ${newProfs.map(i => `<div class="new-item-card"><div class="ni-code">${esc(i.code)}</div><div class="ni-offering">${esc(i.offering)} · Profession</div></div>`).join('')}
            </div>
          </div>` : ''}

        ${newSpecs.length ? `
          <div class="global-section">
            <div class="global-section-title global-section-title--info">New Specialties Not in DB (${newSpecs.length})</div>
            <div class="new-items-grid">
              ${newSpecs.map(i => `<div class="new-item-card"><div class="ni-code">${esc(i.code)}</div><div class="ni-offering">${esc(i.offering)}${i.profession ? ' › ' + esc(i.profession) : ''} · Specialty</div></div>`).join('')}
            </div>
          </div>` : ''}

        ${!hasIssues ? '<div class="issue-item info"><div class="issue-dot" style="background:var(--green)"></div><div class="issue-text">No global issues found — all looks good!</div></div>' : ''}
      </div>
    </div>
  `;
}

// ── CHECKLIST CARD — FIX #4 #5 #6 ─────────────────────────────
// Unique ID generator to avoid duplicate element IDs across cards
// function makeId(prefix, code, suffix) {
//   return `${prefix}-${btoa(encodeURIComponent(code)).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)}-${suffix}`;
// }

function makeId(prefix, code, suffix) {
  return `${prefix}-${crypto.randomUUID()}-${suffix}`;
}

function renderChecklistCard(cl) {
  const dot     = `status-${cl.status}`;
  const issues  = cl.issues;
  const qCount  = cl.questions.length;
  const sCount  = cl.sectionsFlat.length;
  // FIX #5: use a stable unique treeId per checklist code
  const treeId  = makeId('tree', cl.code, 'root');

  return `
    <div class="detail-card" data-code="${esc(cl.code)}">
      <div class="card-header" onclick="toggleCard(this)">
        <div class="card-status-dot ${dot}"></div>
        <div class="card-title-group">
          <div class="card-title">${esc(cl.name || cl.code)}</div>
          <div class="card-code">${esc(cl.code)}</div>
          <div class="card-meta">
            ${cl.offering  ? `<span class="meta-tag">🏢 ${esc(cl.offering)}</span>`  : ''}
            ${cl.profession ? `<span class="meta-tag">👤 ${esc(cl.profession)}</span>` : ''}
            ${cl.specialty  ? `<span class="meta-tag">🏷️ ${esc(cl.specialty)}</span>`  : ''}
            <span class="meta-tag">📂 ${sCount} sections</span>
            <span class="meta-tag">❓ ${qCount} questions</span>
            ${cl.expiryValue ? `<span class="meta-tag">⏱ ${cl.expiryValue} ${esc(cl.expiryUnit || '')}</span>` : ''}
            ${cl.clinicallyReviewed ? `<span class="meta-tag">🩺 Clinically Reviewed</span>` : ''}
          </div>
        </div>
        <div class="card-header-right">
          ${issues.length ? `<span class="issue-count-badge ${cl.status}">${issues.length} issue${issues.length > 1 ? 's' : ''}</span>` : '<span class="issue-count-badge ok">✓ Clean</span>'}
          <span class="card-chevron">›</span>
        </div>
      </div>

      <div class="card-body">
        ${issues.length ? `
        <div class="card-issues">
          <div class="card-issues-header">Issues Found</div>
          ${issues.map(i => `<div class="issue-item ${i.level}"><div class="issue-dot"></div><div class="issue-text">${esc(i.msg)}</div></div>`).join('')}
        </div>` : '<div class="card-ok-bar">✓ No issues detected in this checklist</div>'}

        <div class="card-detail-grid">
          <div class="card-detail-row"><span class="cd-lbl">Type</span><span class="cd-val">${esc(cl.type || '—')}</span></div>
          <div class="card-detail-row"><span class="cd-lbl">Offering</span><span class="cd-val">${esc(cl.offering || '—')}</span></div>
          <div class="card-detail-row"><span class="cd-lbl">Profession</span><span class="cd-val">${esc(cl.profession || '—')}</span></div>
          ${cl.altProfession ? `<div class="card-detail-row"><span class="cd-lbl">Alt Profession</span><span class="cd-val">${esc(cl.altProfession)}</span></div>` : ''}
          <div class="card-detail-row"><span class="cd-lbl">Specialty</span><span class="cd-val">${esc(cl.specialty || '—')}</span></div>
          ${cl.altSpecialty ? `<div class="card-detail-row"><span class="cd-lbl">Alt Specialty</span><span class="cd-val">${esc(cl.altSpecialty)}</span></div>` : ''}
          <div class="card-detail-row"><span class="cd-lbl">Expiry</span><span class="cd-val">${cl.expiryValue ? `${cl.expiryValue} ${esc(cl.expiryUnit || '')}` : '—'}</span></div>
          <div class="card-detail-row"><span class="cd-lbl">Org ID</span><span class="cd-val mono">${esc(cl.orgId || '—')}</span></div>
          <div class="card-detail-row"><span class="cd-lbl">Clinical Review</span><span class="cd-val">${esc(cl.clinicallyReviewed || '—')}${cl.clinicalReviewDate ? ` (${esc(String(cl.clinicalReviewDate))})` : ''}</span></div>
        </div>

        <!-- FIX #4: Show Tree button (replaces "All Questions") -->
        <div class="tree-section">
          <div class="tree-toggle-row">
            <span class="tree-label">Structure Tree — ${sCount} sections · ${qCount} questions</span>
            <button class="btn-sm" id="btn-${treeId}" onclick="event.stopPropagation(); toggleTree('${treeId}', this)">▶ Show Tree</button>
          </div>
          <!-- FIX #5: tree starts hidden, all questions inside, unique IDs -->
          <div class="tree hidden" id="${treeId}">
            ${cl.sections.length ? renderTree(cl.sections, cl.questions, treeId) : '<div style="padding:12px;color:var(--text-muted);font-size:13px">No sections found.</div>'}
          </div>
        </div>
      </div>
    </div>
  `;
}

// ── FIX #5: TREE RENDERER — unique IDs, all questions, smooth toggle ──
function renderTree(sections, questions, parentId) {
  const qBySect = {};
  questions.forEach(q => {
    const sc = q['Section Code'];
    if (sc) {
      if (!qBySect[sc]) qBySect[sc] = [];
      qBySect[sc].push(q);
    }
  });

  let nodeCounter = 0;

  function renderNode(node, depth) {
    // FIX #5: truly unique node IDs by combining parentId + section code + counter
    nodeCounter++;
    const nodeId   = `${parentId}-n${nodeCounter}`;
    const nodeQ    = qBySect[node['Section Code']] || [];
    const children = node.children || [];
    const hasContent = children.length > 0 || nodeQ.length > 0;

    return `
      <div class="tree-node">
        <div class="tree-node-header" onclick="toggleTreeNode('${nodeId}', this)" style="padding-left:${depth * 12}px">
          <span class="tree-node-icon">${hasContent ? '▶' : '•'}</span>
          <span class="tree-node-name">${esc(node['Section Name'] || node['Section Code'])}</span>
          <span class="tree-node-count">${nodeQ.length > 0 ? `${nodeQ.length}q` : ''}${children.length > 0 ? ` ${children.length} sub` : ''}</span>
        </div>
        <div class="tree-children" id="${nodeId}">
          ${children.map(c => renderNode(c, depth + 1)).join('')}
          ${nodeQ.map((q, idx) => `
            <div class="tree-question" style="padding-left:${(depth + 1) * 12 + 8}px">
              <span class="tq-num">${idx + 1}.</span>
              <span class="tq-text">${esc(q['Question'] || q['Question Text'] || '')}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  return sections.map(s => renderNode(s, 0)).join('');
}

// ── ASSESSMENT CARD — FIX #2 #8 ───────────────────────────────
function renderAssessmentCard(a) {
  const dot    = `status-${a.status}`;
  const issues = a.issues;
  const qCount = a.questions.length;

  return `
    <div class="detail-card assessment-card" data-code="${esc(a.code)}">
      <div class="card-header" onclick="toggleCard(this)">
        <div class="card-status-dot ${dot}"></div>
        <div class="card-title-group">
          <div class="card-title">${esc(a.title || a.code)}</div>
          <div class="card-code">${esc(a.code)}</div>
          <div class="card-meta">
            ${a.offering   ? `<span class="meta-tag">🏢 ${esc(a.offering)}</span>`   : ''}
            ${a.profession ? `<span class="meta-tag">👤 ${esc(a.profession)}</span>` : ''}
            ${a.specialty  ? `<span class="meta-tag">🏷️ ${esc(a.specialty)}</span>`  : ''}
            <span class="meta-tag">❓ ${qCount} questions</span>
            ${a.totalQuestionsStated && a.totalQuestionsStated !== qCount ? `<span class="meta-tag" style="color:var(--amber);border-color:var(--amber)">⚠ stated: ${a.totalQuestionsStated}</span>` : ''}
            ${a.duration    ? `<span class="meta-tag">⏱ ${a.duration}min</span>` : ''}
            ${a.passingPct  ? `<span class="meta-tag">🎯 ${a.passingPct}%</span>` : ''}
          </div>
        </div>
        <div class="card-header-right">
          ${issues.length ? `<span class="issue-count-badge ${a.status}">${issues.length} issue${issues.length > 1 ? 's' : ''}</span>` : '<span class="issue-count-badge ok">✓ Clean</span>'}
          <span class="card-chevron">›</span>
        </div>
      </div>

      <div class="card-body">
        ${issues.length ? `
        <div class="card-issues">
          <div class="card-issues-header">Issues Found</div>
          ${issues.map(i => `<div class="issue-item ${i.level}"><div class="issue-dot"></div><div class="issue-text">${esc(i.msg)}</div></div>`).join('')}
        </div>` : '<div class="card-ok-bar">✓ No issues detected in this assessment</div>'}

        <div class="card-detail-grid">
          <div class="card-detail-row"><span class="cd-lbl">Offering</span><span class="cd-val">${esc(a.offering || '—')}</span></div>
          <div class="card-detail-row"><span class="cd-lbl">Profession</span><span class="cd-val">${esc(a.profession || '—')}</span></div>
          ${a.altProfession ? `<div class="card-detail-row"><span class="cd-lbl">Alt Profession</span><span class="cd-val">${esc(a.altProfession)}</span></div>` : ''}
          <div class="card-detail-row"><span class="cd-lbl">Specialty</span><span class="cd-val">${esc(a.specialty || '—')}</span></div>
          ${a.altSpecialty ? `<div class="card-detail-row"><span class="cd-lbl">Alt Specialty</span><span class="cd-val">${esc(a.altSpecialty)}</span></div>` : ''}
          <div class="card-detail-row"><span class="cd-lbl">Duration</span><span class="cd-val">${a.duration ? a.duration + ' min' : '—'}</span></div>
          <div class="card-detail-row"><span class="cd-lbl">Max Attempts</span><span class="cd-val">${esc(a.maxAttempts || '—')}</span></div>
          <div class="card-detail-row"><span class="cd-lbl">Passing %</span><span class="cd-val">${esc(a.passingPct || '—')}</span></div>
          <div class="card-detail-row"><span class="cd-lbl">Expiry</span><span class="cd-val">${a.expiryValue ? `${a.expiryValue} ${esc(a.expiryUnit || '')}` : '—'}</span></div>
          <div class="card-detail-row"><span class="cd-lbl">Due In Days</span><span class="cd-val">${esc(a.dueInDays || '—')}</span></div>
          <div class="card-detail-row"><span class="cd-lbl">Shuffle Q</span><span class="cd-val">${esc(a.shuffleQ ?? '—')}</span></div>
          <div class="card-detail-row"><span class="cd-lbl">Shuffle Opts</span><span class="cd-val">${esc(a.shuffleOpts ?? '—')}</span></div>
          <div class="card-detail-row"><span class="cd-lbl">Q Per Page</span><span class="cd-val">${esc(a.qPerPage || '—')}</span></div>
          <div class="card-detail-row"><span class="cd-lbl">Active</span><span class="cd-val">${esc(a.active ?? '—')}</span></div>
          <div class="card-detail-row"><span class="cd-lbl">Show Result</span><span class="cd-val">${esc(a.showResult ?? '—')}</span></div>
          <div class="card-detail-row"><span class="cd-lbl">Clinical Review</span><span class="cd-val">${esc(a.clinicallyReviewed || '—')}${a.clinicalReviewDate ? ` (${esc(String(a.clinicalReviewDate))})` : ''}</span></div>
        </div>

        ${a.description ? `
        <div class="card-description">
          <div class="cd-lbl" style="margin-bottom:4px">Description</div>
          <div class="cd-desc-text">${esc(a.description)}</div>
        </div>` : ''}

        <div class="questions-section">
          <div class="questions-header">
            <span class="tree-label">Questions (${qCount}) by Category</span>
          </div>
          ${renderAssessmentQuestions(a.questions)}
        </div>
      </div>
    </div>
  `;
}

function renderAssessmentQuestions(questions) {
  if (!questions.length) return '<div style="padding:12px;color:var(--text-muted)">No questions found.</div>';
  const byCategory = {};
  questions.forEach(q => {
    const cat = q['Question Category'] || 'Uncategorized';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(q);
  });

  return Object.entries(byCategory).map(([cat, qs]) => `
    <div class="q-category-block">
      <div class="q-category-header">${esc(cat)} <span class="q-category-count">${qs.length}</span></div>
      <div class="question-list">
        ${qs.map((q, i) => {
          let opts = {};
          try { opts = JSON.parse(q['Options'] || '{}'); } catch {}
          const correct  = q['Correct Answer'];
          const hasIssue = !correct || Object.keys(opts).length === 0;
          const isInactive = q['Question Active'] === 0 || q['Question Active'] === '0';
          return `<div class="q-item ${hasIssue ? 'has-issue' : ''} ${isInactive ? 'q-inactive' : ''}">
            <span class="q-num">${i + 1}</span>
            <div style="flex:1">
              <div class="q-text">${esc(q['Question Text'] || '')}</div>
              ${isInactive ? '<span class="q-inactive-badge">Inactive</span>' : ''}
              ${Object.keys(opts).length ? `
              <div class="options-grid">
                ${Object.entries(opts).map(([k, v]) => `<div class="opt-item ${k === correct ? 'correct' : ''}"><strong>${k}.</strong> ${esc(String(v))}</div>`).join('')}
              </div>` : '<div style="font-size:11px;color:var(--text-muted);margin-top:4px">⚠ No options / malformed JSON</div>'}
              ${!correct ? '<div style="font-size:11px;color:var(--red);margin-top:2px">⚠ Missing correct answer</div>' : ''}
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>
  `).join('');
}

// ── DB VIEW ────────────────────────────────────────────────────
function renderDBView() {
  document.querySelectorAll('.db-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.db-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      switchDBTab(tab.dataset.tab);
    });
  });
  switchDBTab('offerings');
}

function switchDBTab(tab) {
  state.dbTab = tab;
  const content = document.getElementById('db-content');
  const { db } = state;

  if (tab === 'offerings') {
    content.innerHTML = `
      <div class="db-table-wrap">
        <table>
          <thead><tr><th>ID</th><th>Offering Name</th><th>Professions</th></tr></thead>
          <tbody>
            ${db.offerings.map(o => {
              const profs = db.professions.filter(p => p.offering_id === o.id);
              return `<tr>
                <td><span class="mono">${esc(o.id)}</span></td>
                <td>${esc(o.offering)}</td>
                <td style="font-size:12px">${profs.map(p => `<span class="tag-pill" style="background:var(--indigo-bg);color:var(--indigo);margin:2px">${esc(p.code)}</span>`).join('')}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  } else if (tab === 'professions') {
    content.innerHTML = `
      <div class="db-table-wrap">
        <table>
          <thead><tr><th>ID</th><th>Code</th><th>Name</th><th>Offering</th><th>Specialties</th></tr></thead>
          <tbody>
            ${db.professions.map(p => {
              const offering = db.offerings.find(o => o.id === p.offering_id);
              const specs    = db.specialties.filter(s => s.profession_id === p.id);
              return `<tr>
                <td><span class="mono">${p.id}</span></td>
                <td><span class="mono">${esc(p.code)}</span></td>
                <td>${esc(p.name)}</td>
                <td><span class="tag-pill" style="background:var(--blue-bg);color:var(--blue)">${esc(offering?.offering || p.offering_id)}</span></td>
                <td style="font-size:11px">${specs.map(s => `<span class="tag-pill" style="background:var(--bg);border:1px solid var(--border);color:var(--text-muted);margin:2px">${esc(s.code)}</span>`).join('') || '<span style="color:var(--text-light)">none</span>'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  } else {
    content.innerHTML = `
      <div class="db-table-wrap">
        <table>
          <thead><tr><th>ID</th><th>Code</th><th>Name</th><th>Profession</th><th>Offering</th></tr></thead>
          <tbody>
            ${db.specialties.map(s => {
              const prof    = db.professions.find(p => p.id === s.profession_id);
              const offering = prof ? db.offerings.find(o => o.id === prof.offering_id) : null;
              return `<tr>
                <td><span class="mono">${s.id}</span></td>
                <td><span class="mono">${esc(s.code)}</span></td>
                <td>${esc(s.name)}</td>
                <td><span class="tag-pill" style="background:var(--indigo-bg);color:var(--indigo)">${esc(prof?.code || '?')} #${s.profession_id}</span></td>
                <td><span class="tag-pill" style="background:var(--blue-bg);color:var(--blue)">${esc(offering?.offering || '?')}</span></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`;
  }

  // Update sidebar active state
  if (state.view === 'db') {
    document.querySelectorAll('#sidebar-list li').forEach((li, i) => {
      li.classList.toggle('active', ['offerings', 'professions', 'specialties'][i] === tab);
    });
  }
}

// ── TOGGLE HELPERS — FIX #5 smooth expand ─────────────────────
function toggleCard(header) {
  const card    = header.closest('.detail-card');
  const body    = header.parentElement.querySelector('.card-body');
  const chevron = header.querySelector('.card-chevron');
  const isOpen  = body.classList.contains('open');

  // Collapse ALL cards in the same container first
  const container = card.closest('.cards-list');
  if (container) {
    container.querySelectorAll('.detail-card').forEach(c => {
      c.querySelector('.card-body')?.classList.remove('open');
      c.querySelector('.card-chevron')?.classList.remove('open');
      // Also hide any open trees inside collapsed cards
      c.querySelectorAll('.tree').forEach(t => t.classList.add('hidden'));
      c.querySelectorAll('.btn-sm[id^="btn-"]').forEach(b => { b.textContent = '▶ Show Tree'; });
    });
  }

  // If it was closed, open just this one
  if (!isOpen) {
    body.classList.add('open');
    chevron.classList.add('open');
  }

  const code = card?.dataset.code;
  if (code) {
    const nowOpen = body.classList.contains('open');
    if (state.view === 'checklist') state.checklist.selected = nowOpen ? code : null;
    else state.assessment.selected = nowOpen ? code : null;
    updateSidebar();
  }
}

function toggleTree(id, btn) {
  const tree = document.getElementById(id);
  
  console.log('toggleTree called:', id);
  const matches = document.querySelectorAll(`#${CSS.escape(id)}`);
  console.log('Matching elements:', matches.length);
  if (matches.length > 1) {
    console.error('DUPLICATE TREE IDs:', id, matches);
  }
  console.log('Resolved tree:', tree);
  if (!tree) {
    console.error('Tree not found:', id);
    return;
  }

  const isHidden = tree.classList.contains('hidden');
  if (isHidden) {
    tree.classList.remove('hidden');
    btn.textContent = '▼ Hide Tree';
  } else {
    tree.classList.add('hidden');
    btn.textContent = '▶ Show Tree';
  }
}

// FIX #5: toggleTreeNode uses the exact element id, no global conflicts
function toggleTreeNode(id, header) {
  const children = document.getElementById(id);
  if (!children) return;
  const isOpen = children.classList.toggle('open');
  const icon = header.querySelector('.tree-node-icon');
  if (icon) icon.textContent = isOpen ? '▼' : '▶';
}

function togglePanel(header) {
  const body   = header.nextElementSibling;
  const toggle = header.querySelector('.panel-toggle');
  const collapsed = body.classList.toggle('collapsed');
  toggle.classList.toggle('open', !collapsed);
}

function expandAll(containerId) {
  document.querySelectorAll(`#${containerId} .card-body`).forEach(b => b.classList.add('open'));
  document.querySelectorAll(`#${containerId} .card-chevron`).forEach(c => c.classList.add('open'));
}

function collapseAll(containerId) {
  document.querySelectorAll(`#${containerId} .card-body`).forEach(b => b.classList.remove('open'));
  document.querySelectorAll(`#${containerId} .card-chevron`).forEach(c => c.classList.remove('open'));
}

// ── UTILS ──────────────────────────────────────────────────────
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function debugDuplicateIds() {
  const elements = [...document.querySelectorAll('[id]')];

  const map = new Map();
  const duplicates = [];

  elements.forEach(el => {
    const id = el.id;

    if (map.has(id)) {
      duplicates.push({
        id,
        first: map.get(id),
        duplicate: el
      });
    } else {
      map.set(id, el);
    }
  });

  if (duplicates.length === 0) {
    console.log('✅ No duplicate IDs found');
    return;
  }

  console.error('❌ Duplicate IDs found:', duplicates);

  duplicates.forEach(d => {
    console.log('Duplicate ID:', d.id);
    console.log('First Element:', d.first);
    console.log('Duplicate Element:', d.duplicate);
  });
}
