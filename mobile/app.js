/* ═══════════════════════════════════════════════════════════════════════════
   Life Tracker — app.js
   ═══════════════════════════════════════════════════════════════════════════ */

// ── Global state ─────────────────────────────────────────────────────────────
let _categories  = [];
let _items       = [];
let _currentSort = 'manual';

// Entry modal state
let _modalItemId   = null;
let _modalDate     = null;
let _modalEntryId  = null;
let _modalItem     = null;
let _selectedOptId = null;
let _notesOnly     = false;  // opened via pencil on a "none" type item

// Calendar state
let _calYear  = null;
let _calMonth = null;
let _calData  = {};
let _selectedCalDate = null;

// List view navigation
let _listOffset = 0;   // days back from today (0 = current week)

// Drag & drop state (list view)
let _dragSrcIndex = null;

// ── Helpers ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

async function api(path, opts = {}) {
  // Route to local IndexedDB instead of Flask server
  return localApi(path, opts);
}

function formatDate(d) {
  // d = Date object or ISO string
  const dt = typeof d === 'string' ? new Date(d + 'T00:00:00') : d;
  return dt.toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayISO() { return isoDate(new Date()); }

const DOW_SHORT = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
const MONTH_NAMES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                     'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

// Returns hex color for a discrete option given item and option index
function resolveOptionColor(item, option, optionIndex) {
  const mode = item.color_mode || 'category';
  const allOpts = item.options || [];
  const n = allOpts.length;

  if (mode === 'preset') {
    return option.color;
  }
  if (mode === 'gradient') {
    const stops = item.gradient_colors || [];
    if (!stops.length) return option.color;
    return interpolateGradient(stops, n > 1 ? optionIndex / (n - 1) : 0);
  }
  // mode === 'category'
  const base = item.category ? item.category.color : '#7c6ef7';
  return lightnessVariant(base, n, optionIndex);
}

function interpolateGradient(stops, t) {
  // t in [0,1], stops = array of 2 or 3 hex colors
  if (stops.length === 1) return stops[0];
  if (stops.length === 2) return lerpHex(stops[0], stops[1], t);
  // 3 stops: first half [0..0.5] → stop0→stop1, second half [0.5..1] → stop1→stop2
  if (t <= 0.5) return lerpHex(stops[0], stops[1], t * 2);
  return lerpHex(stops[1], stops[2], (t - 0.5) * 2);
}

function lerpHex(a, b, t) {
  const ra = parseInt(a.slice(1,3),16), ga = parseInt(a.slice(3,5),16), ba2 = parseInt(a.slice(5,7),16);
  const rb = parseInt(b.slice(1,3),16), gb = parseInt(b.slice(3,5),16), bb2 = parseInt(b.slice(5,7),16);
  const r = Math.round(ra + (rb-ra)*t);
  const g = Math.round(ga + (gb-ga)*t);
  const bl = Math.round(ba2 + (bb2-ba2)*t);
  return '#' + [r,g,bl].map(v => v.toString(16).padStart(2,'0')).join('');
}

function lightnessVariant(hex, total, index) {
  // Generate variants by adjusting lightness around the base color
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  // Shift: darker for low index, lighter for high
  const step = 40 / Math.max(total - 1, 1);
  const shift = -20 + step * index;
  const clamp = v => Math.max(0, Math.min(255, v + shift));
  return '#' + [clamp(r),clamp(g),clamp(b)].map(v=>Math.round(v).toString(16).padStart(2,'0')).join('');
}

function contrastColor(hex) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  const luminance = (0.299*r + 0.587*g + 0.114*b) / 255;
  return luminance > 0.55 ? '#111' : '#fff';
}

// ── Data cache ────────────────────────────────────────────────────────────────
// Categories and items are fetched once and cached. Call invalidateCache()
// after any mutation so the next read re-fetches from the server.

let _cacheValid    = false;
let _itemsById     = {};   // id → item  (rebuilt on each cache refresh)
let _optsByItemId  = {};   // itemId → { optId → option }

async function ensureCache() {
  if (_cacheValid) return;
  [_categories, _items] = await Promise.all([
    api('/api/categories'),
    api('/api/items?include_counts=true'),
  ]);
  _rebuildMaps();
  _cacheValid = true;
}

function _rebuildMaps() {
  _itemsById    = {};
  _optsByItemId = {};
  _items.forEach(item => {
    _itemsById[item.id] = item;
    _optsByItemId[item.id] = {};
    (item.options || []).forEach(o => { _optsByItemId[item.id][o.id] = o; });
  });
}

function invalidateCache() {
  _cacheValid = false;
}

// Legacy shims so existing call sites keep working without changes
async function loadCategories() {
  await ensureCache();
  return _categories;
}

async function loadItems() {
  await ensureCache();
  return _items;
}

// ── Debounced search ──────────────────────────────────────────────────────────
let _searchDebounceTimer = null;

function filterList(q) {
  clearTimeout(_searchDebounceTimer);
  _searchDebounceTimer = setTimeout(() => {
    renderListView(q.toLowerCase());
  }, 200);
}

// ── Entry Modal ───────────────────────────────────────────────────────────────

function openNewEntryModal() {
  _modalEntryId  = null;
  _modalItemId   = null;
  _modalItem     = null;
  _selectedOptId = null;
  _notesOnly     = false;

  $('modal-entry-id').value     = '';
  $('modal-item-id').value      = '';
  $('modal-date').value         = todayISO();
  $('modal-notes').value        = '';
  $('modal-value').value        = '';
  $('modal-item-name-text').textContent = 'Nueva entrada';
  $('modal-item-dot').style.background = 'var(--text-muted)';
  $('modal-date-label').textContent    = '';

  // Show date field & item selector, hide value/discrete
  show('modal-date-field');
  show('modal-item-selector-field');
  hide('modal-value-field');
  hide('modal-discrete-field');
  hide('modal-delete-btn');

  // Populate item selector with category-first flow
  renderCategorySelector();

  $('entry-modal').classList.remove('hidden');
}

async function openEntryModal(itemId, dateISO, entryId = null, notesOnly = false) {
  await loadCategories();
  await loadItems();

  _modalItemId   = itemId;
  _modalDate     = dateISO;
  _modalEntryId  = entryId;
  _notesOnly     = notesOnly;
  _selectedOptId = null;

  _modalItem = _items.find(i => i.id === itemId) || null;

  // Header
  if (_modalItem) {
    $('modal-item-name-text').textContent = _modalItem.name;
    $('modal-item-dot').style.background  = _modalItem.category?.color || 'var(--text-muted)';
  } else {
    $('modal-item-name-text').textContent = 'Nueva entrada';
    $('modal-item-dot').style.background  = 'var(--text-muted)';
  }

  $('modal-date-label').textContent = dateISO ? formatDate(dateISO) : '';
  $('modal-date').value = dateISO || todayISO();
  $('modal-notes').value = '';
  $('modal-value').value = '';
  $('modal-entry-id').value = entryId || '';
  $('modal-item-id').value  = itemId  || '';

  // Show/hide date field (always visible in modal)
  show('modal-date-field');
  hide('modal-item-selector-field');

  // Show/hide fields based on item type
  if (_modalItem) {
    setupModalFields(_modalItem, notesOnly);
  }

  // If editing, load existing values
  if (entryId) {
    $('modal-delete-btn').classList.remove('hidden');
    try {
      const entry = await api(`/api/entries/${entryId}`);
      $('modal-notes').value = entry.notes || '';
      if (_modalItem?.value_type === 'numeric') {
        $('modal-value').value = entry.value ?? '';
      }
      if (_modalItem?.value_type === 'discrete' && entry.option_id) {
        _selectedOptId = entry.option_id;
        renderOptionPills(_modalItem, _selectedOptId);
      }
    } catch (e) { /* ignore */ }
  } else {
    $('modal-delete-btn').classList.add('hidden');
  }

  $('entry-modal').classList.remove('hidden');

  // Focus appropriate field
  if (notesOnly) {
    setTimeout(() => $('modal-notes').focus(), 80);
  } else if (_modalItem?.value_type === 'numeric') {
    setTimeout(() => $('modal-value').focus(), 80);
  }
}

function setupModalFields(item, notesOnly) {
  if (notesOnly || item.value_type === 'none') {
    hide('modal-value-field');
    hide('modal-discrete-field');
    return;
  }
  if (item.value_type === 'numeric') {
    show('modal-value-field');
    hide('modal-discrete-field');
    $('modal-unit-badge').textContent = item.default_unit || '';
    const reqBadge = $('modal-value-required-badge');
    if (item.value_required) reqBadge.classList.remove('hidden');
    else reqBadge.classList.add('hidden');
  }
  if (item.value_type === 'discrete') {
    hide('modal-value-field');
    show('modal-discrete-field');
    renderOptionPills(item, null);
  }
}

function renderOptionPills(item, selectedId) {
  const container = $('modal-option-pills');
  container.innerHTML = '';
  (item.options || []).forEach((opt, idx) => {
    const color = resolveOptionColor(item, opt, idx);
    const pill = document.createElement('div');
    pill.className = 'option-pill' + (opt.id === selectedId ? ' selected' : '');
    pill.textContent = opt.label;
    pill.style.background = color;
    pill.style.color = contrastColor(color);
    pill.onclick = () => {
      _selectedOptId = opt.id;
      container.querySelectorAll('.option-pill').forEach(p => p.classList.remove('selected'));
      pill.classList.add('selected');
    };
    container.appendChild(pill);
  });
}

function renderItemSelectorList(selectedItemId) {
  const list = $('modal-item-selector-list');
  list.innerHTML = '';
  // Group by category
  const byCat = {};
  _items.forEach(item => {
    const cid = item.category_id;
    if (!byCat[cid]) byCat[cid] = { cat: item.category, items: [] };
    byCat[cid].items.push(item);
  });
  Object.values(byCat).forEach(group => {
    group.items.forEach(item => {
      const row = document.createElement('div');
      row.className = 'item-selector-item' + (item.id === selectedItemId ? ' selected' : '');
      row.innerHTML = `
        <span class="item-selector-cat" style="background:${group.cat?.color||'#888'}"></span>
        <span class="item-selector-name">${item.name}</span>
        <span class="item-selector-cat-name">${group.cat?.name||''}</span>
      `;
      row.onclick = () => {
        _modalItemId = item.id;
        _modalItem   = item;
        $('modal-item-id').value = item.id;
        $('modal-item-name-text').textContent = item.name;
        $('modal-item-dot').style.background = group.cat?.color || 'var(--text-muted)';
        list.querySelectorAll('.item-selector-item').forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
        hide('modal-item-selector-field');
        setupModalFields(item, false);
      };
      list.appendChild(row);
    });
  });
}

