// DS9 HTTP — browser-side UI logic
'use strict';

const $  = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const State = {
  meta: null,            // /api/state payload
  imgEl: null,           // HTMLImageElement of current PNG
  viewZoom: 1,           // browser-side zoom multiplier
  panX: 0, panY: 0,      // image-space center point shown on canvas
  rotate: 0,             // degrees
  mode: 'region',        // edit mode
  regionShape: 'circle', // current region shape
  panels: { info: true, panner: true, magnifier: true, colorbar: true, buttons: true },
  wcsSystem: 'fk5',      // fk5 / icrs / galactic
  wcsFormat: 'sex',      // sex / deg
  dragging: null,        // {x,y,panX,panY}
  lastPixel: null,
};

async function api(path, opts={}) {
  const res = await fetch(path, Object.assign({
    headers: { 'Content-Type': 'application/json' },
  }, opts));
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  const ct = res.headers.get('Content-Type') || '';
  return ct.includes('application/json') ? res.json() : res.blob();
}

async function getState() {
  State.meta = await api('/api/state');
  return State.meta;
}
async function postJSON(path, body) {
  return api(path, { method: 'POST', body: JSON.stringify(body) });
}

// ---------- image loading ----------

async function reloadImage() {
  if (!State.meta || !State.meta.width) return;
  const url = '/api/image?t=' + Date.now();
  const img = new Image();
  img.onload = () => { State.imgEl = img; draw(); drawPanner(); drawColorbar(); };
  img.onerror = () => setStatus('Failed to load image');
  img.src = url;
}

function setStatus(msg) { $('#status-left').textContent = msg; }

// ---------- canvas sizing ----------

function resizeCanvases() {
  const vw = $('#viewer');
  const main = $('#maincanvas');
  const ov = $('#overlay');
  const dpr = window.devicePixelRatio || 1;
  const w = vw.clientWidth, h = vw.clientHeight;
  for (const c of [main, ov]) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.style.width = w + 'px';
    c.style.height = h + 'px';
  }
  main.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  ov.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ---------- main draw ----------

function imageToCanvas() {
  // Returns transform: maps image (ix,iy) to canvas (cx,cy).
  const main = $('#maincanvas');
  const cw = main.clientWidth, ch = main.clientHeight;
  const iw = State.meta.width, ih = State.meta.height;
  const zoom = State.viewZoom;
  const panX = State.panX ?? iw / 2;
  const panY = State.panY ?? ih / 2;
  // Image is rendered server-side with Y-flip (FITS convention). So the PNG
  // already has y=0 at top for row (ih-1). To map image coord (ix,iy) to
  // PNG coord, use (ix, ih - 1 - iy).
  return { cw, ch, iw, ih, zoom, panX, panY };
}

function draw() {
  const main = $('#maincanvas');
  const ctx = main.getContext('2d');
  const { cw, ch, iw, ih, zoom, panX, panY } = imageToCanvas();
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cw, ch);
  if (!State.imgEl) return;

  ctx.save();
  ctx.translate(cw / 2, ch / 2);
  ctx.rotate((State.rotate * Math.PI) / 180);
  ctx.scale(zoom, zoom);
  // PNG pixel (panX, ih-1-panY) should be at origin.
  ctx.translate(-panX, -(ih - 1 - panY));
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(State.imgEl, 0, 0);
  ctx.restore();

  drawOverlay();
}

function drawOverlay() {
  const ov = $('#overlay');
  const ctx = ov.getContext('2d');
  ctx.clearRect(0, 0, ov.clientWidth, ov.clientHeight);
  if (!State.meta) return;
  const regs = State.meta.regions || [];
  for (const r of regs) drawRegion(ctx, r);
}

function imageToScreen(ix, iy) {
  const { cw, ch, iw, ih, zoom, panX, panY } = imageToCanvas();
  // invert Y for PNG convention
  const px = ix, py = ih - 1 - iy;
  const rad = (State.rotate * Math.PI) / 180;
  const dx = (px - panX) * zoom;
  const dy = (py - (ih - 1 - panY)) * zoom;
  const sx = cw / 2 + (dx * Math.cos(rad) - dy * Math.sin(rad));
  const sy = ch / 2 + (dx * Math.sin(rad) + dy * Math.cos(rad));
  return [sx, sy];
}

