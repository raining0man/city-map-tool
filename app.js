import { initializeApp } from "https://www.gstatic.com/firebasejs/13.2.0/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/13.2.0/firebase-auth.js";
import { getFirestore, doc, onSnapshot, setDoc, deleteDoc, getDoc }
  from "https://www.gstatic.com/firebasejs/13.2.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCI0se4wikT8jZIB_-j1w_Z2_N8iIrWs_s",
  authDomain: "city-map-tool.firebaseapp.com",
  projectId: "city-map-tool",
  storageBucket: "city-map-tool.firebasestorage.app",
  messagingSenderId: "359301791775",
  appId: "1:359301791775:web:662240ce3ada96791c552a"
};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let isSaving = false;
let isReady = false;
let mainData = null;
let activeMap = null;
let subscribedMapId = null;
let mainUnsub = null;
let mapUnsub = null;
let editingMarkerId = null;
let pendingCoords = null;
let markerColor = '#e74c3c';

let leafletMap = null;
let leafletMarkers = [];

let visibleTypes = new Set();
let knownTypes = new Set();
let currentActiveMapId = null;

const LS_MAIN = 'mapTool:main';
const LS_MAP  = id => `mapTool:map:${id}`;
const COLORS = ['#e74c3c','#3498db','#2ecc71','#f1c40f','#9b59b6','#e67e22','#1abc9c','#34495e'];
const SPB_LAT = 59.9343;
const SPB_LNG = 30.3351;
const SPB_ZOOM = 12;

function uid(prefix) { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toast(msg, type='info') {
  const c = document.getElementById('toast-container');
  if (!c) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  c.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2600);
}
function setSyncStatus(s) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  el.className = 'sync-status ' + s;
  el.title = { online: 'Синхронизировано', offline: 'Локально (нет сети)', saving: 'Сохранение...', error: 'Ошибка синхронизации' }[s] || '';
}

function cacheMain(d) { try { localStorage.setItem(LS_MAIN, JSON.stringify(d)); } catch(e){} }
function cacheMap(id, d) { try { localStorage.setItem(LS_MAP(id), JSON.stringify(d)); } catch(e){} }
function readCacheMain() { try { const s = localStorage.getItem(LS_MAIN); return s ? JSON.parse(s) : null; } catch(e){ return null; } }
function readCacheMap(id) { try { const s = localStorage.getItem(LS_MAP(id)); return s ? JSON.parse(s) : null; } catch(e){ return null; } }

async function boot() {
  // 1. Мгновенный показ из кэша
  const cached = readCacheMain();
  if (cached) {
    mainData = cached; renderMain();
    if (cached.activeMapId) {
      const cm = readCacheMap(cached.activeMapId);
      if (cm) { activeMap = cm; subscribedMapId = cached.activeMapId; renderMap(); }
    }
  }
  
  setSyncStatus('offline');

  // 2. Слушаем авторизацию. Как только вошли — подключаемся к Firebase.
  onAuthStateChanged(auth, user => {
    if (user) {
      subscribeMain();
      // КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: Если карта была загружена из кэша, принудительно подписываемся на нее в Firebase
      if (subscribedMapId) {
        subscribeMap(subscribedMapId);
      }
    } else {
      signInAnonymously(auth).catch(e => {
        console.error('Auth failed:', e);
        toast('Ошибка авторизации Firebase. Проверьте интернет или отключите AdBlock.', 'error');
      });
    }
  });

  // Аварийный таймаут
  setTimeout(() => { if (!isReady) { isReady = true; setSyncStatus('offline'); } }, 15000);
}

function subscribeMain() {
  if (mainUnsub) mainUnsub();
  mainUnsub = onSnapshot(doc(db, 'data', 'main'), snap => {
    const data = snap.data();
    if (!data) { if (!isReady) { isReady = true; setSyncStatus('online'); } return; }
    
    mainData = data; 
    cacheMain(data); 
    isReady = true; 
    setSyncStatus('online'); 
    renderMain();
    
    if (data.activeMapId !== subscribedMapId) {
      if (data.activeMapId) subscribeMap(data.activeMapId);
      else { activeMap = null; subscribedMapId = null; renderMap(); }
    }
  }, err => { 
    console.error('Main sync error:', err); 
    setSyncStatus('error'); 
    if (!isReady) isReady = true; 
  });
}