async function saveEntry() {
  const itemId = _modalItemId || parseInt($('modal-item-id').value);
  const item   = _modalItem || _items.find(i => i.id === itemId);

  if (!itemId) { toast('Selecciona un ítem', 'error'); return; }

  const dateVal = $('modal-date').value;
  if (!dateVal) { toast('Indica la fecha', 'error'); return; }

  // Validate required numeric value
  if (item?.value_required && item?.value_type === 'numeric') {
    if (!$('modal-value').value) {
      toast('El valor numérico es obligatorio para este ítem', 'error');
      return;
    }
  }

  // Validate discrete selection required
  if (item?.value_type === 'discrete' && !_selectedOptId && (item.options||[]).length > 0) {
    toast('Selecciona una opción', 'error');
    return;
  }

  const payload = {
    date:      dateVal,
    item_id:   itemId,
    notes:     $('modal-notes').value.trim() || null,
    value:     item?.value_type === 'numeric' && $('modal-value').value ? parseFloat($('modal-value').value) : null,
    unit:      item?.default_unit || null,
    option_id: item?.value_type === 'discrete' ? _selectedOptId : null,
  };

  try {
    if (_modalEntryId) {
      await api(`/api/entries/${_modalEntryId}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast('Entrada actualizada');
    } else {
      await api('/api/entries', { method: 'POST', body: JSON.stringify(payload) });
      toast('Entrada guardada');
    }
    closeEntryModal();
    refreshCurrentView();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function deleteCurrentEntry() {
  if (!_modalEntryId) return;
  if (!confirm('¿Eliminar esta entrada?')) return;
  try {
    await api(`/api/entries/${_modalEntryId}`, { method: 'DELETE' });
    toast('Entrada eliminada');
    closeEntryModal();
    refreshCurrentView();
  } catch (e) { toast(e.message, 'error'); }
}

function closeEntryModal() {
  $('entry-modal').classList.add('hidden');
  _modalItemId   = null;
  _modalDate     = null;
  _modalEntryId  = null;
  _modalItem     = null;
  _selectedOptId = null;
}

function refreshCurrentView() {
  const view = window._currentView || 'list';
  if (view === 'list') renderListView();
  else if (view === 'calendar') calLoad();
  else if (view === 'settings') initSettingsView();
}

function show(id) { $(id)?.classList.remove('hidden'); }
function hide(id) { $(id)?.classList.add('hidden'); }

// ── LIST VIEW ─────────────────────────────────────────────────────────────────

async function initListView() {
  await loadCategories();
  await loadItems();
  renderListView();
}

function setSort(btn, sort) {
  _currentSort = sort;
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderListView();
}

function getLast14Days() {
  const isMobile = window.innerWidth <= 700;
  const count = isMobile ? 5 : 14;
  const days = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i - _listOffset);
    days.push(d);
  }
  return days;
}

function shiftListDays(delta) {
  // delta > 0 = go further into the past, delta < 0 = come toward today
  _listOffset += delta;
  if (_listOffset < 0) _listOffset = 0;   // can't go into the future
  renderListView($('list-search')?.value?.toLowerCase() || '');
}

async function renderListView(search = '') {
  await loadItems();
  const days = getLast14Days();
  const todayStr = todayISO();

  // Update navigation label and button state
  const rangeLabel = $('list-range-label');
  const nextBtn    = $('list-next-btn');
  if (rangeLabel) {
    const from = days[0];
    const to   = days[13];
    const fmt = d => d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
    rangeLabel.textContent = `${fmt(from)} – ${fmt(to)}`;
  }
  if (nextBtn) {
    nextBtn.disabled = _listOffset === 0;
    nextBtn.style.opacity = _listOffset === 0 ? '0.35' : '1';
  }

  // Fetch entries for the 14-day window
  const fromISO = isoDate(days[0]);
  const toISO   = isoDate(days[13]);
  const entries = await api(`/api/entries?date_from=${fromISO}&date_to=${toISO}`);

  // Build lookup: itemId → dateISO → [entry]
  const entryMap = {};
  entries.forEach(e => {
    if (!entryMap[e.item_id]) entryMap[e.item_id] = {};
    if (!entryMap[e.item_id][e.date]) entryMap[e.item_id][e.date] = [];
    entryMap[e.item_id][e.date].push(e);
  });

  // Sort items
  let items = [..._items];
  if (search) items = items.filter(i => i.name.toLowerCase().includes(search) || i.category?.name.toLowerCase().includes(search));

  if (_currentSort === 'alpha') {
    items.sort((a,b) => a.name.localeCompare(b.name,'es'));
  } else if (_currentSort === 'cat') {
    items.sort((a,b) => (a.category?.name||'').localeCompare(b.category?.name||'','es') || a.name.localeCompare(b.name,'es'));
  } else if (_currentSort === 'freq') {
    items.sort((a,b) => (b.recent_count||0) - (a.recent_count||0));
  } else {
    items.sort((a,b) => a.sort_order - b.sort_order);
  }

  const wrap = $('list-wrap');
  wrap.innerHTML = '';

  // Header row (day names)
  const isMobile = window.innerWidth <= 700;
  const header = document.createElement('div');
  header.className = 'list-header-row';
  if (isMobile) {
    header.style.gridTemplateColumns = `130px repeat(${days.length}, 1fr)`;
  }
  header.innerHTML = `<div class="item-col-head">Ítem</div>`;
  days.forEach(d => {
    const iso = isoDate(d);
    const isToday = iso === todayStr;
    header.innerHTML += `
      <div class="day-head${isToday ? ' today' : ''}">
        <span class="dn">${DOW_SHORT[d.getDay()]}</span>
        <span class="dd">${d.getDate()}</span>
      </div>
    `;
  });
  wrap.appendChild(header);

  // Rows (grouped by category when sort = cat)
  let lastCatId = null;
  items.forEach((item, rowIndex) => {
    // Category divider when sorting by category
    if (_currentSort === 'cat' && item.category_id !== lastCatId) {
      lastCatId = item.category_id;
      const div = document.createElement('div');
      div.className = 'category-header-row';
      div.innerHTML = `
        <span class="cat-dot" style="background:${item.category?.color||'#888'}"></span>
        <span class="cat-label">${item.category?.name||'Sin categoría'}</span>
      `;
      wrap.appendChild(div);
    }

    const row = document.createElement('div');
    row.className = 'list-row';
    row.draggable = _currentSort === 'manual';
    row.dataset.itemId = item.id;
    row.dataset.rowIndex = rowIndex;
    if (isMobile) {
      row.style.gridTemplateColumns = `130px repeat(${days.length}, 1fr)`;
    }

    if (_currentSort === 'manual') {
      row.addEventListener('dragstart', onDragStart);
      row.addEventListener('dragover',  onDragOver);
      row.addEventListener('drop',      onDrop);
      row.addEventListener('dragend',   onDragEnd);
    }

    // Item name column
    const catColor = item.category?.color || '#888';
    const itemCol = document.createElement('div');
    itemCol.className = 'item-col';
    itemCol.innerHTML = `
      ${_currentSort === 'manual' ? '<span class="drag-handle" title="Arrastrar para reordenar">⠿</span>' : ''}
      <span class="cat-stripe" style="background:${catColor}"></span>
      <div>
        <div class="item-name item-name-link" data-item-id="${item.id}">${item.name}</div>
        <div class="text-sm text-muted">${item.category?.name||''}</div>
      </div>
    `;
    itemCol.querySelector('.item-name-link').addEventListener('click', e => {
      e.stopPropagation();
      openItemYearPanel(item);
    });
    row.appendChild(itemCol);

    // Day cells
    days.forEach(d => {
      const iso   = isoDate(d);
      const isToday = iso === todayStr;
      const dayEntries = entryMap[item.id]?.[iso] || [];
      const hasEntry = dayEntries.length > 0;
      const entry = dayEntries[0] || null;

      const cell = document.createElement('div');
      cell.className = `day-cell${isToday ? ' today-col' : ''}`;

      const inner = document.createElement('div');
      inner.className = 'cell-inner';

      if (hasEntry) {
        // Show content based on item type
        if (item.value_type === 'numeric' && entry.value != null) {
          const valEl = document.createElement('div');
          valEl.className = 'cell-value';
          valEl.textContent = entry.value;
          inner.appendChild(valEl);
          if (entry.unit) {
            const unitEl = document.createElement('div');
            unitEl.className = 'cell-unit';
            unitEl.textContent = entry.unit;
            inner.appendChild(unitEl);
          }
        } else if (item.value_type === 'discrete' && entry.option) {
          const optIdx = (item.options||[]).findIndex(o => o.id === entry.option_id);
          const color = resolveOptionColor(item, entry.option, optIdx);
          const chip = document.createElement('div');
          chip.className = 'cell-discrete';
          chip.textContent = entry.option.label;
          chip.style.background = color;
          chip.style.color = contrastColor(color);
          inner.appendChild(chip);
        } else {
          // Always show tick
          const check = document.createElement('div');
          check.className = 'cell-check';
          check.textContent = '✓';
          inner.appendChild(check);
        }

        // Notes dot: always shown on top-right when notes exist, regardless of type
        if (entry.notes) {
          const dot = document.createElement('div');
          dot.className = 'cell-notes-dot';
          cell.appendChild(dot);
        }

        // Click → open entry detail
        cell.onclick = (e) => {
          if (e.target.closest('.pencil-btn')) return;
          openEntryModal(item.id, iso, entry.id, false);
        };
      } else {
        // Empty cell: click to create
        cell.onclick = (e) => {
          if (e.target.closest('.pencil-btn')) return;
          const needsValue = item.value_type === 'numeric' && item.value_required;
          const needsDiscrete = item.value_type === 'discrete' && (item.options||[]).length > 0;
          if (needsValue || needsDiscrete) {
            // Must open modal
            openEntryModal(item.id, iso, null, false);
          } else {
            // Create immediately
            quickCreateEntry(item, iso);
          }
        };
      }

      // Pencil button
      const pencil = document.createElement('button');
      pencil.className = 'pencil-btn';
      pencil.title = 'Añadir con notas';
      pencil.textContent = '✏';
      pencil.onclick = (e) => {
        e.stopPropagation();
        if (hasEntry) {
          openEntryModal(item.id, iso, entry.id, false);
        } else {
          openEntryModal(item.id, iso, null, item.value_type === 'none');
        }
      };
      cell.appendChild(inner);
      cell.appendChild(pencil);
      row.appendChild(cell);
    });

    wrap.appendChild(row);
  });

  if (items.length === 0) {
    wrap.innerHTML += `<div style="color:var(--text-muted);padding:32px;text-align:center;font-size:14px">
      ${search ? 'No se encontraron ítems.' : 'Aún no tienes ítems. <a href="/settings" style="color:var(--accent)">Crea uno en Configuración →</a>'}
    </div>`;
  }
}

async function quickCreateEntry(item, dateISO) {
  try {
    await api('/api/entries', {
      method: 'POST',
      body: JSON.stringify({ date: dateISO, item_id: item.id }),
    });
    toast(`${item.name} registrado`);
    renderListView($('list-search')?.value?.toLowerCase() || '');
  } catch (e) { toast(e.message, 'error'); }
}

// ── Drag & drop ───────────────────────────────────────────────────────────────
let _dragItems = [];

function onDragStart(e) {
  _dragSrcIndex = parseInt(e.currentTarget.dataset.rowIndex);
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.list-row').forEach(r => r.classList.remove('drag-over'));
  e.currentTarget.classList.add('drag-over');
}

function onDrop(e) {
  e.preventDefault();
  const targetIndex = parseInt(e.currentTarget.dataset.rowIndex);
  if (targetIndex === _dragSrcIndex) return;

  const rows  = [...document.querySelectorAll('.list-row')];
  const visibleItems = rows.map(r => _items.find(i => i.id === parseInt(r.dataset.itemId))).filter(Boolean);

  const moved = visibleItems.splice(_dragSrcIndex, 1)[0];
  visibleItems.splice(targetIndex, 0, moved);

  const reorderPayload = visibleItems.map((item, idx) => ({ id: item.id, sort_order: idx }));
  api('/api/items/reorder', { method: 'PUT', body: JSON.stringify(reorderPayload) })
    .then(() => { invalidateCache(); return ensureCache(); })
    .then(() => renderListView($('list-search')?.value?.toLowerCase() || ''))
    .catch(e => toast(e.message, 'error'));
}

function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.list-row').forEach(r => r.classList.remove('drag-over'));
}

// ── ITEM YEAR PANEL ───────────────────────────────────────────────────────────

let _itemPanelItem  = null;
let _itemPanelYear  = null;

function openItemYearPanel(item) {
  _itemPanelItem = item;
  _itemPanelYear = new Date().getFullYear();

  const panel = $('item-year-panel');
  panel.classList.add('open');

  renderItemYearPanel();
}

function closeItemYearPanel() {
  $('item-year-panel').classList.remove('open');
  _itemPanelItem = null;
}

async function renderItemYearPanel() {
  const item      = _itemPanelItem;
  const year      = _itemPanelYear;
  const today     = new Date();
  today.setHours(0,0,0,0);
  const isThisYear = year === today.getFullYear();

  // Header
  $('item-panel-title').textContent = item.name;
  $('item-panel-year').textContent  = String(year);
  $('item-panel-cat').textContent   = item.category?.name || '';
  $('item-panel-cat').style.color   = item.category?.color || 'var(--text-muted)';

  const nextBtn = $('item-panel-next-btn');
  if (nextBtn) {
    nextBtn.disabled      = isThisYear;
    nextBtn.style.opacity = isThisYear ? '0.35' : '1';
  }

  // Date range: Jan 1 → Dec 31 (or today)
  const rangeStart = new Date(year, 0, 1);
  const rangeEnd   = isThisYear ? new Date(today) : new Date(year, 11, 31);
  const tableStart = getMondayOf(rangeStart);

  // Build week rows
  const weekStarts = [];
  for (let d = new Date(tableStart); d <= rangeEnd; d.setDate(d.getDate() + 7)) {
    weekStarts.push(new Date(d));
  }

  // Fetch entries for this item over the year
  const entries = await api(`/api/entries?item_id=${item.id}&date_from=${isoDate(rangeStart)}&date_to=${isoDate(rangeEnd)}`);
  const byDate  = {};
  entries.forEach(e => { byDate[e.date] = e; });

  // Render the weekly grid
  const body = $('item-panel-body');
  body.innerHTML = '';

  // DOW header row
  const headRow = document.createElement('div');
  headRow.className = 'item-panel-dow-row';
  headRow.innerHTML = '<div class="item-panel-month-col"></div>';
  ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'].forEach(d => {
    const h = document.createElement('div');
    h.className   = 'item-panel-dow-head';
    h.textContent = d;
    headRow.appendChild(h);
  });
  body.appendChild(headRow);

  // Week rows
  let prevMonth = -1;
  weekStarts.forEach(mon => {
    const row = document.createElement('div');
    row.className = 'item-panel-week-row';

    // Month label: show on the row that contains the 1st of a new month
    const monthLabel = document.createElement('div');
    monthLabel.className = 'item-panel-month-col';
    for (let d = 0; d < 7; d++) {
      const day = new Date(mon);
      day.setDate(mon.getDate() + d);
      if (day.getDate() === 1) {
        monthLabel.textContent = MONTH_SHORT[day.getMonth()];
        prevMonth = day.getMonth();
        break;
      }
    }
    row.appendChild(monthLabel);

    // 7 day cells
    for (let dow = 0; dow < 7; dow++) {
      const day = new Date(mon);
      day.setDate(mon.getDate() + dow);

      const iso        = isoDate(day);
      const isToday    = iso === todayISO();
      const outOfRange = day < rangeStart || day > rangeEnd;
      const entry      = byDate[iso] || null;

      // Detect month boundary: this cell is the 1st of a month (and not the first column)
      const isMonthStart = day.getDate() === 1 && dow > 0;
      // Previous cell is last of month if next day is the 1st
      const nextDay = new Date(day); nextDay.setDate(day.getDate() + 1);
      const isMonthEnd   = nextDay.getDate() === 1 && dow < 6;

      const cell = document.createElement('div');
      cell.className = 'item-panel-cell' +
        (isToday      ? ' item-panel-today'       : '') +
        (outOfRange   ? ' item-panel-outside'     : '') +
        (entry        ? ' item-panel-has'         : '') +
        (isMonthStart ? ' item-panel-month-start' : '') +
        (isMonthEnd   ? ' item-panel-month-end'   : '');

      // Day number
      const num = document.createElement('div');
      num.className   = 'item-panel-day-num';
      num.textContent = day.getDate();
      cell.appendChild(num);

      if (entry && !outOfRange) {
        const catColor = item.category?.color || '#888';
        let bgColor    = catColor;

        if (item.value_type === 'discrete' && entry.option) {
          const optIdx = (item.options||[]).findIndex(o => o.id === entry.option_id);
          bgColor = resolveOptionColor(item, entry.option, optIdx);
        }

        cell.style.background  = bgColor + '33';
        cell.style.borderColor = bgColor;

        const valEl = document.createElement('div');
        valEl.className = 'item-panel-val';
        if (item.value_type === 'numeric' && entry.value != null) {
          valEl.textContent = `${entry.value}${entry.unit ? ' ' + entry.unit : ''}`;
        } else if (item.value_type === 'discrete' && entry.option) {
          valEl.textContent = entry.option.label;
          valEl.style.color = bgColor;
        } else {
          valEl.textContent = '✓';
          valEl.style.color = catColor;
        }
        cell.appendChild(valEl);

        if (entry.notes) {
          const dot = document.createElement('div');
          dot.className = 'cell-notes-dot';
          cell.appendChild(dot);
          // Note tooltip
          cell.dataset.note = entry.notes;
          cell.classList.add('has-note-tip');
        }

        cell.onclick = () => openEntryModal(item.id, iso, entry.id, false);
      } else if (!outOfRange) {
        cell.onclick = () => {
          if (item.value_type === 'numeric' && item.value_required) {
            openEntryModal(item.id, iso, null, false);
          } else if (item.value_type === 'discrete' && (item.options||[]).length) {
            openEntryModal(item.id, iso, null, false);
          } else {
            quickCreateEntry(item, iso).then(() => renderItemYearPanel());
          }
        };
      }

      row.appendChild(cell);
    }

    body.appendChild(row);
  });

  // Scroll to bottom (most recent weeks)
  requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });

  // Wire note tooltips
  initPanelTooltip(body);
}

// ── Item panel note tooltip ────────────────────────────────────────────────────
let _panelTtEl = null;

function initPanelTooltip(container) {
  if (!_panelTtEl) {
    _panelTtEl = document.createElement('div');
    _panelTtEl.className = 'year-tooltip';
    document.body.appendChild(_panelTtEl);
  }

  container.addEventListener('mouseover', e => {
    const cell = e.target.closest('.has-note-tip');
    if (!cell) { _panelTtEl.classList.remove('visible'); return; }
    _panelTtEl.textContent = cell.dataset.note || '';
    _panelTtEl.classList.add('visible');
  });
  container.addEventListener('mousemove', e => {
    if (!_panelTtEl.classList.contains('visible')) return;
    const gap = 14;
    let x = e.clientX + gap, y = e.clientY + gap;
    const tw = _panelTtEl.offsetWidth, th = _panelTtEl.offsetHeight;
    if (x + tw > window.innerWidth  - 8) x = e.clientX - tw - gap;
    if (y + th > window.innerHeight - 8) y = e.clientY - th - gap;
    _panelTtEl.style.left = x + 'px';
    _panelTtEl.style.top  = y + 'px';
  });
  container.addEventListener('mouseout', e => {
    if (!e.target.closest('.has-note-tip')) _panelTtEl.classList.remove('visible');
  });
}

// ── CALENDAR VIEW ─────────────────────────────────────────────────────────────

// ── Calendar wheel navigation ─────────────────────────────────────────────────
let _wheelThrottleTimer = null;

function initCalendarWheel() {
  document.addEventListener('wheel', (e) => {
    // Only active on calendar page
    if (window._currentView !== 'calendar') return;
    // Ignore if over the detail panel (it may scroll)
    if (e.target.closest('#detail-panel')) return;

    // Throttle: prevent default immediately, then debounce the action
    e.preventDefault();

    if (_wheelThrottleTimer) return;
    _wheelThrottleTimer = setTimeout(() => { _wheelThrottleTimer = null; }, 350);

    const dir = e.deltaY > 0 ? 7 : -7;
    const anchor = new Date(_calYear, _calMonth - 1, 15);
    anchor.setDate(anchor.getDate() + dir);
    _calYear  = anchor.getFullYear();
    _calMonth = anchor.getMonth() + 1;
    calLoad();
  }, { passive: false });
}

// ── Calendar drag & drop ──────────────────────────────────────────────────────
let _calDragEntryId = null;
let _calDragSrcDate = null;

function makeChipDraggable(chipEl, entryId, srcDate) {
  chipEl.draggable = true;
  chipEl.addEventListener('dragstart', e => {
    _calDragEntryId = entryId;
    _calDragSrcDate = srcDate;
    e.dataTransfer.effectAllowed = 'move';
    chipEl.style.opacity = '0.4';
  });
  chipEl.addEventListener('dragend', () => {
    chipEl.style.opacity = '';
    document.querySelectorAll('.cal-day').forEach(d => {
      d.classList.remove('cal-drag-over');
    });
  });
}

function makeCalDayDropTarget(dayEl, dateISO) {
  dayEl.addEventListener('dragover', e => {
    if (!_calDragEntryId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.cal-day').forEach(d => d.classList.remove('cal-drag-over'));
    dayEl.classList.add('cal-drag-over');
  });
  dayEl.addEventListener('dragleave', () => {
    dayEl.classList.remove('cal-drag-over');
  });
  dayEl.addEventListener('drop', async e => {
    e.preventDefault();
    dayEl.classList.remove('cal-drag-over');
    if (!_calDragEntryId || dateISO === _calDragSrcDate) return;
    try {
      await api(`/api/entries/${_calDragEntryId}`, {
        method: 'PUT',
        body: JSON.stringify({ date: dateISO }),
      });
      toast('Entrada movida');
      _calDragEntryId = null;
      _calDragSrcDate = null;
      calLoad();
      if (_selectedCalDate) {
        // Refresh detail panel
        const entries = await api(`/api/entries?date=${_selectedCalDate}`);
        openDayDetail(_selectedCalDate, entries);
      }
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function initCalendarView() {
  const today = new Date();
  _calYear  = today.getFullYear();
  _calMonth = today.getMonth() + 1;
  await loadCategories();
  await loadItems();
  populateCalFilters();
  initCalendarWheel();
  calLoad();
}

// ── View switching (month / year) ─────────────────────────────────────────────
let _calView      = 'month';
let _yearDisplayed = new Date().getFullYear();   // calendar year shown in year view

const MONTH_SHORT = ['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
const DOW_LABELS  = ['lun','mar','mié','jue','vie','sáb','dom'];

function switchCalView(view) {
  _calView = view;
  $('view-btn-month')?.classList.toggle('active', view === 'month');
  $('view-btn-year')?.classList.toggle('active',  view === 'year');
  $('view-month')?.classList.toggle('hidden', view !== 'month');
  $('view-year')?.classList.toggle('hidden',  view !== 'year');
  if (view === 'year') loadYearView();
}

function yearNav(dir) {
  // dir: -1 = previous year, +1 = next year (capped at current)
  const currentYear = new Date().getFullYear();
  _yearDisplayed = Math.min(currentYear, _yearDisplayed + dir);
  loadYearView();
}

function yearGoToday() {
  _yearDisplayed = new Date().getFullYear();
  loadYearView();
}

// Returns the Monday of the week containing date d
function getMondayOf(d) {
  const day = new Date(d);
  day.setHours(0,0,0,0);
  const dow = day.getDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  day.setDate(day.getDate() + diff);
  return day;
}

async function loadYearView() {
  const today       = new Date();
  today.setHours(0,0,0,0);
  const currentYear = today.getFullYear();
  const isThisYear  = _yearDisplayed === currentYear;

  // Range: Jan 1 of displayed year → Dec 31 (or today if current year)
  const rangeStart = new Date(_yearDisplayed, 0, 1);   // Jan 1
  const rangeEnd   = isThisYear
    ? new Date(today)
    : new Date(_yearDisplayed, 11, 31);                // Dec 31

  // Expand to full weeks (Mon→Sun) so the table aligns
  const tableStart = getMondayOf(rangeStart);
  const tableEnd   = getMondayOf(rangeEnd);
  // tableEnd is the Monday of rangeEnd's week; add 6 to get Sunday
  const tableEndSun = new Date(tableEnd);
  tableEndSun.setDate(tableEnd.getDate() + 6);

  // Build list of week-start Mondays
  const weekStarts = [];
  for (let d = new Date(tableStart); d <= tableEnd; d.setDate(d.getDate() + 7)) {
    weekStarts.push(new Date(d));
  }

  // Update title and nav buttons
  const title = $('cal-year-title');
  if (title) title.textContent = String(_yearDisplayed);

  const nextBtn = $('year-next-btn');
  if (nextBtn) {
    nextBtn.disabled = isThisYear;
    nextBtn.style.opacity = isThisYear ? '0.35' : '1';
  }

  // Fetch lightweight summary
  let url = `/api/entries/summary?date_from=${isoDate(rangeStart)}&date_to=${isoDate(rangeEnd)}`;
  const fp = buildFilterParams();
  if (fp) url += '&' + fp;

  const entries = await api(url);
  const byDate  = {};
  entries.forEach(e => {
    if (!byDate[e.date]) byDate[e.date] = [];
    byDate[e.date].push(e);
  });

  renderYearTable(weekStarts, byDate, today, rangeStart, rangeEnd);
}

// Build a tooltip string for a day's entries (uses cached maps)
function buildTooltip(dayEntries) {
  return dayEntries.map(e => {
    const item = _itemsById[e.item_id];
    if (!item) return '?';
    let line = item.name;
    if (item.value_type === 'numeric' && e.value != null) {
      line += `: ${e.value}${e.unit ? ' ' + e.unit : ''}`;
    } else if (item.value_type === 'discrete' && e.option_id) {
      const opt = _optsByItemId[e.item_id]?.[e.option_id];
      if (opt) line += `: ${opt.label}`;
    }
    if (e.has_notes) line += ' 📝';
    return line;
  }).join('\n');
}

function renderYearTable(weekStarts, byDate, today, rangeStart, rangeEnd) {
  const container = $('year-grid');
  if (!container) return;
  container.innerHTML = '';

  const todayISO_ = todayISO();
  const WEEKS     = weekStarts.length;

  // Build the full table structure
  const wrap = document.createElement('div');
  wrap.className = 'year-table-wrap';

  const table = document.createElement('table');
  table.className = 'year-table';

  // ── Row 0: month/year labels above columns ────────────────────────────
  const thead = document.createElement('thead');

  const labelRow = document.createElement('tr');
  // corner cell (empty, for the DOW label column)
  const corner = document.createElement('th');
  corner.className = 'year-th-corner';
  labelRow.appendChild(corner);

  let prevMonth = -1;
  let prevYear  = -1;

  weekStarts.forEach((mon, wi) => {
    const th = document.createElement('th');
    th.className = 'year-col-label';

    // Check if any day in this week starts a new month or year
    let monthLabel = '';
    let yearLabel  = '';
    for (let d = 0; d < 7; d++) {
      const day = new Date(mon);
      day.setDate(mon.getDate() + d);
      if (day.getMonth() !== prevMonth || day.getFullYear() !== prevYear) {
        if (day.getDate() <= 7) {  // first week of that month
          if (day.getFullYear() !== prevYear && prevYear !== -1) {
            yearLabel  = String(day.getFullYear());
          }
          monthLabel = MONTH_SHORT[day.getMonth()];
          prevMonth  = day.getMonth();
          prevYear   = day.getFullYear();
        }
        break;
      }
    }

    if (yearLabel) {
      const yr = document.createElement('div');
      yr.className = 'year-col-year';
      yr.textContent = yearLabel;
      th.appendChild(yr);
    }
    if (monthLabel) {
      const mo = document.createElement('div');
      mo.className = 'year-col-month';
      mo.textContent = monthLabel;
      th.appendChild(mo);
    }
    labelRow.appendChild(th);
  });
  thead.appendChild(labelRow);
  table.appendChild(thead);

  // ── Rows 1–7: Mon … Sun ──────────────────────────────────────────────
  const tbody = document.createElement('tbody');

  for (let dow = 0; dow < 7; dow++) {   // 0=Mon … 6=Sun
    const tr = document.createElement('tr');

    // DOW label cell (right side will be added after via CSS order trick; put it first)
    const dowTh = document.createElement('th');
    dowTh.className = 'year-dow-label';
    dowTh.textContent = DOW_LABELS[dow];
    tr.appendChild(dowTh);

    weekStarts.forEach((mon, wi) => {
      const day = new Date(mon);
      day.setDate(mon.getDate() + dow);

      const iso        = isoDate(day);
      const isToday    = iso === todayISO_;
      const isFuture   = day > today;
      const outOfRange = day < rangeStart || day > rangeEnd;
      const dayEntries = byDate[iso] || [];

      const td = document.createElement('td');
      td.className = 'year-cell' +
        (isToday    ? ' year-cell-today'   : '') +
        (isFuture   ? ' year-cell-future'  : '') +
        (outOfRange ? ' year-cell-outside' : '') +
        (dayEntries.length ? ' year-cell-has' : '');

      // Day number
      const num = document.createElement('div');
      num.className = 'year-cell-num';
      num.textContent = day.getDate();
      td.appendChild(num);

      // Colored dots — use O(1) maps instead of .find()
      if (dayEntries.length) {
        const dots = document.createElement('div');
        dots.className = 'year-cell-dots';
        dayEntries.slice(0, 4).forEach(e => {
          const item = _itemsById[e.item_id];
          let color  = item?.category?.color || '#888';
          if (item?.value_type === 'discrete' && e.option_id) {
            const opt    = _optsByItemId[e.item_id]?.[e.option_id];
            const optIdx = (item.options||[]).findIndex(o => o.id === e.option_id);
            if (opt) color = resolveOptionColor(item, opt, optIdx);
          }
          const dot = document.createElement('span');
          dot.className = 'year-dot';
          dot.style.background = color;
          dots.appendChild(dot);
        });
        td.appendChild(dots);

        // Tooltip
        td.dataset.tooltip = buildTooltip(dayEntries);
        td.classList.add('has-tooltip');

        td.onclick = async () => {
          const full = await api(`/api/entries?date=${iso}`);
          openDayDetail(iso, full);
        };
      }

      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);

  // Scroll to the rightmost position (latest week)
  requestAnimationFrame(() => { wrap.scrollLeft = wrap.scrollWidth; });

  // Wire tooltip events
  initYearTooltip(wrap);
}

// ── Year view tooltip ─────────────────────────────────────────────────────────
let _ttEl = null;

function initYearTooltip(container) {
  if (!_ttEl) {
    _ttEl = document.createElement('div');
    _ttEl.className = 'year-tooltip';
    document.body.appendChild(_ttEl);
  }

  container.addEventListener('mouseover', e => {
    const cell = e.target.closest('.has-tooltip');
    if (!cell) { _ttEl.classList.remove('visible'); return; }
    _ttEl.textContent = cell.dataset.tooltip || '';
    _ttEl.classList.add('visible');
  });

  container.addEventListener('mousemove', e => {
    if (!_ttEl.classList.contains('visible')) return;
    const gap = 14;
    let x = e.clientX + gap;
    let y = e.clientY + gap;
    // Keep tooltip inside viewport
    const tw = _ttEl.offsetWidth;
    const th = _ttEl.offsetHeight;
    if (x + tw > window.innerWidth  - 8) x = e.clientX - tw - gap;
    if (y + th > window.innerHeight - 8) y = e.clientY - th - gap;
    _ttEl.style.left = x + 'px';
    _ttEl.style.top  = y + 'px';
  });

  container.addEventListener('mouseout', e => {
    if (!e.target.closest('.has-tooltip')) _ttEl.classList.remove('visible');
  });
}

// ── Multi-select filter state ─────────────────────────────────────────────────
let _selCatIds  = new Set();   // selected category ids
let _selItemIds = new Set();   // selected item ids
let _mselOpen   = null;        // 'cat' | 'item' | null

function populateCalFilters() {
  if (!$('msel-cat-opts')) return;
  renderMselOptions('cat');
  renderMselOptions('item');

  // Close dropdowns when clicking outside
  document.addEventListener('click', e => {
    if (_mselOpen && !e.target.closest('.msel-wrap')) {
      closeMsel(_mselOpen);
    }
  }, { capture: true });
}

function toggleMsel(which) {
  if (_mselOpen === which) { closeMsel(which); return; }
  if (_mselOpen) closeMsel(_mselOpen);
  _mselOpen = which;
  $(`msel-${which}-drop`).classList.remove('hidden');
  $(`msel-${which}-btn`).classList.add('msel-open');
}

function closeMsel(which) {
  $(`msel-${which}-drop`)?.classList.add('hidden');
  $(`msel-${which}-btn`)?.classList.remove('msel-open');
  if (_mselOpen === which) _mselOpen = null;
}

function renderMselOptions(which, filter = '') {
  const container = $(`msel-${which}-opts`);
  if (!container) return;
  container.innerHTML = '';

  const items = which === 'cat' ? _categories : _items;
  const selSet = which === 'cat' ? _selCatIds : _selItemIds;

  const filtered = filter
    ? items.filter(x => x.name.toLowerCase().includes(filter.toLowerCase()))
    : items;

  filtered.forEach(item => {
    const color = which === 'cat'
      ? item.color
      : (item.category?.color || '#888');

    const row = document.createElement('label');
    row.className = 'msel-option';

    const cb = document.createElement('input');
    cb.type    = 'checkbox';
    cb.value   = item.id;
    cb.checked = selSet.has(item.id);
    cb.addEventListener('change', () => {
      if (cb.checked) selSet.add(item.id);
      else            selSet.delete(item.id);
      updateMselLabel(which);
      // When category filter changes, refresh item list to show only relevant items
      if (which === 'cat') {
        renderMselOptions('item', '');
        // Clear item selections that belong to deselected categories
        if (_selCatIds.size > 0) {
          _selItemIds.forEach(id => {
            const it = _itemsById[id];
            if (it && !_selCatIds.has(it.category_id)) _selItemIds.delete(id);
          });
          updateMselLabel('item');
        }
      }
      calApplyFilters();
    });

    const dot = document.createElement('span');
    dot.className = 'msel-dot';
    dot.style.background = color;

    const name = document.createElement('span');
    name.className   = 'msel-option-name';
    name.textContent = item.name;

    if (which === 'item' && item.category) {
      const cat = document.createElement('span');
      cat.className   = 'msel-option-cat';
      cat.textContent = item.category.name;
      row.append(cb, dot, name, cat);
    } else {
      row.append(cb, dot, name);
    }

    container.appendChild(row);
  });
}

function filterMselOptions(which, q) {
  renderMselOptions(which, q);
}

function updateMselLabel(which) {
  const selSet = which === 'cat' ? _selCatIds : _selItemIds;
  const label  = $(`msel-${which}-label`);
  const btn    = $(`msel-${which}-btn`);
  if (!label) return;
  if (selSet.size === 0) {
    label.textContent = which === 'cat' ? 'Todas las categorías' : 'Todos los ítems';
    btn.classList.remove('msel-active');
  } else if (selSet.size === 1) {
    const id   = [...selSet][0];
    const arr  = which === 'cat' ? _categories : _items;
    const item = arr.find(x => x.id === id);
    label.textContent = item?.name || `1 seleccionado`;
    btn.classList.add('msel-active');
  } else {
    label.textContent = `${selSet.size} seleccionados`;
    btn.classList.add('msel-active');
  }
}

function clearMsel(which) {
  const selSet = which === 'cat' ? _selCatIds : _selItemIds;
  selSet.clear();
  updateMselLabel(which);
  renderMselOptions(which, '');
  calApplyFilters();
}

function buildFilterParams() {
  const params = [];
  if (_selCatIds.size)  params.push(`category_ids=${[..._selCatIds].join(',')}`);
  if (_selItemIds.size) params.push(`item_ids=${[..._selItemIds].join(',')}`);
  return params.join('&');
}

async function calLoad() {
  let url = `/api/calendar?year=${_calYear}&month=${_calMonth}`;
  const fp = buildFilterParams();
  if (fp) url += '&' + fp;
  _calData = await api(url);
  renderCalendar();
}

function calNav(dir) {
  _calMonth += dir;
  if (_calMonth > 12) { _calMonth = 1;  _calYear++; }
  if (_calMonth < 1)  { _calMonth = 12; _calYear--; }
  calLoad();
}

function calGoToday() {
  const t = new Date();
  _calYear = t.getFullYear(); _calMonth = t.getMonth() + 1;
  calLoad();
}

function calApplyFilters() {
  if (_calView === 'year') loadYearView();
  else calLoad();
}

function calClearFilters() {
  _selCatIds.clear();
  _selItemIds.clear();
  updateMselLabel('cat');
  updateMselLabel('item');
  renderMselOptions('cat', '');
  renderMselOptions('item', '');
  calApplyFilters();
}

function renderCalendar() {
  const title = $('cal-month-title');
  if (title) title.textContent = `${MONTH_NAMES[_calMonth-1]} ${_calYear}`;

  const grid = $('cal-grid');
  if (!grid) return;
  grid.innerHTML = '';

  const today = todayISO();
  const firstDay = new Date(_calYear, _calMonth - 1, 1);
  const lastDay  = new Date(_calYear, _calMonth, 0);

  // Padding at start (Monday = 0)
  let startDow = firstDay.getDay(); // 0=Sun…6=Sat
  startDow = startDow === 0 ? 6 : startDow - 1; // Convert to Mon-based

  // Previous month padding
  for (let i = 0; i < startDow; i++) {
    const pad = document.createElement('div');
    pad.className = 'cal-day other-month';
    const d = new Date(firstDay);
    d.setDate(d.getDate() - (startDow - i));
    pad.innerHTML = `<div class="cal-day-num">${d.getDate()}</div>`;
    grid.appendChild(pad);
  }

  // Current month days
  for (let day = 1; day <= lastDay.getDate(); day++) {
    const iso = `${_calYear}-${String(_calMonth).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    const isToday    = iso === today;
    const isSelected = iso === _selectedCalDate;

    const cell = document.createElement('div');
    cell.className = `cal-day${isToday ? ' today' : ''}${isSelected ? ' selected' : ''}`;
    cell.dataset.date = iso;
    makeCalDayDropTarget(cell, iso);

    let html = `<div class="cal-day-num">${day}</div>`;

    const dayEntries = _calData[iso] || [];
    const shown = dayEntries.slice(0, 4);
    shown.forEach(e => {
      const item     = _itemsById[e.item_id];
      const catColor = item?.category?.color || '#888';
      let chipColor  = catColor;
      let chipLabel  = item?.name || '?';

      if (item?.value_type === 'discrete' && e.option) {
        const optIdx = (item.options||[]).findIndex(o => o.id === e.option_id);
        chipColor = resolveOptionColor(item, e.option, optIdx);
        chipLabel = e.option.label;
      } else if (item?.value_type === 'numeric' && e.value != null) {
        chipLabel = `${item.name} ${e.value}${e.unit||''}`;
      } else if (item?.value_type === 'none' && e.notes) {
        chipLabel = `${item.name}: ${e.notes}`;
      }

      const fg = contrastColor(chipColor);
      html += `<span class="cal-chip" style="background:${chipColor};color:${fg}" data-entry-id="${e.id}" data-src-date="${iso}">${chipLabel}</span>`;
    });

    if (dayEntries.length > 4) {
      html += `<span class="cal-chip-more">+${dayEntries.length - 4} más</span>`;
    }

    cell.innerHTML = html;

    // Make chips draggable after setting innerHTML
    cell.querySelectorAll('.cal-chip[data-entry-id]').forEach(chip => {
      const entryId = parseInt(chip.dataset.entryId);
      const srcDate = chip.dataset.srcDate;
      makeChipDraggable(chip, entryId, srcDate);
    });

    cell.onclick = (e) => {
      if (e.target.closest('.cal-chip')) return; // chip click handled separately
      openDayDetail(iso, dayEntries);
    };
    cell.querySelectorAll('.cal-chip[data-entry-id]').forEach(chip => {
      chip.addEventListener('click', e => {
        e.stopPropagation();
        const entryId = parseInt(chip.dataset.entryId);
        const entry   = dayEntries.find(en => en.id === entryId);
        if (entry) openEntryModal(entry.item_id, iso, entry.id, false);
      });
    });
    grid.appendChild(cell);
  }

  // Trailing padding
  const totalCells = startDow + lastDay.getDate();
  const remainder  = totalCells % 7;
  if (remainder !== 0) {
    const fill = 7 - remainder;
    for (let i = 1; i <= fill; i++) {
      const pad = document.createElement('div');
      pad.className = 'cal-day other-month';
      pad.innerHTML = `<div class="cal-day-num">${i}</div>`;
      grid.appendChild(pad);
    }
  }
}

function openDayDetail(iso, entries) {
  _selectedCalDate = iso;
  // Refresh calendar to mark selected
  renderCalendar();

  const panel = $('detail-panel');
  panel.classList.add('open');

  const d = new Date(iso + 'T00:00:00');
  $('detail-date-title').textContent = d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long' });
  $('detail-date-sub').textContent   = d.toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric' });

  const body = $('detail-panel-body');
  body.innerHTML = '';

  if (!entries || entries.length === 0) {
    body.innerHTML = '<div class="empty-day">Sin entradas este día</div>';
  } else {
    entries.forEach(e => {
      const item     = _itemsById[e.item_id];
      const catColor = item?.category?.color || '#888';
      const card = document.createElement('div');
      card.className = 'detail-entry';
      card.onclick   = () => openEntryModal(e.item_id, iso, e.id, false);

      let valueHtml = '';
      if (item?.value_type === 'numeric' && e.value != null) {
        valueHtml = `<div class="detail-entry-value">${e.value}<span class="detail-entry-unit">${e.unit||''}</span></div>`;
      } else if (item?.value_type === 'discrete' && e.option) {
        const optIdx = (item.options||[]).findIndex(o => o.id === e.option_id);
        const color  = resolveOptionColor(item, e.option, optIdx);
        valueHtml = `<span class="cell-discrete" style="background:${color};color:${contrastColor(color)};padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700">${e.option.label}</span>`;
      }

      card.innerHTML = `
        <div class="detail-entry-header">
          <span class="detail-cat-dot" style="background:${catColor}"></span>
          <span class="detail-item-name">${item?.name || '?'}</span>
          <span style="font-size:11px;color:var(--text-muted)">${item?.category?.name||''}</span>
        </div>
        ${valueHtml}
        ${e.notes ? `<div class="detail-entry-notes">${e.notes}</div>` : ''}
      `;
      body.appendChild(card);
    });
  }

  // Store date for "add entry" button
  panel.dataset.date = iso;
}

function closeDetailPanel() {
  $('detail-panel').classList.remove('open');
  _selectedCalDate = null;
  renderCalendar();
}

async function addEntryForSelectedDay() {
  const date = $('detail-panel').dataset.date;
  if (!date) return;

  await loadCategories();
  await loadItems();

  // Reset modal state
  _modalEntryId  = null;
  _modalItemId   = null;
  _modalItem     = null;
  _selectedOptId = null;

  $('modal-entry-id').value = '';
  $('modal-item-id').value  = '';
  $('modal-date').value     = date;
  $('modal-notes').value    = '';
  $('modal-value').value    = '';
  $('modal-item-name-text').textContent = 'Nueva entrada';
  $('modal-item-dot').style.background  = 'var(--text-muted)';
  $('modal-date-label').textContent     = formatDate(date);

  show('modal-date-field');
  show('modal-item-selector-field');
  hide('modal-value-field');
  hide('modal-discrete-field');
  hide('modal-delete-btn');

  // Start with category step
  renderCategorySelector();
  $('entry-modal').classList.remove('hidden');
}

function renderCategorySelector() {
  const list = $('modal-item-selector-list');
  const label = $('modal-selector-step-label');
  if (label) label.textContent = 'Elige una categoría:';
  list.innerHTML = '';

  // Only show categories that have items
  const catsWithItems = _categories.filter(c => _items.some(i => i.category_id === c.id));

  catsWithItems.forEach(cat => {
    const row = document.createElement('div');
    row.className = 'item-selector-item';
    row.innerHTML = `
      <span class="item-selector-cat" style="background:${cat.color}"></span>
      <span class="item-selector-name">${cat.icon ? cat.icon + ' ' : ''}${cat.name}</span>
      <span style="font-size:11px;color:var(--text-muted)">→</span>
    `;
    row.onclick = () => renderItemSelectorForCategory(cat);
    list.appendChild(row);
  });
}

function renderItemSelectorForCategory(cat) {
  const list  = $('modal-item-selector-list');
  const label = $('modal-selector-step-label');
  if (label) label.textContent = `${cat.icon ? cat.icon + ' ' : ''}${cat.name} — elige un ítem:`;
  list.innerHTML = '';

  // Back button
  const back = document.createElement('div');
  back.className = 'item-selector-item';
  back.style.color = 'var(--accent)';
  back.style.fontWeight = '700';
  back.innerHTML = `<span style="font-size:13px">← Volver a categorías</span>`;
  back.onclick = () => renderCategorySelector();
  list.appendChild(back);

  const items = _items.filter(i => i.category_id === cat.id);
  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'item-selector-item';
    row.innerHTML = `
      <span class="item-selector-cat" style="background:${cat.color}"></span>
      <span class="item-selector-name">${item.name}</span>
      <span class="item-selector-cat-name">${item.default_unit || ''}</span>
    `;
    row.onclick = () => {
      _modalItemId = item.id;
      _modalItem   = item;
      $('modal-item-id').value = item.id;
      $('modal-item-name-text').textContent = item.name;
      $('modal-item-dot').style.background  = cat.color;
      hide('modal-item-selector-field');
      setupModalFields(item, false);
    };
    list.appendChild(row);
  });
}

// ── SETTINGS VIEW ─────────────────────────────────────────────────────────────

async function initSettingsView() {
  await loadCategories();
  await loadItems();
  renderCatList();
  renderItemList();
  populateItemCatSelects();
}

function renderCatList() {
  const list = $('cat-list');
  if (!list) return;
  list.innerHTML = '';
  _categories.forEach(cat => {
    const row = document.createElement('div');
    row.className = 'settings-list-item';
    row.innerHTML = `
      <span class="settings-cat-color" style="background:${cat.color}"></span>
      <div class="settings-item-name">${cat.icon ? cat.icon + ' ' : ''}${cat.name}</div>
      <button class="btn btn-ghost btn-sm" onclick="editCategory(${cat.id})">Editar</button>
      <button class="btn btn-danger btn-sm" onclick="deleteCategory(${cat.id})">✕</button>
    `;
    list.appendChild(row);
  });
  if (_categories.length === 0) {
    list.innerHTML = '<div class="text-muted text-sm" style="padding:8px 0">Sin categorías aún.</div>';
  }
}

function renderItemList() {
  const catFilter = $('item-cat-filter')?.value;
  const list = $('item-list');
  if (!list) return;
  list.innerHTML = '';

  const items = catFilter
    ? _items.filter(i => String(i.category_id) === catFilter)
    : _items;

  items.forEach(item => {
    const row = document.createElement('div');
    row.className = 'settings-list-item';
    const typeLabel = { none: '—', numeric: '# Numérico', discrete: '⊙ Opciones' }[item.value_type] || '';
    row.innerHTML = `
      <span class="settings-cat-color" style="background:${item.category?.color||'#888'}"></span>
      <div>
        <div class="settings-item-name">${item.name}</div>
        <div class="settings-item-sub">${item.category?.name||''} · ${typeLabel}${item.default_unit ? ' · ' + item.default_unit : ''}</div>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="openItemEditModal(${item.id})">Editar</button>
    `;
    list.appendChild(row);
  });

  if (items.length === 0) {
    list.innerHTML = '<div class="text-muted text-sm" style="padding:8px 0">Sin ítems.</div>';
  }
}

function populateItemCatSelects() {
  ['new-item-cat', 'item-cat-filter', 'edit-item-cat'].forEach(id => {
    const sel = $(id);
    if (!sel) return;
    const isFilter = id === 'item-cat-filter';
    sel.innerHTML = isFilter ? '<option value="">Todas</option>' : '';
    _categories.forEach(c => {
      const o = document.createElement('option');
      o.value = c.id; o.textContent = c.name;
      sel.appendChild(o);
    });
  });
}

function selectType(chip) {
  chip.closest('.type-chips').querySelectorAll('.type-chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  const type = chip.dataset.type;
  const unitField = $('new-item-unit-field');
  const reqField  = $('new-item-req-field');
  if (unitField) unitField.classList.toggle('hidden', type !== 'numeric');
  if (reqField)  reqField.classList.toggle('hidden',  type === 'none');
}

async function addCategory() {
  const name  = $('new-cat-name').value.trim();
  const color = $('new-cat-color').value;
  const icon  = $('new-cat-icon').value.trim();
  if (!name) { toast('El nombre es obligatorio', 'error'); return; }
  try {
    await api('/api/categories', { method: 'POST', body: JSON.stringify({ name, color, icon }) });
    $('new-cat-name').value = '';
    $('new-cat-icon').value = '';
    toast('Categoría creada');
    invalidateCache();
    await ensureCache();
    renderCatList();
    populateItemCatSelects();
  } catch (e) { toast(e.message, 'error'); }
}

async function editCategory(id) {
  const cat = _categories.find(c => c.id === id);
  if (!cat) return;
  const name = prompt('Nombre de la categoría:', cat.name);
  if (name === null) return;
  try {
    await api(`/api/categories/${id}`, { method: 'PUT', body: JSON.stringify({ name: name.trim(), color: cat.color, icon: cat.icon }) });
    toast('Categoría actualizada');
    invalidateCache();
    await ensureCache();
    renderCatList(); renderItemList(); populateItemCatSelects();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteCategory(id) {
  if (!confirm('¿Eliminar esta categoría?')) return;
  try {
    await api(`/api/categories/${id}`, { method: 'DELETE' });
    toast('Categoría eliminada');
    invalidateCache();
    await ensureCache();
    renderCatList(); renderItemList();
  } catch (e) { toast(e.message, 'error'); }
}

async function addItem() {
  const name    = $('new-item-name').value.trim();
  const catId   = parseInt($('new-item-cat').value);
  const type    = document.querySelector('#new-item-type-chips .type-chip.active')?.dataset.type || 'none';
  const unit    = $('new-item-unit')?.value.trim() || '';
  const req     = $('new-item-req')?.checked || false;
  if (!name)  { toast('El nombre es obligatorio', 'error'); return; }
  if (!catId) { toast('Selecciona una categoría', 'error'); return; }
  try {
    await api('/api/items', { method: 'POST', body: JSON.stringify({
      name, category_id: catId, value_type: type, default_unit: unit, value_required: req,
    })});
    $('new-item-name').value = '';
    toast('Ítem creado');
    invalidateCache();
    await ensureCache();
    renderItemList();
  } catch (e) { toast(e.message, 'error'); }
}

// ── Item edit modal ───────────────────────────────────────────────────────────

let _editItemOptions = [];
let _editColorMode   = 'category';

async function openItemEditModal(itemId) {
  const item = _items.find(i => i.id === itemId);
  if (!item) return;

  $('edit-item-id').value   = item.id;
  $('edit-item-name').value = item.name;
  $('edit-item-unit').value = item.default_unit || '';
  $('edit-item-req').checked = item.value_required;

  // Category select
  const catSel = $('edit-item-cat');
  catSel.innerHTML = '';
  _categories.forEach(c => {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = c.name;
    if (c.id === item.category_id) o.selected = true;
    catSel.appendChild(o);
  });

  // Type chips
  document.querySelectorAll('#edit-item-type-chips .type-chip').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.type === item.value_type);
  });
  updateEditTypeFields(item.value_type);

  // Options section
  const optSection = $('edit-item-options-section');
  if (item.value_type === 'discrete') {
    optSection.classList.remove('hidden');
  } else {
    optSection.classList.add('hidden');
  }

  // Color mode
  _editColorMode = item.color_mode || 'category';
  document.querySelectorAll('.color-mode-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.mode === _editColorMode);
  });
  updateColorModeUI();

  // Gradient stops
  const gc = item.gradient_colors || [];
  const stops = document.querySelectorAll('.grad-stop');
  if (gc[0] && stops[0]) stops[0].value = gc[0];
  if (gc[1] && stops[1]) stops[1].value = gc[1];
  const thirdStop = gc[2];
  // TODO: toggle third stop visibility
  updateGradientPreview();

  // Load options
  _editItemOptions = [...(item.options || [])];
  renderOptionsManager();

  $('item-edit-modal-title').textContent = item.name;
  $('item-edit-modal').classList.remove('hidden');
}