function screenToImage(sx, sy) {
  const { cw, ch, iw, ih, zoom, panX, panY } = imageToCanvas();
  const rad = (-State.rotate * Math.PI) / 180;
  const tx = sx - cw / 2, ty = sy - ch / 2;
  const dx = tx * Math.cos(rad) - ty * Math.sin(rad);
  const dy = tx * Math.sin(rad) + ty * Math.cos(rad);
  const px = dx / zoom + panX;
  const py = dy / zoom + (ih - 1 - panY);
  return [px, ih - 1 - py];
}

function drawRegion(ctx, r) {
  ctx.save();
  ctx.strokeStyle = r.color || '#7fff7f';
  ctx.lineWidth = 1.5;
  if (r.shape === 'circle') {
    const [cx, cy] = imageToScreen(r.x, r.y);
    const rpx = r.radius * State.viewZoom;
    ctx.beginPath(); ctx.arc(cx, cy, rpx, 0, 2 * Math.PI); ctx.stroke();
  } else if (r.shape === 'box') {
    const [cx, cy] = imageToScreen(r.x, r.y);
    const w = r.w * State.viewZoom, h = r.h * State.viewZoom;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((State.rotate * Math.PI) / 180);
    ctx.strokeRect(-w/2, -h/2, w, h);
    ctx.restore();
  } else if (r.shape === 'point') {
    const [cx, cy] = imageToScreen(r.x, r.y);
    ctx.beginPath();
    ctx.moveTo(cx - 5, cy); ctx.lineTo(cx + 5, cy);
    ctx.moveTo(cx, cy - 5); ctx.lineTo(cx, cy + 5);
    ctx.stroke();
  }
  if (r.label) {
    const [lx, ly] = imageToScreen(r.x, r.y);
    ctx.fillStyle = r.color || '#7fff7f';
    ctx.font = '11px monospace';
    ctx.fillText(r.label, lx + 6, ly - 6);
  }
  ctx.restore();
}

// ---------- panner & magnifier & colorbar ----------

function drawPanner() {
  const c = $('#panner');
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  if (!State.imgEl || !State.meta.width) return;
  const iw = State.meta.width, ih = State.meta.height;
  const scale = Math.min(c.width / iw, c.height / ih);
  const dw = iw * scale, dh = ih * scale;
  const ox = (c.width - dw) / 2, oy = (c.height - dh) / 2;
  ctx.drawImage(State.imgEl, ox, oy, dw, dh);
  // viewport indicator
  const main = $('#maincanvas');
  const vw = (main.clientWidth / State.viewZoom);
  const vh = (main.clientHeight / State.viewZoom);
  const px = ox + State.panX * scale - (vw * scale) / 2;
  const py = oy + (ih - 1 - State.panY) * scale - (vh * scale) / 2;
  ctx.strokeStyle = '#7fff7f';
  ctx.lineWidth = 1;
  ctx.strokeRect(px, py, vw * scale, vh * scale);
}

function drawMagnifier(ix, iy) {
  const c = $('#magnifier');
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, c.width, c.height);
  if (!State.imgEl || !State.meta) return;
  const ih = State.meta.height;
  const src = 16; // source pixels to show
  const sx = Math.max(0, Math.min(State.meta.width - src, ix - src / 2));
  const sy = Math.max(0, Math.min(ih - src, (ih - 1 - iy) - src / 2));
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(State.imgEl, sx, sy, src, src, 0, 0, c.width, c.height);
  // crosshair
  ctx.strokeStyle = '#7fff7f';
  ctx.beginPath();
  ctx.moveTo(c.width / 2, 0); ctx.lineTo(c.width / 2, c.height);
  ctx.moveTo(0, c.height / 2); ctx.lineTo(c.width, c.height / 2);
  ctx.stroke();
}

