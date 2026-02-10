const fileInput = document.getElementById("file");
const logCurveSel = document.getElementById("logCurve");
const toggleBtn = document.getElementById("toggleEl");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

let img = new Image();
let hasImage = false;
let elOn = false;

// Cache: originele pixels + overlay pixels
let baseImageData = null;
let overlayImageData = null;
let lastCurveKey = null;

/**
 * Palette: later kunnen we de hexes 1:1 matchen met SmallHD door te samplen.
 * Buckets: -6,-5,-4,-3,-2,-1,-0.5,0,+0.5,+1,+2,+3,+4,+5,+6
 */
const ZCOL = new Map([
  [ 6,  "#ffffff"],
  [ 5,  "#ff2a2a"],
  [ 4,  "#ff6a00"],
  [ 3,  "#ffb000"],
  [ 2,  "#fff04a"],
  [ 1,  "#e6ff00"],
  [ 0.5,"#c8ff6a"],
  [ 0,  "#8a8a8a"],   // 18% ref
  [-0.5,"#3cff3c"],
  [-1,  "#00ff66"],
  [-2,  "#00d9ff"],
  [-3,  "#0070ff"],
  [-4,  "#3a2bff"],
  [-5,  "#7b2bff"],
  [-6,  "#000000"],
]);

// Legend
const legendOrder = [6,5,4,3,2,1,0.5,0,-0.5,-1,-2,-3,-4,-5,-6];
const legend = document.getElementById("legend");
if (legend) {
  legend.innerHTML = legendOrder.map(z => `
    <div class="swatch" style="background:${ZCOL.get(z)}"></div>
    <div style="font-size:12px; opacity:.9">${z > 0 ? "+"+z : ""+z} stop</div>
  `).join("");
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n>>16)&255, (n>>8)&255, n&255];
}

// Precompute palette to RGB arrays
const pal = {};
for (const [k, hex] of ZCOL.entries()) pal[k] = hexToRgb(hex);

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const log2 = (x) => Math.log(x) / Math.log(2);

function quantizeStops(st) {
  if (st >= 5.5) return 6;
  if (st >= 4.5) return 5;
  if (st >= 3.5) return 4;
  if (st >= 2.5) return 3;
  if (st >= 1.5) return 2;
  if (st >= 0.75) return 1;
  if (st >= 0.25) return 0.5;
  if (st > -0.25) return 0;
  if (st > -0.75) return -0.5;
  if (st > -1.5) return -1;
  if (st > -2.5) return -2;
  if (st > -3.5) return -3;
  if (st > -4.5) return -4;
  if (st > -5.5) return -5;
  return -6;
}

/* =========================
   LOG decoders (to linear)
   ========================= */

// Sony S-Log3 inverse (normalized 0..1 in/out), per Sony formula.
function decodeSLog3(v) {
  v = clamp01(v);
  const cut = 171.2102946929 / 1023.0;

  if (v >= cut) {
    // out = 10^((in*1023 - 420)/261.5) * (0.18+0.01) - 0.01
    return Math.pow(10.0, ((v * 1023.0 - 420.0) / 261.5)) * 0.19 - 0.01;
  } else {
    // out = (in*1023 - 95) * 0.01125 / (171.2102946929 - 95)
    return (v * 1023.0 - 95.0) * 0.01125 / (171.2102946929 - 95.0);
  }
}

// ARRI LogC3 EI800 inverse (exposure values), per ARRI VFX doc.
const LOGC3_EI800 = {
  a: 5.555556,
  b: 0.052272,
  c: 0.247190,
  d: 0.385537,
  e: 5.367655,
  f: 0.092809,
  LOG_CUT: 0.149658
};
function decodeLogC3_EI800(t) {
  t = clamp01(t);
  if (t > LOGC3_EI800.LOG_CUT) {
    return (Math.pow(10.0, (t - LOGC3_EI800.d) / LOGC3_EI800.c) - LOGC3_EI800.b) / LOGC3_EI800.a;
  }
  return (t - LOGC3_EI800.f) / LOGC3_EI800.e;
}

// Blackmagic Film Generation 5 inverse OETF (used by PYXIS / Gen5 science)
const BMD_GEN5 = {
  A: 0.08692876065491224,
  B: 0.005494072432257808,
  C: 0.5300133392291939,
  D: 8.283605932402494,
  E: 0.09246575342465753,
  LIN_CUT: 0.005,
};
function decodeBmdFilmGen5(y) {
  y = clamp01(y);
  const LOG_CUT = BMD_GEN5.D * BMD_GEN5.LIN_CUT + BMD_GEN5.E;
  if (y < LOG_CUT) return (y - BMD_GEN5.E) / BMD_GEN5.D;
  return Math.exp((y - BMD_GEN5.C) / BMD_GEN5.A) - BMD_GEN5.B;
}