function updateEditTypeFields(type) {
  const unitField = $('edit-item-unit-field');
  const reqField  = $('edit-item-req-field');
  const optSection = $('edit-item-options-section');
  if (unitField) unitField.style.display = type === 'numeric' ? '' : 'none';
  if (reqField)  reqField.style.display  = type !== 'none'    ? '' : 'none';
  if (optSection) optSection.classList.toggle('hidden', type !== 'discrete');
}

function editSelectType(chip) {
  chip.closest('.type-chips').querySelectorAll('.type-chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  updateEditTypeFields(chip.dataset.type);
}

function selectColorMode(tab) {
  document.querySelectorAll('.color-mode-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  _editColorMode = tab.dataset.mode;
  updateColorModeUI();
}

function updateColorModeUI() {
  const gradConfig = $('gradient-config');
  if (gradConfig) gradConfig.classList.toggle('hidden', _editColorMode !== 'gradient');
  // In preset mode, show individual color pickers per option
  renderOptionsManager();
}

function renderOptionsManager() {
  const mgr = $('options-manager');
  if (!mgr) return;
  mgr.innerHTML = '';
  _editItemOptions.forEach((opt, idx) => {
    const row = document.createElement('div');
    row.className = 'option-row';

    let colorPicker = '';
    if (_editColorMode === 'preset') {
      colorPicker = `<input type="color" value="${opt.color||'#7c6ef7'}" onchange="updateOptionColor(${idx},this.value)" style="width:28px;height:28px" />`;
    }

    row.innerHTML = `
      ${colorPicker}
      <input type="text" value="${opt.label}" placeholder="Etiqueta…"
             oninput="updateOptionLabel(${idx},this.value)" />
      <button class="btn-icon" onclick="removeOption(${idx})" title="Eliminar">✕</button>
    `;
    mgr.appendChild(row);
  });
}

function addOptionRow() {
  _editItemOptions.push({ id: null, label: '', color: '#7c6ef7', sort_order: _editItemOptions.length });
  renderOptionsManager();
}

function removeOption(idx) {
  _editItemOptions.splice(idx, 1);
  renderOptionsManager();
}

function updateOptionLabel(idx, val) { _editItemOptions[idx].label = val; }
function updateOptionColor(idx, val) { _editItemOptions[idx].color = val; }

function updateGradientPreview() {
  const stops = [...document.querySelectorAll('.grad-stop')].map(s => s.value);
  const preview = $('gradient-preview');
  if (preview && stops.length >= 2) {
    preview.style.background = `linear-gradient(to right, ${stops.join(',')})`;
  }
}

function toggleThirdStop() {
  const stops = [...document.querySelectorAll('.grad-stop')];
  const container = $('gradient-stops');
  if (stops.length === 2) {
    const inp = document.createElement('input');
    inp.type = 'color'; inp.className = 'grad-stop'; inp.value = '#3b82f6';
    inp.oninput = updateGradientPreview;
    container.insertBefore(inp, container.lastElementChild);
  } else if (stops.length === 3) {
    stops[2].remove();
  }
  updateGradientPreview();
}

async function saveItemEdit() {
  const id   = parseInt($('edit-item-id').value);
  const item = _items.find(i => i.id === id);
  const type = document.querySelector('#edit-item-type-chips .type-chip.active')?.dataset.type || 'none';
  const gradStops = [...document.querySelectorAll('.grad-stop')].map(s => s.value);

  const payload = {
    name:           $('edit-item-name').value.trim(),
    category_id:    parseInt($('edit-item-cat').value),
    value_type:     type,
    default_unit:   $('edit-item-unit')?.value.trim() || '',
    value_required: $('edit-item-req')?.checked || false,
    color_mode:     _editColorMode,
    gradient_colors: gradStops,
  };

  try {
    await api(`/api/items/${id}`, { method: 'PUT', body: JSON.stringify(payload) });

    // Sync options if discrete
    if (type === 'discrete') {
      // Fetch current options from server
      const existingOpts = await api(`/api/items/${id}/options`);
      const existingIds  = existingOpts.map(o => o.id);

      for (const [idx, opt] of _editItemOptions.entries()) {
        if (opt.id && existingIds.includes(opt.id)) {
          // Update
          await api(`/api/options/${opt.id}`, {
            method: 'PUT',
            body: JSON.stringify({ label: opt.label, color: opt.color, sort_order: idx }),
          });
        } else {
          // Create new
          if (opt.label.trim()) {
            await api(`/api/items/${id}/options`, {
              method: 'POST',
              body: JSON.stringify({ label: opt.label.trim(), color: opt.color, sort_order: idx }),
            });
          }
        }
      }

      // Delete removed options
      const keepIds = _editItemOptions.map(o => o.id).filter(Boolean);
      for (const oid of existingIds) {
        if (!keepIds.includes(oid)) {
          await api(`/api/options/${oid}`, { method: 'DELETE' });
        }
      }
    }

    toast('Ítem guardado');
    closeItemEditModal();
    invalidateCache();
    await ensureCache();
    renderItemList();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteItem() {
  const id = parseInt($('edit-item-id').value);
  try {
    await api(`/api/items/${id}`, { method: 'DELETE' });
    toast('Ítem eliminado');
    closeItemEditModal();
    invalidateCache();
    await ensureCache();
    renderItemList();
  } catch (e) {
    if (e.message.includes('entrada')) {
      if (confirm(`${e.message}\n¿Eliminar igualmente junto con todas sus entradas?`)) {
        await api(`/api/items/${id}?force=true`, { method: 'DELETE' });
        toast('Ítem y entradas eliminados');
        closeItemEditModal();
        invalidateCache();
        await ensureCache();
        renderItemList();
      }
    } else {
      toast(e.message, 'error');
    }
  }
}

function closeItemEditModal() {
  $('item-edit-modal').classList.add('hidden');
}

// ── IMPORT VIEW ───────────────────────────────────────────────────────────────

let _importCsvItems    = [];   // items found in CSV with stats
let _importExisting    = [];   // existing Life Tracker items
let _importCats        = [];   // existing categories
let _importMapping     = {};   // { csv_item_name → item_id | 'new' }
let _createItemForName = null; // which CSV item name triggered "create new"

async function initImportView() {
  // nothing async needed on load — triggered by file upload
}

async function previewCSV() {
  const fileInput = $('csv-file');
  const errEl     = $('upload-error');
  errEl.classList.add('hidden');
  errEl.textContent = '';

  if (!fileInput.files.length) {
    errEl.textContent = 'Selecciona un fichero primero.';
    errEl.classList.remove('hidden');
    return;
  }

  try {
    const data = await dbImportPreview(fileInput.files[0]);

    _importCsvItems = data.csv_items;
    _importExisting = data.existing_items;
    _importCats     = data.existing_cats;
    _importMapping  = {};

    _importCsvItems.forEach(ci => {
      const match = _importExisting.find(ei => ei.name.toLowerCase() === ci.name.toLowerCase());
      if (match) _importMapping[ci.name] = match.id;
    });

    renderMappingTable();

    const warnEl = $('bad-dates-warn');
    if (data.bad_dates && data.bad_dates.length) {
      warnEl.textContent = `⚠ Se encontraron ${data.bad_dates.length} fecha(s) con formato inválido que serán ignoradas: ${data.bad_dates.join(', ')}`;
      warnEl.classList.remove('hidden');
    } else {
      warnEl.classList.add('hidden');
    }

    $('step-upload').classList.add('hidden');
    $('step-mapping').classList.remove('hidden');
    $('step-result').classList.add('hidden');

  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  }
}

function renderMappingTable() {
  const container = $('mapping-table');
  container.innerHTML = '';

  const table = document.createElement('table');
  table.style.cssText = 'width:100%;border-collapse:collapse';

  // Header
  const thead = document.createElement('thead');
  thead.innerHTML = `
    <tr style="border-bottom:2px solid var(--border)">
      <th style="text-align:left;padding:8px 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted)">Ítem en CSV</th>
      <th style="text-align:center;padding:8px 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted)">Filas válidas</th>
      <th style="text-align:center;padding:8px 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted)">Ignoradas (NO)</th>
      <th style="text-align:left;padding:8px 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-muted)">→ Ítem en Life Tracker</th>
    </tr>`;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  _importCsvItems.forEach(ci => {
    const tr  = document.createElement('tr');
    tr.style.borderBottom = '1px solid var(--border-dim)';

    // CSV item name
    const tdName = document.createElement('td');
    tdName.style.cssText = 'padding:10px;font-size:13px;font-weight:600';
    tdName.textContent = ci.name;

    // Valid count
    const tdValid = document.createElement('td');
    tdValid.style.cssText = 'padding:10px;text-align:center;font-size:13px;font-family:var(--mono,monospace);color:var(--success)';
    tdValid.textContent = ci.valid;

    // Skipped NO count
    const tdSkipped = document.createElement('td');
    tdSkipped.style.cssText = 'padding:10px;text-align:center;font-size:13px;font-family:var(--mono,monospace);color:var(--text-muted)';
    tdSkipped.textContent = ci.skipped_no || 0;

    // Mapping dropdown
    const tdMap = document.createElement('td');
    tdMap.style.padding = '10px';

    const sel = document.createElement('select');
    sel.style.cssText = 'width:100%;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);padding:6px 10px;font-size:13px';

    const optSkip = document.createElement('option');
    optSkip.value = ''; optSkip.textContent = '— No importar este ítem —';
    sel.appendChild(optSkip);

    const optNew = document.createElement('option');
    optNew.value = 'new'; optNew.textContent = '＋ Crear ítem nuevo…';
    sel.appendChild(optNew);

    // Separator
    const optGroup = document.createElement('optgroup');
    optGroup.label = 'Ítems existentes';
    _importExisting.forEach(ei => {
      const o = document.createElement('option');
      o.value = ei.id;
      o.textContent = `${ei.category?.name || '?'} › ${ei.name}`;
      if (_importMapping[ci.name] === ei.id) o.selected = true;
      optGroup.appendChild(o);
    });
    sel.appendChild(optGroup);

    // Pre-select if auto-matched
    if (_importMapping[ci.name] && _importMapping[ci.name] !== 'new') {
      sel.value = _importMapping[ci.name];
    }

    sel.addEventListener('change', () => {
      if (sel.value === 'new') {
        openCreateItemModal(ci.name, sel);
      } else {
        _importMapping[ci.name] = sel.value ? parseInt(sel.value) : null;
        updateMappingCount();
      }
    });

    // Store reference to select for updating after item creation
    sel.dataset.csvItem = ci.name;

    tdMap.appendChild(sel);
    tr.appendChild(tdName);
    tr.appendChild(tdValid);
    tr.appendChild(tdSkipped);
    tr.appendChild(tdMap);
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  container.appendChild(table);
  updateMappingCount();
}

function updateMappingCount() {
  const total   = _importCsvItems.length;
  const mapped  = Object.values(_importMapping).filter(v => v && v !== 'new').length;
  const el = $('mapping-count');
  if (el) el.textContent = `${mapped} de ${total} ítems mapeados`;
}

function selectConflict(chip) {
  document.querySelectorAll('#conflict-chips .type-chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
}

function openCreateItemModal(csvItemName, selectEl) {
  _createItemForName = csvItemName;
  $('create-item-for-label').textContent = `Para el ítem CSV: "${csvItemName}"`;
  $('new-item-name-import').value = csvItemName;

  // Populate category select
  const catSel = $('new-item-cat-import');
  catSel.innerHTML = '';
  _importCats.forEach(c => {
    const o = document.createElement('option');
    o.value = c.id; o.textContent = c.name;
    catSel.appendChild(o);
  });

  $('create-item-modal').classList.remove('hidden');
}

function closeCreateItemModal() {
  // Reset the dropdown that triggered "create new" back to blank
  if (_createItemForName) {
    const sel = document.querySelector(`select[data-csv-item="${_createItemForName}"]`);
    if (sel) {
      sel.value = _importMapping[_createItemForName] || '';
    }
  }
  $('create-item-modal').classList.add('hidden');
  _createItemForName = null;
}

function selectImportType(chip) {
  chip.closest('.type-chips').querySelectorAll('.type-chip').forEach(c => c.classList.remove('active'));
  chip.classList.add('active');
  const unitField = $('new-item-unit-import-field');
  if (unitField) unitField.classList.toggle('hidden', chip.dataset.type !== 'numeric');
}

async function confirmCreateItem() {
  const name   = $('new-item-name-import').value.trim();
  const catId  = parseInt($('new-item-cat-import').value);
  const type   = document.querySelector('#new-item-type-import .type-chip.active')?.dataset.type || 'none';
  const unit   = $('new-item-unit-import')?.value.trim() || '';

  if (!name)  { toast('El nombre es obligatorio', 'error'); return; }
  if (!catId) { toast('Selecciona una categoría', 'error'); return; }

  try {
    const newItem = await dbCreateItem({ name, category_id: catId, value_type: type, default_unit: unit });

    // Add to existing items list
    _importExisting.push(newItem);
    invalidateCache();

    // Update the mapping
    _importMapping[_createItemForName] = newItem.id;

    // Update the dropdown that triggered this
    const sel = document.querySelector(`select[data-csv-item="${_createItemForName}"]`);
    if (sel) {
      const o = document.createElement('option');
      o.value = newItem.id;
      o.textContent = `${newItem.category?.name || '?'} › ${newItem.name}`;
      o.selected = true;
      // Insert before "create new" option
      sel.insertBefore(o, sel.querySelector('option[value="new"]'));
      sel.value = newItem.id;
    }

    toast(`Ítem "${name}" creado`);
    $('create-item-modal').classList.add('hidden');
    _createItemForName = null;
    updateMappingCount();

  } catch (e) { toast(e.message, 'error'); }
}

async function executeImport() {
  const errEl = $('mapping-error');
  errEl.classList.add('hidden');

  // Validate: at least one item mapped
  const validMappings = Object.entries(_importMapping).filter(([,v]) => v && v !== 'new');
  if (!validMappings.length) {
    errEl.textContent = 'Mapea al menos un ítem antes de importar.';
    errEl.classList.remove('hidden');
    return;
  }

  const conflict = document.querySelector('#conflict-chips .type-chip.active')?.dataset.conflict || 'ignore';

  // Build mapping object with only valid entries (item_id numbers)
  const cleanMapping = {};
  validMappings.forEach(([name, id]) => { cleanMapping[name] = id; });

  const fileInput = $('csv-file');
  const btn = document.querySelector('#step-mapping .btn-primary');

  try {
    if (btn) { btn.disabled = true; btn.textContent = 'Importando…'; }
    const data = await dbImportExecute(fileInput.files[0], cleanMapping, conflict);
    invalidateCache();
    renderImportResult(data.stats);
    $('step-mapping').classList.add('hidden');
    $('step-result').classList.remove('hidden');
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
    if (btn) { btn.disabled = false; btn.textContent = 'Importar →'; }
  }
}

function renderImportResult(stats) {
  const el = $('result-stats');
  const rows = [
    { label: 'Entradas importadas',                  value: stats.imported,          color: 'var(--success)' },
    { label: 'Entradas sobreescritas',               value: stats.overwritten,       color: 'var(--warning)' },
    { label: 'Ignoradas por conflicto (ya existían)',value: stats.skipped_conflict,  color: 'var(--text-muted)' },
    { label: 'Ignoradas (valor NO)',                 value: stats.skipped_no,        color: 'var(--text-muted)' },
    { label: 'Ignoradas (datos inválidos)',           value: stats.skipped_bad,       color: 'var(--danger)' },
  ];

  el.innerHTML = rows.map(r => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border-dim)">
      <span style="font-size:13px;color:var(--text-sec)">${r.label}</span>
      <span style="font-size:18px;font-weight:700;font-family:monospace;color:${r.color}">${r.value}</span>
    </div>
  `).join('');
}

function resetImport() {
  $('step-upload').classList.remove('hidden');
  $('step-mapping').classList.add('hidden');
  $('step-result').classList.add('hidden');
  $('csv-file').value = '';
  $('upload-error').classList.add('hidden');
  _importMapping  = {};
  _importCsvItems = [];
  const btn = document.querySelector('#step-mapping .btn-primary');
  if (btn) { btn.disabled = false; btn.textContent = 'Importar →'; }
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeEntryModal();
    closeItemEditModal();
    closeDetailPanel();
    closeItemYearPanel();
  }
});