function drawColorbar() {
  // Render a thin strip from the LUT by drawing a gradient PNG stripe from
  // the current image (using a generated canvas). We approximate: just draw
  // a horizontal gradient using the current cmap name via a tiny request.
  const c = $('#colorbar');
  const ctx = c.getContext('2d');
  // As a light-weight approach, draw a black->white gradient tinted by a
  // hue mix that matches the cmap name roughly. (Display-only.)
  ctx.clearRect(0, 0, c.width, c.height);
  const name = State.meta ? State.meta.cmap : 'grey';
  const grad = ctx.createLinearGradient(0, 0, c.width, 0);
  const stops = cmapGradientStops(name);
  for (const [p, color] of stops) grad.addColorStop(p, color);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = '#888';
  ctx.strokeRect(0.5, 0.5, c.width - 1, c.height - 1);
}

function cmapGradientStops(name) {
  switch (name) {
    case 'red':    return [[0,'#000'],[1,'#f00']];
    case 'green':  return [[0,'#000'],[1,'#0f0']];
    case 'blue':   return [[0,'#000'],[1,'#00f']];
    case 'heat':   return [[0,'#000'],[0.34,'#f00'],[0.65,'#ff0'],[1,'#fff']];
    case 'cool':   return [[0,'#0ff'],[1,'#f0f']];
    case 'rainbow':return [[0,'#7f00ff'],[0.25,'#00f'],[0.5,'#0f0'],[0.75,'#ff0'],[1,'#f00']];
    case 'sls':    return [[0,'#000'],[0.3,'#0080ff'],[0.5,'#00ff80'],[0.7,'#ffff00'],[0.85,'#ff4d00'],[1,'#fff']];
    case 'hsv':    return [[0,'#f00'],[0.17,'#ff0'],[0.33,'#0f0'],[0.5,'#0ff'],[0.67,'#00f'],[0.83,'#f0f'],[1,'#f00']];
    case 'bb':     return [[0,'#000'],[0.5,'#f80'],[1,'#fff']];
    case 'he':     return [[0,'#000'],[0.5,'#a00'],[1,'#ff8'] ];
    case 'a':      return [[0,'#f00'],[0.25,'#ff0'],[0.5,'#0f0'],[0.75,'#0ff'],[1,'#00f']];
    case 'b':      return [[0,'#00f'],[0.25,'#0ff'],[0.5,'#0f0'],[0.75,'#ff0'],[1,'#f00']];
    case 'viridis':return [[0,'#440154'],[0.5,'#21908c'],[1,'#fde725']];
    case 'plasma': return [[0,'#0d0887'],[0.5,'#cc4778'],[1,'#f0f921']];
    case 'magma':  return [[0,'#000004'],[0.5,'#b63679'],[1,'#fcfdbf']];
    case 'grey':
    default:       return [[0,'#000'],[1,'#fff']];
  }
}

// ---------- info panel ----------

function updateInfo(meta, pixel) {
  $('#inf-file').textContent = meta && meta.filename ? meta.filename : '—';
  const obj = meta && meta.header && (meta.header.OBJECT || meta.header.TARGNAME);
  $('#inf-object').textContent = obj || '—';
  if (pixel) {
    $('#inf-value').textContent = pixel.value == null ? '—' : formatNum(pixel.value);
    $('#inf-image').textContent = `${pixel.x}, ${pixel.y}`;
    $('#inf-physical').textContent = `${pixel.x}, ${pixel.y}`;
    if (pixel.wcs) {
      $('#inf-wcs').textContent = 'FK5';
      $('#inf-fk5').textContent = formatCoords(pixel.wcs.ra, pixel.wcs.dec, State.wcsFormat);
      const gal = equToGal(pixel.wcs.ra, pixel.wcs.dec);
      $('#inf-gal').textContent = formatCoords(gal[0], gal[1], 'deg');
    } else {
      $('#inf-wcs').textContent = meta && meta.has_wcs ? 'FK5' : 'none';
      $('#inf-fk5').textContent = '—';
      $('#inf-gal').textContent = '—';
    }
  }
}

