// ═════════════════════════════════════════
// AGRO REPORT — אפליקציית דוח פיקוח
// ═════════════════════════════════════════
var APP_VERSION = '2.0.0';

// ─────────────────────────────────────────
// STATE
// ─────────────────────────────────────────
var trees = [];            // {id, num, type, number, note}
var photos = [];           // {id, owner ('notes' | tree.id), ts, caption, orig: Blob, small: 'WxH|dataUrl'}
var treeCounter = 0;
var currentTab = 0;
var lastReport = null;     // {blob, filename}
var deferredInstall = null;

var IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
             (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

var SUBTITLE_MAP = [
  'שלב 1 מתוך 4 — פרטי הסיור',
  'שלב 2 מתוך 4 — עצים שנסקרו',
  'שלב 3 מתוך 4 — הערות והנחיות',
  'שלב 4 מתוך 4 — שמירה ושליחה'
];

function $(id) { return document.getElementById(id); }
function lsGet(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

// ─────────────────────────────────────────
// INDEXEDDB — שמירת תמונות קבועה בטלפון
// ─────────────────────────────────────────
var DB_NAME = 'agro_report_db', DB_STORE = 'photos', _db = null;

function idb() {
  if (_db) return Promise.resolve(_db);
  return new Promise(function (res, rej) {
    var req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = function () { req.result.createObjectStore(DB_STORE, { keyPath: 'id' }); };
    req.onsuccess = function () { _db = req.result; res(_db); };
    req.onerror = function () { rej(req.error); };
  });
}
function idbTx(mode, fn) {
  return idb().then(function (db) {
    return new Promise(function (res, rej) {
      var tx = db.transaction(DB_STORE, mode);
      var store = tx.objectStore(DB_STORE);
      var out = fn(store);
      tx.oncomplete = function () { res(out && out.result !== undefined ? out.result : undefined); };
      tx.onerror = function () { rej(tx.error); };
      tx.onabort = function () { rej(tx.error); };
    });
  });
}
function idbPut(rec) { return idbTx('readwrite', function (s) { s.put(rec); }); }
function idbDel(id) { return idbTx('readwrite', function (s) { s.delete(id); }); }
function idbClear() { return idbTx('readwrite', function (s) { s.clear(); }); }
function idbAll() { return idbTx('readonly', function (s) { return s.getAll(); }); }

// ─────────────────────────────────────────
// INIT
// ─────────────────────────────────────────
function init() {
  var today = new Date();
  $('f_date').value = String(today.getDate()).padStart(2, '0') + '/' +
                      String(today.getMonth() + 1).padStart(2, '0') + '/' + today.getFullYear();

  var defInsp = lsGet('defaultInspector', '');
  if (defInsp) $('f_inspector').value = defInsp;
  $('s_defaultInspector').value = defInsp;

  // Auto-save-to-phone setting (Android only; iOS requires a tap per save)
  var autoDefault = IS_IOS ? '0' : '1';
  $('s_autoSave').checked = lsGet('autoSavePhone', autoDefault) === '1';
  if (IS_IOS) { $('autoSaveRow').style.display = 'none'; $('iosHint').style.display = 'block'; }
  $('appVersion').textContent = APP_VERSION;

  buildProjectSelect();

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});

  // Restore draft (text + photos from IndexedDB)
  var draft = null;
  try { draft = JSON.parse(lsGet(AUTOSAVE_KEY, 'null')); } catch (e) {}
  idbAll().catch(function () { return []; }).then(function (recs) {
    photos = (recs || []).sort(function (a, b) { return a.ts - b.ts; });
    var hasContent = draft && (draft.f_project || draft.f_recipient || draft.f_notes ||
                               (draft.trees_meta && draft.trees_meta.length));
    if (hasContent) restoreDraft(draft);
    // Orphan photos (no tree) → show under notes so nothing is lost
    photos.forEach(function (p) {
      if (p.owner !== 'notes' && !trees.some(function (t) { return t.id === p.owner; })) p.owner = 'notes';
    });
    renderNotesPhotos();
    trees.forEach(function (t) { renderTreePhotos(t); });
    if (hasContent || photos.length) showToast('📋 טיוטה קודמת שוחזרה' + (photos.length ? ' (' + photos.length + ' תמונות)' : ''));
    renderProjectTrees();
  });

  attachAutosaveListeners();
}

// ─────────────────────────────────────────
// PROJECTS (from projects.js generated from Excel)
// ─────────────────────────────────────────
function buildProjectSelect() {
  var sel = $('f_projectSel');
  var list = (typeof PROJECTS !== 'undefined' ? PROJECTS : []).slice()
    .sort(function (a, b) { return a.name.localeCompare(b.name, 'he'); });
  list.forEach(function (p) {
    var o = document.createElement('option');
    o.value = p.name;
    o.textContent = p.name + ' (' + p.trees.length + ' עצים)';
    sel.appendChild(o);
  });
  var other = document.createElement('option');
  other.value = '__other';
  other.textContent = 'פרויקט אחר (הקלדה חופשית)';
  sel.appendChild(other);
  sel.addEventListener('change', onProjectSelChange);
}

function onProjectSelChange() {
  var v = $('f_projectSel').value;
  if (v === '__other') {
    $('projectOtherWrap').style.display = 'block';
    if (findProject($('f_project').value)) $('f_project').value = '';
    $('f_project').focus();
  } else {
    $('projectOtherWrap').style.display = 'none';
    $('f_project').value = v;
  }
  renderProjectTrees();
  trees.forEach(updateTreeStatusBadge);
  scheduleSave();
}

