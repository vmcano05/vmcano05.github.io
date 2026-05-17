/* ═══════════════════════════════════════════════════════════════════════════
   db.js — IndexedDB layer (replaces Flask REST API)
   ═══════════════════════════════════════════════════════════════════════════ */

const DB_NAME    = 'LifeTracker';
const DB_VERSION = 1;
let _db = null;

async function openDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('categories')) {
        db.createObjectStore('categories', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('items')) {
        const s = db.createObjectStore('items', { keyPath: 'id', autoIncrement: true });
        s.createIndex('category_id', 'category_id', { unique: false });
      }
      if (!db.objectStoreNames.contains('item_options')) {
        const s = db.createObjectStore('item_options', { keyPath: 'id', autoIncrement: true });
        s.createIndex('item_id', 'item_id', { unique: false });
      }
      if (!db.objectStoreNames.contains('entries')) {
        const s = db.createObjectStore('entries', { keyPath: 'id', autoIncrement: true });
        s.createIndex('date',    'date',    { unique: false });
        s.createIndex('item_id', 'item_id', { unique: false });
      }
    };
  });
}

// ── Low-level helpers ─────────────────────────────────────────────────────────

function tx(storeName, mode) {
  return openDB().then(db => db.transaction(storeName, mode).objectStore(storeName));
}