function formatNum(v) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(4);
  return v.toPrecision(6);
}

function formatCoords(ra, dec, fmt) {
  if (fmt === 'deg') return `${ra.toFixed(6)}, ${dec.toFixed(6)}`;
  return `${raHMS(ra)}, ${decDMS(dec)}`;
}

function raHMS(ra) {
  let h = ra / 15.0;
  const hh = Math.floor(h); h = (h - hh) * 60;
  const mm = Math.floor(h); const ss = (h - mm) * 60;
  return `${pad(hh)}:${pad(mm)}:${ss.toFixed(3).padStart(6,'0')}`;
}
function decDMS(dec) {
  const sign = dec < 0 ? '-' : '+';
  let d = Math.abs(dec);
  const dd = Math.floor(d); d = (d - dd) * 60;
  const mm = Math.floor(d); const ss = (d - mm) * 60;
  return `${sign}${pad(dd)}:${pad(mm)}:${ss.toFixed(2).padStart(5,'0')}`;
}
function pad(n) { return String(n).padStart(2, '0'); }

function equToGal(raDeg, decDeg) {
  // Simple J2000 -> Galactic using standard constants.
  const d2r = Math.PI / 180, r2d = 180 / Math.PI;
  const ra = raDeg * d2r, dec = decDeg * d2r;
  const raGP = 192.8595 * d2r, decGP = 27.1283 * d2r, lNCP = 122.9319 * d2r;
  const sinB = Math.sin(dec) * Math.sin(decGP) + Math.cos(dec) * Math.cos(decGP) * Math.cos(ra - raGP);
  const b = Math.asin(Math.max(-1, Math.min(1, sinB)));
  const y = Math.cos(dec) * Math.sin(ra - raGP);
  const x = Math.sin(dec) * Math.cos(decGP) - Math.cos(dec) * Math.sin(decGP) * Math.cos(ra - raGP);
  let l = lNCP - Math.atan2(y, x);
  l = ((l * r2d) % 360 + 360) % 360;
  return [l, b * r2d];
}

// ---------- button bar ----------