// DJI D-Log (X9) inverse (normalized 0..1)
function decodeDLog_X9(x) {
  x = clamp01(x);
  if (x <= 0.14) return (x - 0.0929) / 6.025;
  return (Math.pow(10.0, (3.89616 * x - 2.27752)) - 0.0108) / 0.9892;
}

/**
 * Curve registry (makkelijk uitbreidbaar)
 * Als je dropdown dezelfde values gebruikt, werkt dit direct.
 */
const CURVES = {
  slog3: { label: "S-Gamut3.Cine / S-Log3 (Sony)", decode: decodeSLog3 },
  logc3_ei800: { label: "ARRI LogC3 (EI 800)", decode: decodeLogC3_EI800 },
  bmd_film_gen5: { label: "Blackmagic Film Gen 5 (PYXIS)", decode: decodeBmdFilmGen5 },
  dlog_x9: { label: "DJI D-Log (X9 / Ronin 4D)", decode: decodeDLog_X9 },
};

function decodeToLinear(curveKey, v) {
  const c = CURVES[curveKey];
  return c ? c.decode(v) : v;
}

/* =========================
   Rendering helpers
   ========================= */

function drawBase() {
  if (!hasImage) return;
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  canvas.width = w;
  canvas.height = h;

  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);

  // Cache base pixels once
  baseImageData = ctx.getImageData(0, 0, w, h);
}

function buildOverlay(curveKey) {
  if (!baseImageData) return;

  const w = baseImageData.width;
  const h = baseImageData.height;

  const src = baseImageData.data;
  const dst = ctx.createImageData(w, h);
  const out = dst.data;

  // EL Zone reference: 18% grey as 0 stops (linear domain).
  const Yref = 0.18;

  for (let i = 0; i < src.length; i += 4) {
    const r = src[i] / 255;
    const g = src[i + 1] / 255;
    const b = src[i + 2] / 255;

    const R = decodeToLinear(curveKey, r);
    const G = decodeToLinear(curveKey, g);
    const B = decodeToLinear(curveKey, b);

    const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;

    const st = log2(Math.max(1e-12, Y) / Yref);
    const z = quantizeStops(st);

    const [pr, pg, pb] = pal[z];
    out[i]     = pr;
    out[i + 1] = pg;
    out[i + 2] = pb;
    out[i + 3] = 255;
  }

  overlayImageData = dst;
  lastCurveKey = curveKey;
}

function render() {
  if (!hasImage) return;

  const curveKey = logCurveSel?.value || "slog3";

  // If no base cached yet, draw it
  if (!baseImageData) drawBase();

  // Toggle behaviour: SmallHD-style = image replaced by false color when ON
  if (!elOn) {
    // show original
    ctx.putImageData(baseImageData, 0, 0);
    return;
  }

  // Build overlay only if needed
  if (!overlayImageData || lastCurveKey !== curveKey) {
    buildOverlay(curveKey);
  }

  // Show overlay (replaces image)
  ctx.putImageData(overlayImageData, 0, 0);
}

/* =========================
   Events
   ========================= */

toggleBtn.addEventListener("click", () => {
  if (!hasImage) return;
  elOn = !elOn;
  toggleBtn.textContent = elOn ? "EL Zone: ON" : "EL Zone: OFF";
  render();
});

logCurveSel.addEventListener("change", () => {
  if (!hasImage) return;
  // curve changed => overlay invalid
  overlayImageData = null;
  render();
});

fileInput.addEventListener("change", (e) => {
  const f = e.target.files?.[0];
  if (!f) return;

  const url = URL.createObjectURL(f);

  img = new Image();
  img.onload = () => {
    hasImage = true;
    elOn = false;

    toggleBtn.disabled = false;
    if (logCurveSel) logCurveSel.disabled = false;

    toggleBtn.textContent = "EL Zone: OFF";

    // reset caches
    baseImageData = null;
    overlayImageData = null;
    lastCurveKey = null;

    drawBase();
    render();

    URL.revokeObjectURL(url);
  };

  img.onerror = () => {
    hasImage = false;
    baseImageData = null;
    overlayImageData = null;
    lastCurveKey = null;
    toggleBtn.disabled = true;
    if (logCurveSel) logCurveSel.disabled = true;
    toggleBtn.textContent = "EL Zone: OFF";
    URL.revokeObjectURL(url);
    alert("Kon afbeelding niet laden. Probeer een andere file (liefst PNG/JPG).");
  };

  img.src = url;
});