async function dbAll(store) {
  const s = await tx(store, 'readonly');
  return new Promise((res, rej) => { const r = s.getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

async function dbGet(store, id) {
  const s = await tx(store, 'readonly');
  return new Promise((res, rej) => { const r = s.get(id); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

async function dbAdd(store, record) {
  const s = await tx(store, 'readwrite');
  return new Promise((res, rej) => { const r = s.add(record); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

async function dbPut(store, record) {
  const s = await tx(store, 'readwrite');
  return new Promise((res, rej) => { const r = s.put(record); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

async function dbDel(store, id) {
  const s = await tx(store, 'readwrite');
  return new Promise((res, rej) => { const r = s.delete(id); r.onsuccess = () => res(); r.onerror = () => rej(r.error); });
}

async function dbByIndex(store, indexName, value) {
  const db = await openDB();
  const s = db.transaction(store, 'readonly').objectStore(store).index(indexName);
  return new Promise((res, rej) => { const r = s.getAll(value); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}

// ── Enrichment ────────────────────────────────────────────────────────────────

function enrichItem(item, cats, allOpts) {
  return {
    ...item,
    gradient_colors: item.gradient_colors || [],
    category: cats.find(c => c.id === item.category_id) || null,
    options: allOpts.filter(o => o.item_id === item.id).sort((a,b) => (a.sort_order||0)-(b.sort_order||0)),
  };
}

async function enrichEntry(entry, items, cats, allOpts) {
  const item = items.find(i => i.id === entry.item_id) || null;
  const itemOpts = item ? allOpts.filter(o => o.item_id === item.id) : [];
  const option   = entry.option_id ? itemOpts.find(o => o.id === entry.option_id) || null : null;
  return {
    ...entry,
    option,
    item: item ? enrichItem(item, cats, allOpts) : null,
  };
}

async function allItemData() {
  const [items, cats, opts] = await Promise.all([dbAll('items'), dbAll('categories'), dbAll('item_options')]);
  return { items, cats, opts };
}

// ── Categories ────────────────────────────────────────────────────────────────

async function dbGetCategories() {
  const cats = await dbAll('categories');
  return cats.sort((a,b) => a.name.localeCompare(b.name,'es'));
}

async function dbCreateCategory(data) {
  const id = await dbAdd('categories', { name: data.name, color: data.color||'#8b5cf6', icon: data.icon||'' });
  return dbGet('categories', id);
}

async function dbUpdateCategory(id, data) {
  const cat = await dbGet('categories', id);
  if (!cat) throw new Error('Categoría no encontrada');
  const updated = { ...cat, ...data, id };
  await dbPut('categories', updated);
  return updated;
}

async function dbDeleteCategory(id) {
  const items = await dbAll('items');
  const count = items.filter(i => i.category_id === id).length;
  if (count) throw new Error(`Esta categoría tiene ${count} ítem(s). Elimínalos primero.`);
  await dbDel('categories', id);
  return { ok: true };
}

// ── Items ─────────────────────────────────────────────────────────────────────

async function dbGetItems(params = {}) {
  const { items, cats, opts } = await allItemData();
  let result = items.map(i => enrichItem(i, cats, opts));
  result.sort((a,b) => (a.sort_order||0)-(b.sort_order||0) || a.name.localeCompare(b.name,'es'));

  if (params.include_counts === 'true') {
    const entries  = await dbAll('entries');
    const cutoff   = new Date(); cutoff.setDate(cutoff.getDate()-30);
    const cISO     = cutoff.toISOString().slice(0,10);
    result = result.map(item => ({
      ...item,
      recent_count: entries.filter(e => e.item_id===item.id && e.date>=cISO).length,
    }));
  }
  return result;
}

async function dbCreateItem(data) {
  const items    = await dbAll('items');
  const maxOrder = items.reduce((m,i) => Math.max(m, i.sort_order||0), 0);
  const id = await dbAdd('items', {
    category_id:    data.category_id,
    name:           data.name,
    default_unit:   data.default_unit  || '',
    value_type:     data.value_type    || 'none',
    value_required: data.value_required|| false,
    sort_order:     maxOrder+1,
    color_mode:     data.color_mode    || 'category',
    gradient_colors:data.gradient_colors || [],
  });
  const { cats, opts } = await allItemData();
  return enrichItem(await dbGet('items', id), cats, opts);
}

async function dbUpdateItem(id, data) {
  const item = await dbGet('items', id);
  if (!item) throw new Error('Ítem no encontrado');
  const updated = { ...item };
  ['name','default_unit','value_type','value_required','color_mode','category_id'].forEach(f => { if (f in data) updated[f]=data[f]; });
  if ('gradient_colors' in data) updated.gradient_colors = data.gradient_colors;
  await dbPut('items', updated);
  const { cats, opts } = await allItemData();
  return enrichItem(updated, cats, opts);
}

async function dbDeleteItem(id, params = {}) {
  const entries = await dbAll('entries');
  const count   = entries.filter(e => e.item_id===id).length;
  if (count && !params.force) throw new Error(`Este ítem tiene ${count} entrada(s).`);
  if (count && params.force) await Promise.all(entries.filter(e=>e.item_id===id).map(e=>dbDel('entries',e.id)));
  const opts = await dbByIndex('item_options','item_id',id);
  await Promise.all(opts.map(o=>dbDel('item_options',o.id)));
  await dbDel('items', id);
  return { ok: true };
}

async function dbReorderItems(data) {
  await Promise.all(data.map(async ({id, sort_order}) => {
    const item = await dbGet('items', id);
    if (item) await dbPut('items', {...item, sort_order});
  }));
  return { ok: true };
}

// ── Item options ──────────────────────────────────────────────────────────────

async function dbGetOptions(itemId) {
  const opts = await dbByIndex('item_options','item_id',itemId);
  return opts.sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));
}

async function dbCreateOption(itemId, data) {
  const existing  = await dbByIndex('item_options','item_id',itemId);
  const maxOrder  = existing.reduce((m,o)=>Math.max(m,o.sort_order||0),0);
  const id = await dbAdd('item_options', { item_id:itemId, label:data.label, color:data.color||'#8b5cf6', sort_order:maxOrder+1 });
  return dbGet('item_options', id);
}

async function dbUpdateOption(id, data) {
  const opt = await dbGet('item_options', id);
  if (!opt) throw new Error('Opción no encontrada');
  const updated = { ...opt, ...data, id };
  await dbPut('item_options', updated);
  return updated;
}

async function dbDeleteOption(id) {
  await dbDel('item_options', id);
  return { ok: true };
}

// ── Entries ───────────────────────────────────────────────────────────────────

async function dbFilterEntries(params = {}) {
  const [allEntries, { items, cats, opts }] = await Promise.all([dbAll('entries'), allItemData()]);
  let entries = allEntries;

  if (params.date)      entries = entries.filter(e => e.date === params.date);
  if (params.date_from) entries = entries.filter(e => e.date >= params.date_from);
  if (params.date_to)   entries = entries.filter(e => e.date <= params.date_to);

  if (params.item_ids) {
    const ids = params.item_ids.split(',').map(Number);
    entries = entries.filter(e => ids.includes(e.item_id));
  } else if (params.item_id) {
    entries = entries.filter(e => e.item_id === parseInt(params.item_id));
  }

  if (params.category_ids) {
    const ids = params.category_ids.split(',').map(Number);
    entries = entries.filter(e => { const it=items.find(i=>i.id===e.item_id); return it && ids.includes(it.category_id); });
  } else if (params.category_id) {
    const cid = parseInt(params.category_id);
    entries = entries.filter(e => { const it=items.find(i=>i.id===e.item_id); return it && it.category_id===cid; });
  }

  entries.sort((a,b)=>b.date.localeCompare(a.date));
  return Promise.all(entries.map(e => enrichEntry(e, items, cats, opts)));
}

async function dbGetEntries(params = {}) { return dbFilterEntries(params); }

async function dbGetEntriesSummary(params = {}) {
  const entries = await dbFilterEntries(params);
  return entries.map(e => ({ id:e.id, date:e.date, item_id:e.item_id, option_id:e.option_id, value:e.value, unit:e.unit, has_notes:!!e.notes }));
}

async function dbGetEntry(id) {
  const entry = await dbGet('entries', id);
  if (!entry) throw new Error('Entrada no encontrada');
  const { items, cats, opts } = await allItemData();
  return enrichEntry(entry, items, cats, opts);
}

async function dbCreateEntry(data) {
  const id = await dbAdd('entries', {
    date:      data.date,
    item_id:   data.item_id,
    value:     data.value    ?? null,
    unit:      data.unit     ?? null,
    option_id: data.option_id?? null,
    notes:     data.notes    ?? null,
    updated_at:new Date().toISOString(),
  });
  return dbGetEntry(id);
}

async function dbUpdateEntry(id, data) {
  const entry = await dbGet('entries', id);
  if (!entry) throw new Error('Entrada no encontrada');
  const updated = { ...entry, updated_at: new Date().toISOString() };
  if ('date' in data) updated.date = data.date;
  ['value','unit','option_id','notes','item_id'].forEach(f => { if (f in data) updated[f]=data[f]; });
  await dbPut('entries', updated);
  return dbGetEntry(id);
}

async function dbDeleteEntry(id) {
  await dbDel('entries', id);
  return { ok: true };
}

// ── Calendar ──────────────────────────────────────────────────────────────────

async function dbGetCalendar(params = {}) {
  const entries = await dbFilterEntries(params);
  const byDate  = {};
  entries.forEach(e => { (byDate[e.date] = byDate[e.date]||[]).push(e); });
  return byDate;
}

// ── Import ────────────────────────────────────────────────────────────────────

function parseCSVText(text) {
  const lines = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n');
  if (!lines.length) return { headers:[], rows:[] };
  // Handle BOM
  const rawHeaders = lines[0].replace(/^\uFEFF/,'');
  const headers = rawHeaders.split(',').map(h=>h.trim());
  const rows = lines.slice(1).filter(l=>l.trim()).map(line => {
    const vals=[]; let cur='', inQ=false;
    for(let i=0;i<line.length;i++){
      if(line[i]==='"'){ inQ=!inQ; } else if(line[i]===','&&!inQ){ vals.push(cur); cur=''; } else cur+=line[i];
    }
    vals.push(cur);
    const row={};
    headers.forEach((h,i)=>{ row[h]=(vals[i]||'').trim(); });
    return row;
  });
  return { headers, rows };
}

function isValidDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)); }

async function dbImportPreview(file) {
  const text = await file.text();
  const { headers, rows } = parseCSVText(text);
  const required = ['Date','Value','Item'];
  const missing  = required.filter(r=>!headers.includes(r));
  if (missing.length) throw new Error(`Faltan columnas: ${missing.join(', ')}`);

  const itemsFound = {};
  const badDates   = [];

  for (const row of rows) {
    const rawValue = (row['Value']||'').trim();
    const itemName = (row['Item'] ||'').trim();
    const rawDate  = (row['Date'] ||'').trim();
    if (!itemName) continue;
    if (!itemsFound[itemName]) itemsFound[itemName]={total:0,valid:0,skipped_no:0,skipped_bad_date:0};
    itemsFound[itemName].total++;
    if (rawValue.toUpperCase()==='NO') { itemsFound[itemName].skipped_no++; continue; }
    if (!isValidDate(rawDate)) { itemsFound[itemName].skipped_bad_date++; badDates.push(rawDate); continue; }
    itemsFound[itemName].valid++;
  }

  const [existingItems, existingCats] = await Promise.all([dbGetItems(), dbGetCategories()]);
  return {
    csv_items:      Object.entries(itemsFound).map(([name,s])=>({name,...s})),
    existing_items: existingItems,
    existing_cats:  existingCats,
    bad_dates:      [...new Set(badDates)].slice(0,10),
  };
}

async function dbImportExecute(file, mapping, conflict) {
  const text = await file.text();
  const { rows } = parseCSVText(text);
  const [enrichedItems, rawEntries] = await Promise.all([dbGetItems(), dbAll('entries')]);

  const stats = { imported:0, skipped_no:0, skipped_conflict:0, overwritten:0, skipped_bad:0 };
  const idx   = {};
  rawEntries.forEach(e => { idx[`${e.item_id}|${e.date}`]=e.id; });

  for (const row of rows) {
    const rawValue = (row['Value']||'').trim();
    const itemName = (row['Item'] ||'').trim();
    const rawDate  = (row['Date'] ||'').trim();
    const notes    = (row['Notes']||'').trim()||null;

    if (rawValue.toUpperCase()==='NO') { stats.skipped_no++; continue; }
    if (!isValidDate(rawDate))         { stats.skipped_bad++; continue; }

    const itemId = mapping[itemName];
    if (!itemId) { stats.skipped_bad++; continue; }
    const item = enrichedItems.find(i=>i.id===parseInt(itemId));
    if (!item)   { stats.skipped_bad++; continue; }

    let value = null;
    if (rawValue.toUpperCase()!=='YES_MANUAL') { const n=parseFloat(rawValue); if(!isNaN(n)) value=n; }

    const key = `${item.id}|${rawDate}`;
    const existingId = idx[key];

    if (existingId) {
      if (conflict==='ignore') { stats.skipped_conflict++; continue; }
      const existing = await dbGet('entries', existingId);
      await dbPut('entries', {...existing, value, unit:item.default_unit||null, notes, updated_at:new Date().toISOString()});
      stats.overwritten++;
    } else {
      const id = await dbAdd('entries', { date:rawDate, item_id:item.id, value, unit:value!==null?(item.default_unit||null):null, option_id:null, notes, updated_at:new Date().toISOString() });
      idx[key]=id;
      stats.imported++;
    }
  }
  return { ok:true, stats };
}

// ── Main API router ───────────────────────────────────────────────────────────
// Mimics Flask's REST API — api() in app.js calls this instead of fetch()

async function localApi(path, opts = {}) {
  const method = (opts.method||'GET').toUpperCase();
  const body   = opts.body ? JSON.parse(opts.body) : null;
  const [pathOnly, qs] = path.split('?');
  const params = {};
  if (qs) qs.split('&').forEach(p => { const [k,v]=p.split('='); if(k) params[decodeURIComponent(k)]=decodeURIComponent(v||''); });
  const seg = pathOnly.replace(/^\/api\//,'').split('/');

  // ── categories ───────────────────────────────────────────────────────────
  if (seg[0]==='categories') {
    if (seg.length===1) {
      if (method==='GET')  return dbGetCategories();
      if (method==='POST') return dbCreateCategory(body);
    }
    if (seg.length===2) {
      const id = parseInt(seg[1]);
      if (method==='PUT')    return dbUpdateCategory(id, body);
      if (method==='DELETE') return dbDeleteCategory(id);
    }
  }

  // ── items ─────────────────────────────────────────────────────────────────
  if (seg[0]==='items') {
    if (seg.length===1) {
      if (method==='GET')  return dbGetItems(params);
      if (method==='POST') return dbCreateItem(body);
    }
    if (seg.length===2) {
      if (seg[1]==='reorder' && method==='PUT') return dbReorderItems(body);
      const id = parseInt(seg[1]);
      if (method==='PUT')    return dbUpdateItem(id, body);
      if (method==='DELETE') return dbDeleteItem(id, params);
    }
    if (seg.length===3 && seg[2]==='options') {
      const itemId = parseInt(seg[1]);
      if (method==='GET')  return dbGetOptions(itemId);
      if (method==='POST') return dbCreateOption(itemId, body);
    }
  }

  // ── options ───────────────────────────────────────────────────────────────
  if (seg[0]==='options') {
    const id = parseInt(seg[1]);
    if (method==='PUT')    return dbUpdateOption(id, body);
    if (method==='DELETE') return dbDeleteOption(id);
  }

  // ── entries ───────────────────────────────────────────────────────────────
  if (seg[0]==='entries') {
    if (seg.length===1) {
      if (method==='GET')  return dbGetEntries(params);
      if (method==='POST') return dbCreateEntry(body);
    }
    if (seg.length===2) {
      if (seg[1]==='summary' && method==='GET') return dbGetEntriesSummary(params);
      const id = parseInt(seg[1]);
      if (method==='GET')    return dbGetEntry(id);
      if (method==='PUT')    return dbUpdateEntry(id, body);
      if (method==='DELETE') return dbDeleteEntry(id);
    }
  }

  // ── calendar ──────────────────────────────────────────────────────────────
  if (seg[0]==='calendar' && method==='GET') return dbGetCalendar(params);

  throw new Error(`Ruta no reconocida: ${method} ${path}`);
}