const BTN_GROUPS = {
  file: [
    ['Open',   () => actionOpen()],
    ['Header', () => actionHeader()],
    ['Save PNG', () => actionSavePNG()],
    ['Close',  () => actionClose()],
  ],
  edit: [
    ['None',     () => State.mode = 'none'],
    ['Region',   () => State.mode = 'region'],
    ['Crosshair',() => State.mode = 'crosshair'],
    ['Pan',      () => State.mode = 'pan'],
    ['Zoom',     () => State.mode = 'zoom'],
  ],
  view: [
    ['Info',     () => togglePanel('info')],
    ['Panner',   () => togglePanel('panner')],
    ['Magnifier',() => togglePanel('magnifier')],
    ['Colorbar', () => togglePanel('colorbar')],
    ['Buttons',  () => togglePanel('buttons')],
  ],
  frame: [
    ['New',   () => toast('Single-frame in this build')],
    ['Delete',() => toast('Single-frame in this build')],
    ['Clear', () => actionClear()],
    ['Reset', () => actionReset()],
  ],
  bin: [
    ['1',()=>toast('Binning TODO')],['2',()=>toast('Binning TODO')],
    ['4',()=>toast('Binning TODO')],['8',()=>toast('Binning TODO')],
  ],
  zoom: [
    ['in',    () => zoomBy(2)],
    ['out',   () => zoomBy(0.5)],
    ['fit',   () => zoomFit()],
    ['1',     () => setZoom(1)],
    ['2',     () => setZoom(2)],
    ['4',     () => setZoom(4)],
    ['8',     () => setZoom(8)],
    ['1/2',   () => setZoom(0.5)],
    ['1/4',   () => setZoom(0.25)],
    ['rot +90',() => rotateBy(90)],
    ['rot -90',() => rotateBy(-90)],
    ['align', () => { State.rotate = 0; draw(); }],
  ],
  scale: [
    ['linear', () => setScale({ scale: 'linear' })],
    ['log',    () => setScale({ scale: 'log' })],
    ['power',  () => setScale({ scale: 'power' })],
    ['sqrt',   () => setScale({ scale: 'sqrt' })],
    ['squared',() => setScale({ scale: 'squared' })],
    ['asinh',  () => setScale({ scale: 'asinh' })],
    ['sinh',   () => setScale({ scale: 'sinh' })],
    ['histequ',() => setScale({ scale: 'histequ' })],
    ['min max',() => setScale({ limit_mode: 'minmax' })],
    ['zscale', () => setScale({ limit_mode: 'zscale' })],
    ['99.5',   () => setScale({ limit_mode: '99.5' })],
    ['99',     () => setScale({ limit_mode: '99' })],
    ['95',     () => setScale({ limit_mode: '95' })],
    ['90',     () => setScale({ limit_mode: '90' })],
    ['limits…',() => actionScaleLimits()],
  ],
  color: [
    ['grey',   () => setCmap('grey')],
    ['red',    () => setCmap('red')],
    ['green',  () => setCmap('green')],
    ['blue',   () => setCmap('blue')],
    ['a',      () => setCmap('a')],
    ['b',      () => setCmap('b')],
    ['bb',     () => setCmap('bb')],
    ['he',     () => setCmap('he')],
    ['heat',   () => setCmap('heat')],
    ['cool',   () => setCmap('cool')],
    ['rainbow',() => setCmap('rainbow')],
    ['sls',    () => setCmap('sls')],
    ['hsv',    () => setCmap('hsv')],
    ['viridis',() => setCmap('viridis')],
    ['invert', () => toggleInvert()],
  ],
  region: [
    ['circle',  () => State.regionShape = 'circle'],
    ['box',     () => State.regionShape = 'box'],
    ['ellipse', () => State.regionShape = 'ellipse'],
    ['point',   () => State.regionShape = 'point'],
    ['polygon', () => State.regionShape = 'polygon'],
    ['list…',   () => actionRegionsList()],
    ['delete all', () => actionRegionsClear()],
  ],
  wcs: [
    ['fk5',      () => { State.wcsSystem = 'fk5'; updateInfo(State.meta, State.lastPixel); }],
    ['icrs',     () => { State.wcsSystem = 'icrs'; updateInfo(State.meta, State.lastPixel); }],
    ['galactic', () => { State.wcsSystem = 'galactic'; updateInfo(State.meta, State.lastPixel); }],
    ['sex',      () => { State.wcsFormat = 'sex'; updateInfo(State.meta, State.lastPixel); }],
    ['deg',      () => { State.wcsFormat = 'deg'; updateInfo(State.meta, State.lastPixel); }],
  ],
  analysis: [
    ['stats',     () => actionStats()],
    ['histogram', () => actionHistogram()],
    ['radial',    () => toast('Radial profile TODO')],
    ['contour',   () => toast('Contour TODO')],
  ],
};

function selectCategory(cat) {
  $$('#btn-row-main button').forEach(b =>
    b.classList.toggle('active', b.dataset.cat === cat));
  const sub = $('#btn-row-sub');
  sub.innerHTML = '';
  for (const [label, fn] of (BTN_GROUPS[cat] || [])) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = fn;
    sub.appendChild(b);
  }
}

// ---------- actions ----------

async function setScale(opts) {
  State.meta = await postJSON('/api/scale', opts);
  await reloadImage();
}
async function setCmap(name) {
  State.meta = await postJSON('/api/cmap', { cmap: name });
  await reloadImage();
}
async function toggleInvert() {
  State.meta = await postJSON('/api/cmap', { invert: !State.meta.invert });
  await reloadImage();
}