function subscribeMap(mapId) {
  if (mapUnsub) { mapUnsub(); mapUnsub = null; }
  subscribedMapId = mapId;
  mapUnsub = onSnapshot(doc(db, 'maps', mapId), snap => {
    const data = snap.data();
    if (!data) return;
    
    activeMap = data; 
    cacheMap(mapId, data); 
    renderMap();
  }, err => { 
    console.error('Map sync error:', err); 
    setSyncStatus('error'); 
  });
}

async function saveMain(patch) {
  if (!isReady) { toast('Синхронизация ещё не готова', 'error'); return false; }
  const base = mainData || { version: 0, maps: [], activeMapId: null };
  const next = { ...base, ...patch, version: (base.version || 0) + 1, updatedAt: Date.now() };
  
  setSyncStatus('saving');
  try {
    await setDoc(doc(db, 'data', 'main'), next);
    mainData = next; cacheMain(next); setSyncStatus('online'); return true;
  } catch (e) { 
    console.error(e); setSyncStatus('error'); toast('Ошибка сохранения', 'error'); return false; 
  }
}

async function saveMap(mapId, patch) {
  if (!isReady) { toast('Синхронизация ещё не готова', 'error'); return false; }
  
  let base = activeMap;
  try {
    // Читаем самую свежую версию карты из базы перед сохранением (защита от затирания чужих меток)
    const snap = await getDoc(doc(db, 'maps', mapId));
    if (snap.exists()) base = snap.data();
  } catch(e) { console.warn("Не удалось прочитать свежие данные, сохраняем локальные", e); }

  if (!base) base = { id: mapId, version: 0, markers: [], markerTypes: [] };
  const next = { ...base, ...patch, id: mapId, version: (base.version || 0) + 1, updatedAt: Date.now() };
  
  setSyncStatus('saving');
  try {
    await setDoc(doc(db, 'maps', mapId), next);
    activeMap = next; cacheMap(mapId, next); setSyncStatus('online'); return true;
  } catch (e) { 
    console.error(e); setSyncStatus('error'); toast('Ошибка сохранения карты', 'error'); return false; 
  }
}

function renderMain() {
  const vb = document.getElementById('version-badge');
  if (vb) vb.textContent = 'v' + (mainData?.version || 0);
  const sel = document.getElementById('map-select');
  if (sel) {
    const maps = mainData?.maps || [];
    sel.innerHTML = maps.length ? maps.map(m => `<option value="${esc(m.id)}"${m.id === mainData.activeMapId ? ' selected' : ''}>${esc(m.name)}${m.type === 'osm' ? ' 🌐' : ''}</option>`).join('') : '<option value="">— нет карт —</option>';
  }
  const btnDel = document.getElementById('btn-delete-map');
  if (btnDel) btnDel.disabled = !mainData?.activeMapId;
}

function renderMap() {
  const emptyEl = document.getElementById('empty-state');
  const vpEl = document.getElementById('map-viewport');
  const leafletEl = document.getElementById('leaflet-map');
  if (!emptyEl || !vpEl || !leafletEl) return;

  if (!activeMap) {
    emptyEl.hidden = false; vpEl.hidden = true; leafletEl.hidden = true;
    renderMarkers(); return;
  }

  if (activeMap.id !== currentActiveMapId) {
    currentActiveMapId = activeMap.id;
    visibleTypes.clear();
    visibleTypes.add('');
    knownTypes.clear();
    if (!activeMap.markerTypes) activeMap.markerTypes = [];
    activeMap.markerTypes.forEach(t => { visibleTypes.add(t.id); knownTypes.add(t.id); });
  } else {
    if (!activeMap.markerTypes) activeMap.markerTypes = [];
    activeMap.markerTypes.forEach(t => {
      if (!knownTypes.has(t.id)) { knownTypes.add(t.id); visibleTypes.add(t.id); }
    });
  }

  emptyEl.hidden = true;
  
  if (activeMap.type === 'osm') {
    vpEl.hidden = true; leafletEl.hidden = false;
    initLeafletMap(); renderFilters(); renderLeafletMarkers(); renderMarkerList();
  } else {
    leafletEl.hidden = true; vpEl.hidden = false;
    const img = document.getElementById('map-image');
    if (img && img.src !== activeMap.image) img.src = activeMap.image;
    renderFilters(); renderMarkers();
  }
}