function syncProjectSelFromText() {
  var name = $('f_project').value;
  var p = findProject(name);
  if (p) { $('f_projectSel').value = p.name; $('projectOtherWrap').style.display = 'none'; }
  else if (name) { $('f_projectSel').value = '__other'; $('projectOtherWrap').style.display = 'block'; }
  else { $('f_projectSel').value = ''; $('projectOtherWrap').style.display = 'none'; }
}

function findProject(name) {
  if (!name || typeof PROJECTS === 'undefined') return null;
  name = name.trim();
  for (var i = 0; i < PROJECTS.length; i++) if (PROJECTS[i].name === name) return PROJECTS[i];
  return null;
}
function currentProject() { return findProject($('f_project').value); }

function normNum(n) { return String(n || '').trim().toUpperCase(); }

function statusOf(number) {
  var p = currentProject();
  if (!p || !number) return '';
  var key = normNum(number);
  for (var i = 0; i < p.trees.length; i++) if (normNum(p.trees[i].n) === key) return p.trees[i].s;
  return '';
}

function statusClass(s) { return s === 'שימור' ? 'st-keep' : (s === 'העתקה' ? 'st-move' : ''); }

// The reference list at the top of the trees tab
function renderProjectTrees() {
  var box = $('projectTrees');
  var p = currentProject();
  var dl = $('treeNumbersList');
  dl.innerHTML = '';
  if (!p) {
    box.innerHTML = '';
    var em = document.createElement('div');
    em.className = 'pt-empty';
    em.textContent = $('f_project').value
      ? 'לפרויקט "' + $('f_project').value + '" אין רשימת עצים מיוחדים.'
      : 'בחר פרויקט בלשונית "פרטים" כדי לראות את רשימת העצים לשימור ולהעתקה.';
    box.appendChild(em);
    return;
  }
  p.trees.forEach(function (t) {
    var o = document.createElement('option');
    o.value = t.n; o.label = t.s;
    dl.appendChild(o);
  });

  var documented = {};
  trees.forEach(function (t) { if (t.number) documented[normNum(t.number)] = true; });
  var q = normNum($('ptSearch') ? $('ptSearch').value : '');

  box.innerHTML = '';
  var head = document.createElement('div');
  head.className = 'pt-head';
  var doneCount = p.trees.filter(function (t) { return documented[normNum(t.n)]; }).length;
  head.innerHTML = '<span>' + escapeHtml(p.name) + '</span><span class="pt-count">תועדו ' + doneCount + ' מתוך ' + p.trees.length + '</span>';
  box.appendChild(head);

  [['שימור', 'לשימור'], ['העתקה', 'להעתקה']].forEach(function (g) {
    var list = p.trees.filter(function (t) { return t.s === g[0]; });
    if (!list.length) return;
    var grp = document.createElement('div');
    grp.className = 'pt-group';
    var lbl = document.createElement('div');
    lbl.className = 'pt-label ' + statusClass(g[0]);
    lbl.textContent = g[1] + ' (' + list.length + ')';
    grp.appendChild(lbl);
    var chips = document.createElement('div');
    chips.className = 'pt-chips';
    list.forEach(function (t) {
      if (q && normNum(t.n).indexOf(q) === -1) return;
      var c = document.createElement('button');
      c.type = 'button';
      c.className = 'chip ' + statusClass(t.s) + (documented[normNum(t.n)] ? ' done' : '');
      c.textContent = (documented[normNum(t.n)] ? '✓ ' : '') + t.n;
      c.title = t.s;
      c.addEventListener('click', function () { openOrAddTree(t.n); });
      chips.appendChild(c);
    });
    grp.appendChild(chips);
    box.appendChild(grp);
  });

  var others = p.trees.filter(function (t) { return t.s !== 'שימור' && t.s !== 'העתקה'; });
  if (others.length) {
    var o2 = document.createElement('div');
    o2.className = 'pt-empty';
    o2.textContent = 'עצים ללא סטטוס: ' + others.map(function (t) { return t.n; }).join(', ');
    box.appendChild(o2);
  }
}

function openOrAddTree(number) {
  var existing = trees.filter(function (t) { return normNum(t.number) === normNum(number); })[0];
  if (!existing) existing = addTree(number);
  var card = $('tcard_' + existing.id);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    card.classList.add('flash');
    setTimeout(function () { card.classList.remove('flash'); }, 1200);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
}

// ─────────────────────────────────────────
// TABS
// ─────────────────────────────────────────
function goToTab(idx) {
  currentTab = idx;
  for (var i = 0; i < 4; i++) {
    $('panel' + i).classList.toggle('active', i === idx);
    $('tab' + i).classList.toggle('active', i === idx);
    var dot = $('dot' + i);
    dot.className = 'step-dot';
    if (i < idx) dot.classList.add('done');
    else if (i === idx) dot.classList.add('active');
  }
  $('appSubtitle').textContent = SUBTITLE_MAP[idx];
  if (idx === 1) renderProjectTrees();
  if (idx === 3) { buildSummary(); renderShareSection(); }
  window.scrollTo(0, 0);
}

// ─────────────────────────────────────────
// TREES
// ─────────────────────────────────────────
function addTree(number) {
  treeCounter++;
  var tree = { id: 'tree_' + Date.now() + '_' + Math.floor(Math.random() * 1000), num: treeCounter, type: '', number: number || '', note: '' };
  trees.push(tree);
  renderTree(tree);
  renderProjectTrees();
  scheduleSave();
  return tree;
}