function zoomBy(factor) {
  State.viewZoom = Math.max(0.01, Math.min(64, State.viewZoom * factor));
  draw(); drawPanner();
}
function setZoom(z) { State.viewZoom = z; draw(); drawPanner(); }
function zoomFit() {
  if (!State.meta) return;
  const main = $('#maincanvas');
  State.viewZoom = Math.min(
    main.clientWidth / State.meta.width,
    main.clientHeight / State.meta.height,
  );
  State.panX = State.meta.width / 2;
  State.panY = State.meta.height / 2;
  draw(); drawPanner();
}
function rotateBy(deg) { State.rotate = (State.rotate + deg) % 360; draw(); }

async function actionOpen() {
  const p = prompt('FITS file path on server:');
  if (!p) return;
  try {
    State.meta = await postJSON('/api/load', { path: p });
    State.viewZoom = 1; State.panX = State.meta.width/2; State.panY = State.meta.height/2;
    await reloadImage();
    updateInfo(State.meta, null);
    zoomFit();
  } catch (e) { toast('Open failed: ' + e.message); }
}

async function actionHeader() {
  const hdr = await api('/api/header');
  const rows = Object.entries(hdr).map(([k,v]) =>
    `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(String(v))}</td></tr>`).join('');
  openModal('FITS Header', `<table><tr><th>Key</th><th>Value</th></tr>${rows}</table>`);
}
function actionSavePNG() {
  const a = document.createElement('a');
  a.href = '/api/image?t=' + Date.now();
  a.download = (State.meta && State.meta.filename || 'image') + '.png';
  a.click();
}
function actionClose() {
  if (confirm('Close current image?')) location.reload();
}
async function actionClear() { await actionRegionsClear(); }
async function actionReset() {
  State.viewZoom = 1; State.rotate = 0;
  if (State.meta) {
    State.panX = State.meta.width / 2;
    State.panY = State.meta.height / 2;
  }
  draw(); drawPanner();
}
async function actionScaleLimits() {
  const a = prompt('vmin:', State.meta.vmin);
  if (a == null) return;
  const b = prompt('vmax:', State.meta.vmax);
  if (b == null) return;
  await setScale({ vmin: parseFloat(a), vmax: parseFloat(b) });
}
async function actionStats() {
  const s = await api('/api/stats');
  const rows = Object.entries(s).map(([k,v]) =>
    `<tr><td>${k}</td><td>${typeof v==='number'? formatNum(v) : v}</td></tr>`).join('');
  openModal('Statistics', `<table>${rows}</table>`);
}
async function actionHistogram() {
  const h = await api('/api/histogram?bins=128');
  openModal('Histogram', histogramSVG(h));
}
async function actionRegionsList() {
  const { regions } = await api('/api/regions');
  const rows = regions.map((r, i) =>
    `<tr><td>${i}</td><td>${r.shape}</td><td>${formatNum(r.x)}, ${formatNum(r.y)}</td><td>${r.radius??r.w??''}</td></tr>`
  ).join('');
  openModal('Regions', `<table><tr><th>#</th><th>shape</th><th>x,y</th><th>size</th></tr>${rows}</table>`);
}
async function actionRegionsClear() {
  const { regions } = await postJSON('/api/regions', { action: 'clear' });
  State.meta.regions = regions;
  drawOverlay();
}

function histogramSVG(h) {
  const W = 480, H = 200, pad = 20;
  const bins = h.bins || [], counts = h.counts || [];
  if (!counts.length) return '(no data)';
  const maxC = Math.max(...counts);
  const bw = (W - 2 * pad) / counts.length;
  const bars = counts.map((c, i) => {
    const x = pad + i * bw;
    const bh = (c / maxC) * (H - 2 * pad);
    return `<rect x="${x.toFixed(1)}" y="${(H - pad - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" fill="#3478f6"/>`;
  }).join('');
  return `<svg width="${W}" height="${H}" style="background:#fff">
    ${bars}
    <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="#000"/>
    <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${H - pad}" stroke="#000"/>
    <text x="${pad}" y="${H}" font-size="10">${formatNum(bins[0])}</text>
    <text x="${W - pad - 60}" y="${H}" font-size="10">${formatNum(bins[bins.length - 1])}</text>
  </svg>`;
}