function renderFilters() {
  const container = document.getElementById('marker-filters');
  if (!container || !activeMap) return;
  if (!activeMap.markerTypes) activeMap.markerTypes = [];
  
  let html = `<label class="filter-label"><input type="checkbox" data-id="" ${visibleTypes.has('') ? 'checked' : ''}> Без типа</label>`;
  activeMap.markerTypes.forEach(t => {
    html += `<label class="filter-label"><input type="checkbox" data-id="${esc(t.id)}" ${visibleTypes.has(t.id) ? 'checked' : ''}> ${esc(t.name)}</label>`;
  });
  container.innerHTML = html;

  container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', e => {
      if (e.target.checked) visibleTypes.add(e.target.dataset.id);
      else visibleTypes.delete(e.target.dataset.id);
      if (activeMap.type === 'osm') renderLeafletMarkers(); else renderMarkers();
      renderMarkerList();
    });
  });
}

function renderTypesList() {
  const list = document.getElementById('types-list');
  if (!list || !activeMap) return;
  if (!activeMap.markerTypes) activeMap.markerTypes = [];

  if (!activeMap.markerTypes.length) {
    list.innerHTML = '<div class="hint">Нет добавленных типов</div>';
    return;
  }

  list.innerHTML = activeMap.markerTypes.map(t => `
    <div style="display:flex; justify-content:space-between; align-items:center; background:var(--bg-3); padding:8px 12px; border-radius:8px;">
      <span>${esc(t.name)}</span>
      <button class="icon-btn danger" data-id="${esc(t.id)}" title="Удалить">✕</button>
    </div>
  `).join('');

  list.querySelectorAll('button[data-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      if (!confirm('Удалить тип? У меток этого типа сбросится тип.')) return;
      const newTypes = activeMap.markerTypes.filter(t => t.id !== id);
      const newMarkers = (activeMap.markers || []).map(m => m.typeId === id ? { ...m, typeId: '' } : m);
      if (await saveMap(activeMap.id, { markerTypes: newTypes, markers: newMarkers })) {
        visibleTypes.delete(id); renderTypesList(); renderMap(); toast('Тип удален', 'success');
      }
    });
  });
}

function initLeafletMap() {
  if (typeof L === 'undefined') return;
  if (leafletMap) { leafletMap.remove(); leafletMap = null; }
  const div = document.getElementById('leaflet-map');
  if (!div) return;
  div.innerHTML = '';
  leafletMap = L.map(div).setView([SPB_LAT, SPB_LNG], SPB_ZOOM);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(leafletMap);
  leafletMap.on('click', e => { if (activeMap) openMarkerDialog(null, { lat: e.latlng.lat, lng: e.latlng.lng }); });
}

function renderLeafletMarkers() {
  if (!leafletMap || !activeMap) return;
  leafletMarkers.forEach(m => m.remove());
  leafletMarkers = [];
  const markers = (activeMap.markers || []).filter(m => visibleTypes.has(m.typeId || ''));
  markers.forEach((m, i) => {
    const icon = L.divIcon({
      className: 'leaflet-marker-custom',
      html: `<div style="background:${m.color || '#e74c3c'};width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:12px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.5)">${i+1}</div>`,
      iconSize: [26, 26], iconAnchor: [13, 13]
    });
    const lm = L.marker([m.lat, m.lng], { icon }).addTo(leafletMap);
    lm.on('click', () => openMarkerDialog(m.id));
    leafletMarkers.push(lm);
  });
}

function renderMarkers() {
  const layer = document.getElementById('markers-layer');
  if (layer) {
    layer.innerHTML = '';
    if (activeMap && activeMap.type !== 'osm') {
      const markers = (activeMap.markers || []).filter(m => visibleTypes.has(m.typeId || ''));
      markers.forEach((m, i) => {
        const el = document.createElement('div');
        el.className = 'marker';
        el.dataset.id = m.id;
        el.style.left = (m.x * 100) + '%';
        el.style.top = (m.y * 100) + '%';
        el.style.background = m.color || '#e74c3c';
        el.innerHTML = `<span class="marker-num">${i + 1}</span>`;
        el.title = m.comment || '';
        el.addEventListener('click', e => { e.stopPropagation(); openMarkerDialog(m.id); });
        layer.appendChild(el);
      });
    }
  }
  renderMarkerList();
}