function renderTree(tree) {
  var card = document.createElement('div');
  card.className = 'tree-card';
  card.id = 'tcard_' + tree.id;

  var header = document.createElement('div');
  header.className = 'tree-header';
  var titleWrap = document.createElement('div');
  titleWrap.style.cssText = 'display:flex;align-items:center;gap:8px;';
  var titleEl = document.createElement('div');
  titleEl.className = 'tree-header-title';
  titleEl.textContent = 'עץ ' + tree.num;
  var badge = document.createElement('span');
  badge.className = 'status-badge';
  badge.id = 'badge_' + tree.id;
  titleWrap.appendChild(titleEl);
  titleWrap.appendChild(badge);

  var delBtn = document.createElement('button');
  delBtn.className = 'del-btn';
  delBtn.textContent = 'הסר';
  delBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    confirmDialog('להסיר את עץ ' + tree.num + (tree.number ? ' (' + tree.number + ')' : '') + ' ואת התמונות שלו?', 'הסר', function () { removeTree(tree.id); });
  });
  header.appendChild(titleWrap);
  header.appendChild(delBtn);

  var body = document.createElement('div');
  body.className = 'tree-body';
  body.appendChild(makeFieldWithValue('עץ מספר', 'text', 'מספר העץ', tree.number, function (v) {
    tree.number = v; updateTreeStatusBadge(tree); renderProjectTrees(); scheduleSave();
  }, 'treeNumbersList'));
  body.appendChild(makeFieldWithValue('סוג עץ', 'text', 'סוג העץ', tree.type, function (v) { tree.type = v; scheduleSave(); }));
  body.appendChild(makeFieldWithValue('הערה לעץ', 'textarea', 'הערה ספציפית לעץ...', tree.note, function (v) { tree.note = v; scheduleSave(); }));

  body.appendChild(makePhotoButtons(tree.id));
  var strip = document.createElement('div');
  strip.className = 'photo-strip';
  strip.id = 'strip_' + tree.id;
  body.appendChild(strip);

  card.appendChild(header);
  card.appendChild(body);
  $('treesContainer').appendChild(card);
  updateTreeStatusBadge(tree);
}
var renderTreeWithValues = renderTree;

function updateTreeStatusBadge(tree) {
  var b = $('badge_' + tree.id);
  if (!b) return;
  var s = statusOf(tree.number);
  b.className = 'status-badge ' + statusClass(s);
  b.textContent = s ? (s === 'שימור' ? 'לשימור' : s === 'העתקה' ? 'להעתקה' : s) : '';
  b.style.display = s ? 'inline-block' : 'none';
}

function makePhotoButtons(owner) {
  var wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:8px;margin-top:8px;margin-bottom:8px;flex-wrap:wrap;';
  var cam = document.createElement('input');
  cam.type = 'file'; cam.accept = 'image/*'; cam.capture = 'environment'; cam.multiple = true; cam.style.display = 'none';
  cam.addEventListener('change', function (e) { handlePhotos(e, owner, true); });
  var gal = document.createElement('input');
  gal.type = 'file'; gal.accept = 'image/*'; gal.multiple = true; gal.style.display = 'none';
  gal.addEventListener('change', function (e) { handlePhotos(e, owner, false); });
  var camBtn = document.createElement('button');
  camBtn.className = 'btn btn-outline'; camBtn.textContent = '📷 צלם';
  camBtn.addEventListener('click', function () { cam.click(); });
  var galBtn = document.createElement('button');
  galBtn.className = 'btn btn-outline'; galBtn.textContent = '🖼 גלריה';
  galBtn.addEventListener('click', function () { gal.click(); });
  wrap.appendChild(camBtn); wrap.appendChild(galBtn); wrap.appendChild(cam); wrap.appendChild(gal);
  return wrap;
}

function makeFieldWithValue(labelText, inputType, placeholder, value, onChange, listId) {
  var wrapper = document.createElement('div');
  wrapper.className = 'field';
  var lbl = document.createElement('label');
  lbl.textContent = labelText;
  var el;
  if (inputType === 'textarea') { el = document.createElement('textarea'); }
  else { el = document.createElement('input'); el.type = inputType; }
  el.placeholder = placeholder;
  if (listId) { el.setAttribute('list', listId); el.setAttribute('inputmode', 'text'); el.autocomplete = 'off'; }
  el.value = value || '';
  el.addEventListener('input', function () { onChange(el.value); });
  wrapper.appendChild(lbl);
  wrapper.appendChild(el);
  return wrapper;
}

function removeTree(id) {
  trees = trees.filter(function (t) { return t.id !== id; });
  var card = $('tcard_' + id);
  if (card) card.remove();
  photos.filter(function (p) { return p.owner === id; }).forEach(function (p) { idbDel(p.id).catch(function () {}); });
  photos = photos.filter(function (p) { return p.owner !== id; });
  trees.forEach(function (t, i) {
    t.num = i + 1;
    var h = document.querySelector('#tcard_' + t.id + ' .tree-header-title');
    if (h) h.textContent = 'עץ ' + t.num;
  });
  treeCounter = trees.length;
  renderProjectTrees();
  scheduleSave();
}

// ─────────────────────────────────────────
// PHOTOS
// ─────────────────────────────────────────
function handlePhotos(event, owner, fromCamera) {
  var files = Array.prototype.slice.call(event.target.files || []);
  event.target.value = '';
  if (!files.length) return;
  var autoSave = fromCamera && !IS_IOS && $('s_autoSave').checked;
  var added = [];
  var chain = Promise.resolve();
  files.forEach(function (file) {
    chain = chain.then(function () {
      return compressBlob(file, 1200, 0.65).then(function (small) {
        var rec = { id: 'ph_' + Date.now() + '_' + Math.floor(Math.random() * 1e6), owner: owner, ts: Date.now(),
                    caption: '', orig: file, small: small, name: file.name || '' };
        photos.push(rec);
        added.push(rec);
        if (owner === 'notes') renderNotesPhotos(); else renderTreePhotos({ id: owner });
        return idbPut(rec).catch(function (e) {
          console.error(e);
          showToast('⚠️ לא ניתן לשמור תמונה בזיכרון הטלפון');
        });
      });
    });
  });
  chain.then(function () {
    if (autoSave && added.length) {
      downloadFiles(added.map(photoFile));
      showToast('📷 ' + added.length + ' תמונות נשמרו גם בטלפון (הורדות)');
    } else {
      showToast('📷 נוספו ' + added.length + ' תמונות');
    }
  });
}