function togglePanel(name) {
  State.panels[name] = !State.panels[name];
  const map = {
    info: '#infobar', buttons: '#buttonbar',
    panner: '#panner', magnifier: '#magnifier', colorbar: '#colorbar',
  };
  const el = document.querySelector(map[name]);
  if (el) el.closest(name === 'info' || name === 'buttons' ? 'section' :
                     '.graph-cell').classList.toggle('hidden', !State.panels[name]);
}

// ---------- modal, toast, escape ----------

function openModal(title, html) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal').classList.remove('hidden');
}
function closeModal() { $('#modal').classList.add('hidden'); }
function toast(msg) {
  setStatus(msg);
  clearTimeout(toast._t);
  toast._t = setTimeout(() => setStatus('Ready'), 2500);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// ---------- menu handling ----------

function closeMenus() { $$('.menu.open').forEach(m => m.classList.remove('open')); }

function wireMenus() {
  $$('.menu').forEach(m => {
    m.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = m.classList.contains('open');
      closeMenus();
      if (!wasOpen) m.classList.add('open');
    });
  });
  document.addEventListener('click', closeMenus);
  document.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-action]');
    if (li) { handleMenuAction(li.dataset.action); closeMenus(); }
  });
}

function handleMenuAction(id) {
  // id is like "scale.func.log", "cmap.heat", "zoom.in", etc.
  const [cat, ...rest] = id.split('.');
  const key = rest.join('.');
  switch (cat) {
    case 'file':
      if (key === 'open') actionOpen();
      else if (key === 'header') actionHeader();
      else if (key === 'save-png') actionSavePNG();
      else if (key === 'close') actionClose();
      else if (key === 'exit') window.close();
      break;
    case 'edit':
      if (key.startsWith('mode.')) State.mode = key.slice(5);
      else if (key === 'undo') toast('Undo TODO');
      else if (key === 'prefs') openModal('Preferences', '<em>TODO</em>');
      break;
    case 'view':
      if (key.startsWith('toggle.')) togglePanel(key.slice(7));
      break;
    case 'frame':
      if (key === 'clear') actionClear();
      else if (key === 'reset') actionReset();
      else toast('Single-frame in this build');
      break;
    case 'bin':
      toast('Binning TODO');
      break;
    case 'zoom':
      if (key === 'in') zoomBy(2);
      else if (key === 'out') zoomBy(0.5);
      else if (key === 'fit') zoomFit();
      else if (key === 'align') { State.rotate = 0; draw(); }
      else if (key.startsWith('rotate.')) rotateBy(parseFloat(key.slice(7)));
      else setZoom(parseFloat(key));
      break;
    case 'scale':
      if (key === 'limits') actionScaleLimits();
      else if (key.startsWith('func.')) setScale({ scale: key.slice(5) });
      else if (key.startsWith('lim.'))  setScale({ limit_mode: key.slice(4) });
      break;
    case 'cmap':
      if (key === 'invert') toggleInvert();
      else setCmap(key);
      break;
    case 'region':
      if (key === 'delete-all') actionRegionsClear();
      else if (key === 'list') actionRegionsList();
      else if (key.startsWith('shape.')) State.regionShape = key.slice(6);
      break;
    case 'wcs':
      if (key === 'fk5' || key === 'icrs' || key === 'galactic') State.wcsSystem = key;
      else if (key === 'format.sex') State.wcsFormat = 'sex';
      else if (key === 'format.deg') State.wcsFormat = 'deg';
      updateInfo(State.meta, State.lastPixel);
      break;
    case 'analysis':
      if (key === 'stats') actionStats();
      else if (key === 'hist') actionHistogram();
      else toast('Not implemented');
      break;
    case 'help':
      if (key === 'about')
        openModal('About', '<b>DS9 HTTP</b><br>Browser-based DS9-like FITS viewer over HTTP.<br>Works over port-forwarding without X11.');
      else openModal('Keyboard', '<b>+</b> zoom in  <b>-</b> zoom out  <b>f</b> fit  <b>r</b> reset');
      break;
  }
}

// ---------- mouse / keyboard ----------