function renderMarkerList() {
  const list = document.getElementById('markers-list');
  const countEl = document.getElementById('marker-count');
  const allMarkers = activeMap?.markers || [];
  const markers = allMarkers.filter(m => visibleTypes.has(m.typeId || ''));

  if (countEl) countEl.textContent = markers.length;
  if (!list) return;
  if (!markers.length) { list.innerHTML = '<div class="empty-hint">Нет меток для отображения</div>'; return; }

  list.innerHTML = markers.map((m, i) => {
    const typeObj = activeMap.markerTypes?.find(t => t.id === m.typeId);
    const typeHtml = typeObj ? `<div class="marker-type-badge">${esc(typeObj.name)}</div>` : '';
    return `
    <div class="marker-item" data-id="${esc(m.id)}">
      <div class="marker-badge" style="background:${esc(m.color || '#e74c3c')}">${i + 1}</div>
      <div class="marker-body">
        ${typeHtml}
        <div class="marker-comment">${m.comment ? esc(m.comment) : '<span class="muted">Без комментария</span>'}</div>
      </div>
      <div class="marker-actions">
        <button class="icon-btn" data-act="edit" title="Изменить">✎</button>
        <button class="icon-btn danger" data-act="del" title="Удалить">✕</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.marker-item').forEach(item => {
    const id = item.dataset.id;
    item.querySelector('[data-act="edit"]').addEventListener('click', e => { e.stopPropagation(); openMarkerDialog(id); });
    item.querySelector('[data-act="del"]').addEventListener('click', e => { e.stopPropagation(); deleteMarker(id); });
    item.addEventListener('click', () => {
      const marker = activeMap?.markers.find(m => m.id === id);
      if (marker && activeMap.type === 'osm' && leafletMap) leafletMap.setView([marker.lat, marker.lng], 15);
    });
  });
}

function openMarkerDialog(markerId, coords = null) {
  editingMarkerId = markerId;
  pendingCoords = coords;
  const dlg = document.getElementById('dialog-marker');
  const ta = document.getElementById('marker-comment');
  const typeSelect = document.getElementById('marker-type');
  const titleEl = document.getElementById('marker-title');
  const colorsEl = document.getElementById('marker-colors');
  const delBtn = document.getElementById('marker-delete');
  if (!dlg || !ta || !typeSelect || !titleEl || !colorsEl || !delBtn) return;

  typeSelect.innerHTML = '<option value="">— Без типа —</option>' + 
    (activeMap.markerTypes || []).map(t => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  colorsEl.innerHTML = COLORS.map(c => `<button type="button" class="color-dot" data-color="${c}" style="background:${c}"></button>`).join('');

  if (markerId) {
    const m = (activeMap?.markers || []).find(x => x.id === markerId);
    if (!m) return;
    ta.value = m.comment || ''; typeSelect.value = m.typeId || '';
    markerColor = m.color || '#e74c3c';
    titleEl.textContent = 'Редактировать метку'; delBtn.hidden = false;
  } else {
    ta.value = ''; typeSelect.value = ''; markerColor = COLORS[0];
    titleEl.textContent = 'Новая метка'; delBtn.hidden = true;
  }

  colorsEl.querySelectorAll('.color-dot').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.color === markerColor);
    btn.addEventListener('click', () => {
      markerColor = btn.dataset.color;
      colorsEl.querySelectorAll('.color-dot').forEach(b => b.classList.toggle('active', b.dataset.color === markerColor));
    });
  });

  dlg.showModal();
  setTimeout(() => ta.focus(), 50);
}

async function saveMarker() {
  const comment = document.getElementById('marker-comment').value.trim();
  const typeId = document.getElementById('marker-type').value;
  const markers = [...(activeMap?.markers || [])];

  if (editingMarkerId) {
    const idx = markers.findIndex(m => m.id === editingMarkerId);
    if (idx >= 0) markers[idx] = { ...markers[idx], comment, color: markerColor, typeId };
  } else if (pendingCoords) {
    const newMarker = { id: uid('m'), comment, color: markerColor, typeId, createdAt: Date.now() };
    if (activeMap.type === 'osm') { newMarker.lat = pendingCoords.lat; newMarker.lng = pendingCoords.lng; } 
    else { newMarker.x = pendingCoords.x; newMarker.y = pendingCoords.y; }
    markers.push(newMarker);
  }
  
  document.getElementById('dialog-marker').close();
  editingMarkerId = null; pendingCoords = null;

  if (await saveMap(activeMap.id, { markers })) toast('Сохранено', 'success');
}

async function deleteMarker(id) {
  if (!confirm('Удалить метку?')) return;
  const markers = (activeMap?.markers || []).filter(m => m.id !== id);
  if (await saveMap(activeMap.id, { markers })) toast('Метка удалена', 'success');
}

async function handleUpload(e) {
  e.preventDefault();
  const name = document.getElementById('upload-name').value.trim();
  const mapType = document.querySelector('input[name="map-type"]:checked').value;
  if (!name) { toast('Введите название', 'error'); return; }

  const mapId = uid('map');
  const now = Date.now();
  let mapDoc = { id: mapId, name, type: mapType, markers: [], markerTypes: [], version: 1, updatedAt: now };

  if (mapType === 'image') {
    const file = document.getElementById('upload-file').files[0];
    if (!file) { toast('Выберите изображение', 'error'); return; }
    toast('Сжимаем изображение...');
    try {
      const { dataUrl, width, height } = await compressImage(file);
      mapDoc.image = dataUrl; mapDoc.imageWidth = width; mapDoc.imageHeight = height;
    } catch (err) { console.error(err); toast('Ошибка: ' + err.message, 'error'); return; }
  } else {
    mapDoc.center = { lat: SPB_LAT, lng: SPB_LNG }; mapDoc.zoom = SPB_ZOOM;
  }

  isSaving = true; setSyncStatus('saving');
  try {
    await setDoc(doc(db, 'maps', mapId), mapDoc);
    const maps = [...(mainData?.maps || []), { id: mapId, name, type: mapType, createdAt: now, updatedAt: now }];
    await saveMain({ maps, activeMapId: mapId });
    activeMap = mapDoc; cacheMap(mapId, mapDoc); subscribeMap(mapId); renderMain(); renderMap();
    document.getElementById('upload-form').reset(); document.getElementById('dialog-upload').close();
    toast('Карта создана', 'success');
  } catch (err) { console.error(err); toast('Ошибка: ' + err.message, 'error'); } 
  finally { isSaving = false; }
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const MAX = 2000; let w = img.width, h = img.height;
        if (w > MAX || h > MAX) { if (w > h) { h = Math.round(h * MAX / w); w = MAX; } else { w = Math.round(w * MAX / h); h = MAX; } }
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        let q = 0.82; let dataUrl = cv.toDataURL('image/jpeg', q);
        while (dataUrl.length > 700_000 && q > 0.35) { q -= 0.08; dataUrl = cv.toDataURL('image/jpeg', q); }
        resolve({ dataUrl, width: w, height: h });
      };
      img.onerror = () => reject(new Error('Ошибка чтения'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('Ошибка файла')); reader.readAsDataURL(file);
  });
}

async function deleteActiveMap() {
  const id = mainData?.activeMapId;
  if (!id || !confirm('Удалить карту со всеми метками?')) return;
  try {
    isSaving = true; await deleteDoc(doc(db, 'maps', id)); isSaving = false;
    if (mapUnsub) { mapUnsub(); mapUnsub = null; }
    subscribedMapId = null; activeMap = null;
    if (leafletMap) { leafletMap.remove(); leafletMap = null; }
    localStorage.removeItem(LS_MAP(id));
    const maps = (mainData.maps || []).filter(m => m.id !== id);
    const newActive = maps[0]?.id || null;
    await saveMain({ maps, activeMapId: newActive });
    if (newActive) subscribeMap(newActive);
    renderMap(); renderMain(); toast('Карта удалена', 'success');
  } catch (e) { isSaving = false; console.error(e); toast('Ошибка удаления', 'error'); }
}

function switchMap(id) {
  if (!id || id === mainData?.activeMapId) return;
  saveMain({ activeMapId: id });
  const cached = readCacheMap(id);
  if (cached) { activeMap = cached; renderMap(); }
  subscribeMap(id);
}

function bindEvents() {
  const on = (id, ev, fn) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); };

  on('map-image', 'click', (e) => {
    if (!activeMap || activeMap.type === 'osm') return;
    const img = document.getElementById('map-image'); const r = img.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width; const y = (e.clientY - r.top) / r.height;
    if (x >= 0 && x <= 1 && y >= 0 && y <= 1) openMarkerDialog(null, { x, y });
  });

  on('btn-upload', 'click', () => {
    const form = document.getElementById('upload-form');
    const fileInp = document.getElementById('upload-file');
    const fileFld = document.getElementById('file-field');
    if (form) form.reset(); if (fileInp) fileInp.required = true;
    if (fileFld) fileFld.style.display = 'flex';
    const dlg = document.getElementById('dialog-upload'); if (dlg) dlg.showModal();
  });

  document.querySelectorAll('input[name="map-type"]').forEach(radio => {
    radio.addEventListener('change', e => {
      const isImage = e.target.value === 'image';
      const fileFld = document.getElementById('file-field');
      const fileInp = document.getElementById('upload-file');
      if (fileFld) fileFld.style.display = isImage ? 'flex' : 'none';
      if (fileInp) fileInp.required = isImage;
    });
  });

  on('upload-cancel', 'click', () => document.getElementById('dialog-upload')?.close());
  on('upload-form', 'submit', handleUpload);
  on('map-select', 'change', e => switchMap(e.target.value));
  on('btn-delete-map', 'click', deleteActiveMap);

  on('marker-form', 'submit', e => { e.preventDefault(); saveMarker(); });
  on('marker-cancel', 'click', () => {
    document.getElementById('dialog-marker')?.close(); editingMarkerId = null; pendingCoords = null;
  });
  on('marker-delete', 'click', () => {
    const id = editingMarkerId; document.getElementById('dialog-marker')?.close(); editingMarkerId = null;
    if (id) deleteMarker(id);
  });

  on('btn-clear-markers', 'click', async () => {
    if (!activeMap?.markers?.length) return;
    if (!confirm('Удалить все метки на этой карте?')) return;
    if (await saveMap(activeMap.id, { markers: [] })) toast('Метки очищены', 'success');
  });

  on('btn-menu', 'click', () => document.getElementById('dialog-menu')?.showModal());
  on('btn-close-menu', 'click', () => document.getElementById('dialog-menu')?.close());
  on('btn-manage-types', 'click', () => {
    document.getElementById('dialog-menu')?.close(); renderTypesList(); document.getElementById('dialog-types')?.showModal();
  });
  on('btn-close-types', 'click', () => document.getElementById('dialog-types')?.close());

  on('btn-add-type', 'click', async () => {
    const input = document.getElementById('new-type-name');
    if (!input) return;
    const name = input.value.trim(); if (!name) return;
    
    const newType = { id: uid('t'), name };
    const newTypes = [...(activeMap.markerTypes || []), newType];
    
    if (await saveMap(activeMap.id, { markerTypes: newTypes })) {
      input.value = ''; visibleTypes.add(newType.id); knownTypes.add(newType.id);
      renderTypesList(); renderMap(); toast('Тип добавлен', 'success');
    }
  });

  on('btn-export', 'click', () => {
    const payload = { main: mainData, maps: {} };
    for (const m of (mainData?.maps || [])) { const c = readCacheMap(m.id); if (c) payload.maps[m.id] = c; }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = `city-map-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(url); toast('Экспорт готов', 'success');
    document.getElementById('dialog-menu')?.close();
  });

  on('btn-import', 'click', () => document.getElementById('import-file')?.click());
  on('import-file', 'change', async e => {
    const f = e.target.files[0];
    if (f) {
      try {
        const data = JSON.parse(await f.text());
        if (!data.main || !data.maps) throw new Error('Неверный формат файла');
        if (!confirm('Импорт заменит текущие данные. Продолжить?')) return;
        isSaving = true;
        for (const [id, mapDoc] of Object.entries(data.maps)) { await setDoc(doc(db, 'maps', id), mapDoc); cacheMap(id, mapDoc); }
        await setDoc(doc(db, 'data', 'main'), data.main); isSaving = false;
        mainData = data.main; cacheMain(mainData); renderMain();
        if (mainData.activeMapId) subscribeMap(mainData.activeMapId);
        toast('Импорт завершён', 'success');
      } catch (e) { isSaving = false; console.error(e); toast('Ошибка: ' + e.message, 'error'); }
    }
    e.target.value = ''; document.getElementById('dialog-menu')?.close();
  });

  window.addEventListener('online', () => { if (isReady) setSyncStatus('online'); });
  window.addEventListener('offline', () => setSyncStatus('offline'));
}

bindEvents();
boot();