function compressBlob(blob, maxPx, quality) {
  return new Promise(function (res, rej) {
    var url = URL.createObjectURL(blob);
    var img = new Image();
    img.onload = function () {
      var w = img.naturalWidth, h = img.naturalHeight;
      if (w > maxPx || h > maxPx) {
        var r = Math.min(maxPx / w, maxPx / h);
        w = Math.round(w * r); h = Math.round(h * r);
      }
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      res(w + 'x' + h + '|' + c.toDataURL('image/jpeg', quality));
    };
    img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('לא ניתן לקרוא תמונה')); };
    img.src = url;
  });
}

function photosOf(owner) { return photos.filter(function (p) { return p.owner === owner; }); }

function renderTreePhotos(tree) {
  var strip = $('strip_' + tree.id);
  if (!strip) return;
  strip.innerHTML = '';
  photosOf(tree.id).forEach(function (p) { strip.appendChild(makeThumb(p)); });
}

function renderNotesPhotos() {
  var strip = $('notesPhotoStrip');
  strip.innerHTML = '';
  photosOf('notes').forEach(function (p) {
    var wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;flex-direction:column;gap:4px;margin-bottom:8px;width:100%;';
    wrapper.appendChild(makeThumb(p));
    var caption = document.createElement('input');
    caption.type = 'text';
    caption.className = 'caption-input';
    caption.placeholder = 'פירוט לתמונה (אופציונלי)';
    caption.value = p.caption || '';
    var t = null;
    caption.addEventListener('input', function () {
      p.caption = caption.value;
      clearTimeout(t); t = setTimeout(function () { idbPut(p).catch(function () {}); }, 600);
    });
    wrapper.appendChild(caption);
    strip.appendChild(wrapper);
  });
}

function makeThumb(p) {
  var wrapper = document.createElement('div');
  wrapper.className = 'photo-del';
  var img = document.createElement('img');
  img.src = rawDataUrl(p.small);
  img.className = 'photo-thumb';
  img.addEventListener('click', function () { openViewer(p); });
  var x = document.createElement('div');
  x.className = 'del-x';
  x.textContent = '✕';
  x.addEventListener('click', function () { confirmDialog('למחוק את התמונה?', 'מחק', function () { deletePhoto(p); }); });
  wrapper.appendChild(x);
  wrapper.appendChild(img);
  return wrapper;
}

function deletePhoto(p) {
  photos = photos.filter(function (q) { return q !== p; });
  idbDel(p.id).catch(function () {});
  if (p.owner === 'notes') renderNotesPhotos(); else renderTreePhotos({ id: p.owner });
}

// Full-screen viewer with save / share / delete
function openViewer(p) {
  var ov = $('viewer');
  var url = URL.createObjectURL(p.orig);
  $('viewerImg').src = url;
  $('viewerInfo').textContent = photoLabel(p);
  ov.classList.add('open');
  $('viewerSave').onclick = function () { savePhotosToPhone([p]); };
  $('viewerShare').onclick = function () { shareFiles([photoFile(p)], photoLabel(p)); };
  $('viewerDel').onclick = function () { confirmDialog('למחוק את התמונה?', 'מחק', function () { deletePhoto(p); closeViewer(); }); };
  ov._url = url;
}
function closeViewer() {
  var ov = $('viewer');
  ov.classList.remove('open');
  if (ov._url) { URL.revokeObjectURL(ov._url); ov._url = null; }
  $('viewerImg').src = '';
}

function photoLabel(p) {
  if (p.owner === 'notes') return 'תמונת סיור' + (p.caption ? ' — ' + p.caption : '');
  var t = trees.filter(function (t) { return t.id === p.owner; })[0];
  if (!t) return 'תמונה';
  var s = statusOf(t.number);
  return 'עץ ' + t.num + (t.number ? ' · מס׳ ' + t.number : '') + (s ? ' · ' + s : '');
}