function wireCanvas() {
  const main = $('#maincanvas');
  const ov = $('#overlay');

  let lastMove = 0;
  ov.style.pointerEvents = 'auto';
  ov.addEventListener('mousemove', async (e) => {
    const r = main.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const [ix, iy] = screenToImage(sx, sy);
    drawMagnifier(Math.round(ix), Math.round(iy));
    // throttle server pixel queries
    const now = performance.now();
    if (now - lastMove < 40) return;
    lastMove = now;
    if (!State.meta || ix < 0 || iy < 0 || ix >= State.meta.width || iy >= State.meta.height) {
      State.lastPixel = { x: Math.round(ix), y: Math.round(iy), value: null, wcs: null };
      updateInfo(State.meta, State.lastPixel);
      return;
    }
    try {
      const p = await api(`/api/pixel?x=${Math.round(ix)}&y=${Math.round(iy)}`);
      State.lastPixel = p;
      updateInfo(State.meta, p);
    } catch {}
  });

  ov.addEventListener('mousedown', (e) => {
    const r = main.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const [ix, iy] = screenToImage(sx, sy);
    if (State.mode === 'pan' || e.button === 1 || e.shiftKey) {
      State.dragging = { sx, sy, panX: State.panX, panY: State.panY };
    } else if (State.mode === 'zoom') {
      zoomBy(e.button === 2 ? 0.5 : 2);
    } else if (State.mode === 'region' || State.mode === 'crosshair') {
      addRegionAt(ix, iy);
    }
  });
  ov.addEventListener('mousemove', (e) => {
    if (!State.dragging) return;
    const r = main.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const dx = (sx - State.dragging.sx) / State.viewZoom;
    const dy = (sy - State.dragging.sy) / State.viewZoom;
    State.panX = State.dragging.panX - dx;
    State.panY = State.dragging.panY + dy; // inverted Y (FITS)
    draw(); drawPanner();
  });
  window.addEventListener('mouseup', () => { State.dragging = null; });
  ov.addEventListener('contextmenu', (e) => e.preventDefault());

  ov.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.25 : 0.8);
  }, { passive: false });

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === '+' || e.key === '=') zoomBy(2);
    else if (e.key === '-') zoomBy(0.5);
    else if (e.key === 'f') zoomFit();
    else if (e.key === 'r') actionReset();
    else if (e.key === 'Escape') closeModal();
  });
}

async function addRegionAt(ix, iy) {
  if (!State.meta) return;
  let r;
  if (State.regionShape === 'circle')
    r = { shape: 'circle', x: ix, y: iy, radius: 20 / State.viewZoom };
  else if (State.regionShape === 'box')
    r = { shape: 'box', x: ix, y: iy, w: 40 / State.viewZoom, h: 40 / State.viewZoom };
  else if (State.regionShape === 'point')
    r = { shape: 'point', x: ix, y: iy };
  else
    r = { shape: State.regionShape, x: ix, y: iy, radius: 20 / State.viewZoom };
  const resp = await postJSON('/api/regions', { action: 'add', region: r });
  State.meta.regions = resp.regions;
  drawOverlay();
}

// ---------- init ----------

async function init() {
  wireMenus();
  $('#modal-close').onclick = closeModal;

  $$('#btn-row-main button').forEach(b =>
    b.addEventListener('click', () => selectCategory(b.dataset.cat)));

  try {
    State.meta = await getState();
  } catch (e) {
    setStatus('Server unreachable');
    return;
  }
  resizeCanvases();
  wireCanvas();

  if (State.meta.width) {
    State.panX = State.meta.width / 2;
    State.panY = State.meta.height / 2;
    await reloadImage();
    zoomFit();
    updateInfo(State.meta, null);
  } else {
    setStatus('No image loaded — use File → Open');
    updateInfo(State.meta, null);
  }
  selectCategory('scale');
  drawColorbar();

  window.addEventListener('resize', () => { resizeCanvases(); draw(); drawPanner(); });
}

document.addEventListener('DOMContentLoaded', init);