function safeName(s) { return String(s || '').replace(/[\\\/:*?"<>|]+/g, '-').replace(/\s+/g, '_').slice(0, 60); }

function photoFile(p) {
  var proj = safeName($('f_project').value) || 'סיור';
  var date = $('f_date').value.replace(/\//g, '');
  var part;
  if (p.owner === 'notes') part = 'סיור';
  else {
    var t = trees.filter(function (t) { return t.id === p.owner; })[0];
    part = 'עץ_' + safeName(t && t.number ? t.number : (t ? t.num : ''));
  }
  var same = photosOf(p.owner);
  var idx = same.indexOf(p) + 1;
  var type = (p.orig && p.orig.type) || 'image/jpeg';
  var ext = type.indexOf('png') >= 0 ? 'png' : (type.indexOf('heic') >= 0 ? 'heic' : 'jpg');
  return new File([p.orig], date + '_' + proj + '_' + part + '_' + idx + '.' + ext, { type: type });
}

// iPhone: share sheet → "שמור תמונה" saves to Photos. Android: download → appears in gallery (Downloads).
function savePhotosToPhone(list) {
  if (!list.length) { showToast('לא נבחרו תמונות'); return; }
  var files = list.map(photoFile);
  if (IS_IOS && canShareFiles(files)) {
    navigator.share({ files: files }).catch(function () {});
  } else {
    downloadFiles(files);
    showToast('⬇️ ' + files.length + ' תמונות נשמרו בטלפון (הורדות)');
  }
}

function canShareFiles(files) {
  try { return !!(navigator.canShare && navigator.share && navigator.canShare({ files: files })); }
  catch (e) { return false; }
}

function shareFiles(files, title) {
  if (!files.length) { showToast('לא נבחר שום דבר לשליחה'); return; }
  if (canShareFiles(files)) {
    navigator.share({ files: files, title: title || '' }).catch(function (e) {
      if (e && e.name !== 'AbortError') { console.error(e); showToast('השיתוף נכשל — נסה "הורד"'); }
    });
  } else {
    showToast('שיתוף ישיר לא נתמך כאן — הקבצים יורדו');
    downloadFiles(files);
  }
}

function downloadFiles(files) {
  files.forEach(function (f, i) {
    setTimeout(function () {
      var url = URL.createObjectURL(f);
      var a = document.createElement('a');
      a.href = url; a.download = f.name;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
    }, i * 350);
  });
}

// ─────────────────────────────────────────
// SUMMARY + SHARE (tab 3)
// ─────────────────────────────────────────
function buildSummary() {
  var el = $('summaryContent');
  el.innerHTML = '';
  var p = currentProject();
  var rows = [
    ['פרויקט', $('f_project').value || '—'],
    ['נמען', $('f_recipient').value || '—'],
    ['מטרת סיור', $('f_purpose').value || '—'],
    ['מפקח', $('f_inspector').value || '—'],
    ['עצים שנסקרו', trees.length + (p ? ' (מתוך ' + p.trees.length + ' מיוחדים)' : '')],
    ['תמונות', photos.length]
  ];
  rows.forEach(function (r) {
    var row = document.createElement('div');
    row.className = 'summary-row';
    row.innerHTML = '<span class="summary-label"></span><span class="summary-val"></span>';
    row.children[0].textContent = r[0];
    row.children[1].textContent = r[1];
    el.appendChild(row);
  });
}

function renderShareSection() {
  var grid = $('sharePhotoGrid');
  grid.innerHTML = '';
  $('shareReportRow').style.display = lastReport ? 'flex' : 'none';
  $('shareReportName').textContent = lastReport ? lastReport.filename + '.docx' : '';
  if (!photos.length) {
    grid.innerHTML = '<div class="pt-empty">אין תמונות בדוח</div>';
  }
  photos.forEach(function (p) {
    var lab = document.createElement('label');
    lab.className = 'share-item';
    var cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'share-cb'; cb.dataset.id = p.id;
    var img = document.createElement('img');
    img.src = rawDataUrl(p.small);
    var cap = document.createElement('span');
    cap.textContent = photoLabel(p);
    lab.appendChild(cb); lab.appendChild(img); lab.appendChild(cap);
    grid.appendChild(lab);
  });
  $('shareCard').style.display = (lastReport || photos.length) ? 'block' : 'none';
}

function selectedSharePhotos() {
  var ids = {};
  Array.prototype.forEach.call(document.querySelectorAll('.share-cb:checked'), function (cb) { ids[cb.dataset.id] = true; });
  return photos.filter(function (p) { return ids[p.id]; });
}
function toggleAllShare() {
  var cbs = document.querySelectorAll('.share-cb');
  var anyOff = Array.prototype.some.call(cbs, function (c) { return !c.checked; });
  Array.prototype.forEach.call(cbs, function (c) { c.checked = anyOff; });
}
function collectShareFiles() {
  var files = [];
  if (lastReport && $('shareIncludeReport').checked) files.push(reportFile());
  selectedSharePhotos().forEach(function (p) { files.push(photoFile(p)); });
  return files;
}
function doShare() { shareFiles(collectShareFiles(), lastReport ? lastReport.filename : 'דוח פיקוח'); }
function doDownloadSelected() {
  var f = collectShareFiles();
  if (!f.length) { showToast('לא נבחר שום דבר'); return; }
  downloadFiles(f);
}
function saveAllPhotos() { savePhotosToPhone(photos.slice()); }
function saveSelectedPhotos() { savePhotosToPhone(selectedSharePhotos()); }

function reportFile() {
  return new File([lastReport.blob], lastReport.filename + '.docx',
    { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

function newReport() {
  confirmDialog('להתחיל דוח חדש? כל הנתונים והתמונות של הדוח הנוכחי יימחקו מהאפליקציה (תמונות שכבר נשמרו בטלפון יישארו).', 'דוח חדש', function () {
    clearDraft();
    idbClear().catch(function () {}).then(function () { location.reload(); });
  });
}

// ─────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────
function openSettings() { $('settingsOverlay').classList.add('open'); updateStorageInfo(); }
function closeSettings() { $('settingsOverlay').classList.remove('open'); }
function handleOverlayClick(e) { if (e.target === $('settingsOverlay')) closeSettings(); }
function saveDefaultInspector() {
  var val = $('s_defaultInspector').value.trim();
  lsSet('defaultInspector', val);
  if (!$('f_inspector').value) $('f_inspector').value = val;
  showToast('ברירת המחדל נשמרה ✓');
}
function saveAutoSaveSetting() { lsSet('autoSavePhone', $('s_autoSave').checked ? '1' : '0'); }
function updateStorageInfo() {
  var el = $('storageInfo');
  if (!navigator.storage || !navigator.storage.estimate) { el.textContent = ''; return; }
  navigator.storage.estimate().then(function (e) {
    el.textContent = 'נפח בשימוש: ' + (e.usage / 1048576).toFixed(1) + ' MB · ' + photos.length + ' תמונות בדוח הנוכחי';
  });
}

window.addEventListener('beforeinstallprompt', function (e) {
  e.preventDefault();
  deferredInstall = e;
  $('installBtn').style.display = 'flex';
});
function installApp() {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  deferredInstall.userChoice.finally(function () { deferredInstall = null; $('installBtn').style.display = 'none'; });
}

// ─────────────────────────────────────────
// DIALOGS / TOAST
// ─────────────────────────────────────────
function showToast(msg) {
  var t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(function () { t.classList.remove('show'); }, 2600);
}

function confirmDialog(msg, okText, onOk) {
  var overlay = document.createElement('div');
  overlay.className = 'modal-bg';
  var box = document.createElement('div');
  box.className = 'modal-box';
  var body = document.createElement('div');
  body.className = 'modal-body';
  body.textContent = msg;
  var row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:10px;';
  var cancel = document.createElement('button');
  cancel.className = 'btn btn-outline'; cancel.style.flex = '1'; cancel.style.justifyContent = 'center';
  cancel.textContent = 'ביטול';
  cancel.onclick = function () { overlay.remove(); };
  var ok = document.createElement('button');
  ok.className = 'btn btn-danger'; ok.style.flex = '1'; ok.style.justifyContent = 'center';
  ok.textContent = okText || 'אישור';
  ok.onclick = function () { overlay.remove(); onOk(); };
  row.appendChild(cancel); row.appendChild(ok);
  box.appendChild(body); box.appendChild(row);
  overlay.appendChild(box);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

function showValidationAlert(msg) {
  var overlay = document.createElement('div');
  overlay.className = 'modal-bg';
  var box = document.createElement('div');
  box.className = 'modal-box';
  var title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = '⚠️ לא ניתן ליצור דוח';
  var body = document.createElement('div');
  body.className = 'modal-body';
  body.textContent = msg;
  var btn = document.createElement('button');
  btn.className = 'btn btn-primary btn-full';
  btn.textContent = 'הבנתי';
  btn.onclick = function () { overlay.remove(); };
  box.appendChild(title); box.appendChild(body); box.appendChild(btn);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

// ─────────────────────────────────────────
// WORD GENERATION (same layout as the original report)
// ─────────────────────────────────────────
var SAVE_BTN_HTML = null;

function resetSaveBtn() {
  var btn = $('saveBtn');
  btn.disabled = false;
  btn.innerHTML = SAVE_BTN_HTML;
}

function patchHeaderXml(xml) {
  xml = xml.replace(/<w:pPr>/g, '<w:pPr><w:jc w:val="right"/>');
  xml = xml.replace(/(<w:p[^>]*>)(?!<w:pPr>)/g, '$1<w:pPr><w:jc w:val="right"/></w:pPr>');
  return xml;
}
function patchStylesRtl(xml) {
  xml = xml.replace(/<w:pPr>/g, '<w:pPr><w:bidi/><w:jc w:val="right"/>');
  xml = xml.replace(/<w:rPr>/g, '<w:rPr><w:rtl/>');
  return xml;
}
function patchXmlRtl(xml) {
  xml = xml.replace(/<w:pPr>/g, '<w:pPr><w:bidi/><w:jc w:val="right"/>');
  xml = xml.replace(/(<w:p[ >][^]*?)(<w:r[ >]|<w:bookmarkStart|<\/w:p>)/g, function (m, before, after) {
    if (before.indexOf('<w:pPr>') >= 0) return m;
    return before + '<w:pPr><w:bidi/><w:jc w:val="right"/></w:pPr>' + after;
  });
  xml = xml.replace(/<w:rPr>/g, '<w:rPr><w:rtl/>');
  xml = xml.replace(/(<w:r>|<w:r )([^]*?)(<w:t[ >])/g, function (m, open, mid, t) {
    if (mid.indexOf('<w:rPr>') >= 0) return m;
    return open + mid + '<w:rPr><w:rtl/></w:rPr>' + t;
  });
  xml = xml.replace(/(<w:sectPr\b[^>]*>)/g, '$1<w:bidi/>');
  return xml;
}

function injectRtl(arrayBuf) {
  return JSZip.loadAsync(arrayBuf).then(function (zip) {
    var names = ['word/document.xml', 'word/header1.xml', 'word/styles.xml'];
    return Promise.all(names.map(function (name) {
      var file = zip.file(name);
      if (!file) return null;
      return file.async('string').then(function (xml) {
        var patched = name === 'word/styles.xml' ? patchStylesRtl(xml)
                    : name === 'word/header1.xml' ? patchHeaderXml(xml) : patchXmlRtl(xml);
        zip.file(name, patched);
      });
    })).then(function () {
      return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 },
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    });
  }).catch(function (e) {
    console.error('RTL patch error:', e);
    return new Blob([arrayBuf], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  });
}

function calcImgSize(dataUrl) {
  var natW = 900, natH = 1200, maxW, maxH;
  var sep = dataUrl.indexOf('|');
  if (sep > 0) {
    var dims = dataUrl.substring(0, sep).split('x');
    natW = parseInt(dims[0]) || 900; natH = parseInt(dims[1]) || 1200;
  }
  if (natW >= natH) { maxW = 480; maxH = 320; } else { maxW = 360; maxH = 480; }
  var ratio = Math.min(maxW / natW, maxH / natH);
  return { w: Math.round(natW * ratio), h: Math.round(natH * ratio) };
}
function rawDataUrl(dataUrl) {
  var sep = dataUrl.indexOf('|');
  return sep > 0 ? dataUrl.substring(sep + 1) : dataUrl;
}
function b64ToBytes(b64) {
  var bin = atob(b64), arr = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function generateReport() {
  if (typeof docx === 'undefined') { showToast('שגיאה: ספריית docx לא נטענה'); return; }
  var errors = [];
  if (!$('f_project').value.trim()) errors.push('שם פרויקט');
  if (!$('f_recipient').value.trim()) errors.push('נמען');
  if (!$('f_inspector').value.trim()) errors.push('שם מפקח');
  if (!$('f_purpose').value.trim()) errors.push('מטרת סיור');
  if (errors.length) { showValidationAlert('שדות חובה חסרים:\n• ' + errors.join('\n• ')); return; }

  var btn = $('saveBtn');
  if (!SAVE_BTN_HTML) SAVE_BTN_HTML = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'מייצר דוח...';
  setTimeout(function () {
    try {
      buildDocx().then(function (res) {
        lastReport = res;
        resetSaveBtn();
        renderShareSection();
        $('shareIncludeReport').checked = true;
        showToast('✅ הדוח מוכן — בחר מה לשלוח');
        $('shareCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }).catch(function (e) {
        console.error(e);
        showValidationAlert('שגיאה ביצירת הדוח: ' + (e.message || 'אנא נסה שוב'));
        resetSaveBtn();
      });
    } catch (e) {
      console.error(e);
      showValidationAlert('שגיאה ביצירת הדוח: ' + (e.message || 'אנא נסה שוב'));
      resetSaveBtn();
    }
  }, 60);
}

function parseMarkdownBullets(text) {
  var D = docx, paras = [];
  (text || '').split('\n').forEach(function (line) {
    var trimmed = line.trim();
    if (/^[•\-\*]/.test(trimmed)) {
      paras.push(new D.Paragraph({
        children: [new D.TextRun({ text: trimmed.replace(/^[•\-\*]\s*/, ''), font: 'David', size: 24, rightToLeft: true })],
        bullet: { level: 0 }, bidirectional: true, alignment: D.AlignmentType.RIGHT, style: 'Normal'
      }));
    } else if (trimmed) {
      paras.push(new D.Paragraph({
        children: [new D.TextRun({ text: trimmed, font: 'David', size: 24, rightToLeft: true })],
        bidirectional: true, alignment: D.AlignmentType.RIGHT, spacing: { after: 80 }
      }));
    } else {
      paras.push(new D.Paragraph({ children: [new D.TextRun({ text: '' })] }));
    }
  });
  return paras;
}

function buildDocx() {
  var D = docx;
  var date = $('f_date').value, project = $('f_project').value, recipient = $('f_recipient').value,
      company = $('f_company').value, purpose = $('f_purpose').value, inspector = $('f_inspector').value,
      notes = $('f_notes').value, instructions = $('f_instructions').value;
  var ccList = [$('f_cc1').value, $('f_cc2').value, $('f_cc3').value].filter(function (c) { return c && c.trim(); });
  var rawFilename = $('f_filename').value.trim();
  var filename = rawFilename || [date.replace(/\//g, ''), project.trim(), purpose.trim()].filter(Boolean).join('_');
  filename = filename.replace(/[\\\/:*?"<>|]+/g, '-');

  var logoBytes = b64ToBytes(LOGO_B64);
  var header = new D.Header({ children: [
    new D.Paragraph({ children: [new D.ImageRun({ data: logoBytes, type: 'png', transformation: { width: 240, height: 78 } })],
      alignment: D.AlignmentType.RIGHT, spacing: { before: 0, after: 40 } }),
    new D.Paragraph({ children: [new D.TextRun({ text: '' })],
      border: { bottom: { color: 'AAAAAA', style: D.BorderStyle.SINGLE, size: 12 } }, spacing: { before: 0, after: 100 } })
  ] });

  function rtlPara(text, opts) {
    opts = opts || {};
    return new D.Paragraph({
      children: [new D.TextRun({ text: text, font: 'David', size: opts.size || 24, bold: opts.bold || false,
                                 color: opts.color || '000000', rightToLeft: true })],
      alignment: D.AlignmentType.RIGHT, bidirectional: true,
      spacing: { after: opts.spaceAfter !== undefined ? opts.spaceAfter : 100 },
      rightTabStop: D.TabStopPosition.MAX
    });
  }
  function sectionTitle(text) {
    return new D.Paragraph({
      children: [new D.TextRun({ text: text, font: 'David', size: 28, bold: true, color: '1a3c2e', rightToLeft: true })],
      alignment: D.AlignmentType.RIGHT, bidirectional: true, spacing: { before: 200, after: 120 },
      border: { bottom: { color: 'AAAAAA', style: D.BorderStyle.SINGLE, size: 6 } }
    });
  }
  function blank() { return new D.Paragraph({ children: [new D.TextRun({ text: '' })] }); }
  function imagePara(small, after) {
    var sz = calcImgSize(small);
    return new D.Paragraph({
      children: [new D.ImageRun({ data: b64ToBytes(rawDataUrl(small).split(',')[1]), type: 'jpg',
                                  transformation: { width: sz.w, height: sz.h } })],
      alignment: D.AlignmentType.CENTER, spacing: { after: after }
    });
  }

  var children = [];
  children.push(rtlPara('לכבוד,'));
  children.push(rtlPara(recipient || '—', { bold: true }));
  if (company) children.push(rtlPara(company));
  children.push(blank());
  children.push(rtlPara('תאריך: ' + date, { size: 22, color: '555555' }));
  children.push(blank());
  children.push(new D.Paragraph({
    children: [new D.TextRun({ text: 'הנדון: ' + (purpose || '—'), font: 'David', size: 26, bold: true, rightToLeft: true })],
    alignment: D.AlignmentType.RIGHT, bidirectional: true, spacing: { after: 160 }
  }));
  if (project) children.push(rtlPara('פרויקט: ' + project));
  children.push(blank());

  if (notes && notes.trim()) {
    children.push(sectionTitle('הערות מהסיור'));
    parseMarkdownBullets(notes).forEach(function (p) { children.push(p); });
    children.push(blank());
  }
  var np = photosOf('notes');
  if (np.length) {
    children.push(sectionTitle('תמונות מהסיור'));
    np.forEach(function (p) {
      children.push(imagePara(p.small, p.caption ? 40 : 120));
      if (p.caption) children.push(new D.Paragraph({
        children: [new D.TextRun({ text: p.caption, font: 'David', size: 20, color: '555555', rightToLeft: true })],
        alignment: D.AlignmentType.CENTER, spacing: { after: 120 }
      }));
    });
  }
  if (instructions && instructions.trim()) {
    children.push(sectionTitle('הנחיות כלליות'));
    parseMarkdownBullets(instructions).forEach(function (p) { children.push(p); });
    children.push(blank());
  }
  children.push(blank());
  children.push(rtlPara('בכבוד רב,'));
  children.push(rtlPara(inspector || '—', { bold: true }));
  children.push(rtlPara('חנוך בורגר אגרונומים', { size: 22, color: '555555' }));
  children.push(blank());
  if (ccList.length) {
    children.push(sectionTitle('תפוצה'));
    ccList.forEach(function (cc) { children.push(rtlPara('• ' + cc, { size: 22 })); });
    children.push(blank());
  }
  if (trees.length) {
    children.push(new D.Paragraph({
      children: [new D.TextRun({ text: 'פירוט עצים שנסקרו', font: 'David', size: 32, bold: true, color: '1a3c2e', rightToLeft: true })],
      alignment: D.AlignmentType.RIGHT, bidirectional: true, spacing: { before: 300, after: 200 }
    }));
    trees.forEach(function (tree) {
      children.push(sectionTitle('עץ ' + tree.num + (tree.type ? ' — ' + tree.type : '')));
      var s = statusOf(tree.number);
      if (tree.number) children.push(rtlPara('עץ מספר: ' + tree.number + (s ? '  |  מיועד ל' + s : ''), { size: 22 }));
      if (tree.note) parseMarkdownBullets(tree.note).forEach(function (p) { children.push(p); });
      photosOf(tree.id).forEach(function (p) { children.push(imagePara(p.small, 120)); });
      children.push(blank());
    });
  }

  var doc = new D.Document({
    styles: { default: { document: {
      run: { font: 'David', size: 24, rightToLeft: true },
      paragraph: { alignment: D.AlignmentType.RIGHT, bidirectional: true }
    } } },
    sections: [{
      properties: { page: { margin: { top: 1800, bottom: 1440, right: 1134, left: 1134 } }, bidi: true },
      headers: { default: header },
      children: children
    }]
  });

  return D.Packer.toBlob(doc)
    .then(function (blob) { return blob.arrayBuffer(); })
    .then(injectRtl)
    .then(function (blob) { return { blob: blob, filename: filename }; });
}

// ─────────────────────────────────────────
// AUTOSAVE — text in localStorage, photos in IndexedDB
// ─────────────────────────────────────────
var AUTOSAVE_KEY = 'agro_report_draft';
var FORM_FIELDS = ['f_project', 'f_recipient', 'f_company', 'f_purpose', 'f_inspector',
                   'f_notes', 'f_instructions', 'f_cc1', 'f_cc2', 'f_cc3', 'f_filename'];
var autosaveTimer = null;

function collectFormData() {
  var d = {};
  FORM_FIELDS.forEach(function (id) { d[id] = $(id).value; });
  d.trees_meta = trees.map(function (t) { return { id: t.id, num: t.num, type: t.type, number: t.number, note: t.note }; });
  return d;
}
function scheduleSave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(function () { lsSet(AUTOSAVE_KEY, JSON.stringify(collectFormData())); }, 600);
}
function restoreDraft(data) {
  FORM_FIELDS.forEach(function (id) { if (data[id] !== undefined && $(id)) $(id).value = data[id]; });
  syncProjectSelFromText();
  (data.trees_meta || []).forEach(function (meta) {
    var tree = { id: meta.id, num: meta.num, type: meta.type, number: meta.number, note: meta.note };
    trees.push(tree);
    treeCounter = Math.max(treeCounter, meta.num);
    renderTree(tree);
  });
}
function clearDraft() { try { localStorage.removeItem(AUTOSAVE_KEY); } catch (e) {} }
function attachAutosaveListeners() {
  FORM_FIELDS.forEach(function (id) { var el = $(id); if (el) el.addEventListener('input', scheduleSave); });
  $('f_project').addEventListener('input', function () { renderProjectTrees(); trees.forEach(updateTreeStatusBadge); });
  // Save immediately when the app goes to background
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') lsSet(AUTOSAVE_KEY, JSON.stringify(collectFormData()));
  });
}

// ─────────────────────────────────────────
// START
// ─────────────────────────────────────────
(function setAppTime() {
  var now = new Date();
  var title = 'AGRO REPORT ' + String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
  $('appTitle').textContent = title;
  document.title = title;
})();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); });
}

init();

// Hooks used by the notes-photo inputs in index.html
function triggerPhoto(id) { $(id).click(); }
function handleNotesPhotos(event) { handlePhotos(event, 'notes', event.target.id === 'notesCamera'); }
