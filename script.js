const fileInput   = document.getElementById("file");
const logCurveSel = document.getElementById("logCurve");
const toggleBtn   = document.getElementById("toggleEl");
const canvas      = document.getElementById("canvas");
const ctx         = canvas.getContext("2d", { willReadFrequently: true });

// Optional: als je later een slider toevoegt
// <input id="expOffset" type="range" min="-3" max="3" step="0.25" value="0" />
const expOffsetEl = document.getElementById("expOffset");

let img = new Image();
let baseBitmap = null;   // ImageBitmap route
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
  [ 0,  "#8a8a8a"],   // 0 stop
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

// Sony S-Log3 inverse (normalized 0..1 in/out).
// Let op: dit is een praktische decoder. Voor 100% spec-match moet je
// exact dezelfde code-value mapping gebruiken als SmallHD (10-bit scaling/offsets).
function decodeSLog3(v) {
  v = clamp01(v);
  const cut = 171.2102946929 / 1023.0;

  if (v >= cut) {
    return Math.pow(10.0, ((v * 1023.0 - 420.0) / 261.5)) * 0.19 - 0.01;
  } else {
    return (v * 1023.0 - 95.0) * 0.01125 / (171.2102946929 - 95.0);
  }
}

// ARRI LogC3 EI800 inverse (approx, per published constants)
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

// Blackmagic Film Generation 5 inverse OETF (log -> linear) (OCIO/ACES style)
const BMD_GEN5 = {
  a: 0.08692876065491224,     // logSideSlope
  b: 0.005494072432257808,    // linSideOffset
  c: 0.5300133392291939,      // logSideOffset
  linSlope: 8.283605932402494,
  linOffset: 0.09246575342465753,
  linCut: 0.005,
};
const BMD_GEN5_LOG_CUT = BMD_GEN5.linSlope * BMD_GEN5.linCut + BMD_GEN5.linOffset;

function decodeBmdFilmGen5(y) {
  y = clamp01(y);
  if (y <= BMD_GEN5_LOG_CUT) {
    return (y - BMD_GEN5.linOffset) / BMD_GEN5.linSlope;
  }
  return Math.exp((y - BMD_GEN5.c) / BMD_GEN5.a) - BMD_GEN5.b;
}

/**
 * Curve registry
 * Voeg pas D-Log toe als je decoder echt bestaat.
 */
const CURVES = {
  slog3:         { label: "S-Gamut3.Cine / S-Log3 (Sony)", decode: decodeSLog3,        midGrey: 0.18 },
  logc3_ei800:   { label: "ARRI LogC3 (EI 800)",           decode: decodeLogC3_EI800,  midGrey: 0.18 },
  bmd_film_gen5: { label: "Blackmagic Film Gen 5",         decode: decodeBmdFilmGen5,  midGrey: 0.18 },
  // dlog_x9: { label: "DJI D-Log (X9 / Ronin 4D)", decode: decodeDLog_X9, midGrey: 0.18 },
};

function decodeToLinear(curveKey, v) {
  const c = CURVES[curveKey];
  return c ? c.decode(v) : v;
}

function getExposureOffsetStops() {
  if (!expOffsetEl) return 0;
  const n = parseFloat(expOffsetEl.value);
  return Number.isFinite(n) ? n : 0;
}

/* =========================
   Rendering helpers
   ========================= */

function drawBaseFromSources() {
  if (!hasImage) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (baseBitmap) {
    ctx.drawImage(baseBitmap, 0, 0);
    return;
  }
  if (img && img.complete) {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return;
  }
  if (baseImageData) {
    ctx.putImageData(baseImageData, 0, 0);
  }
}

function buildOverlay(curveKey) {
  if (!baseImageData) return;

  const w = baseImageData.width;
  const h = baseImageData.height;

  const src = baseImageData.data;
  const dst = ctx.createImageData(w, h);
  const out = dst.data;

  const curve = CURVES[curveKey] || CURVES.slog3;
  const Yref = curve.midGrey ?? 0.18;

  // Exposure offset (stops): +1 betekent 1 stop lichter in zones (dus Yref * 2^+1)
  const expOff = getExposureOffsetStops();
  const YrefAdj = Yref * Math.pow(2, expOff);

  for (let i = 0; i < src.length; i += 4) {
    const r = src[i] / 255;
    const g = src[i + 1] / 255;
    const b = src[i + 2] / 255;

    // decode per channel -> linear light
    const R = decodeToLinear(curveKey, r);
    const G = decodeToLinear(curveKey, g);
    const B = decodeToLinear(curveKey, b);

    // linear luma
    const Y = 0.2126 * R + 0.7152 * G + 0.0722 * B;

    const st = log2(Math.max(1e-12, Y) / YrefAdj);
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

  if (!elOn) {
    drawBaseFromSources();
    return;
  }

  if (!overlayImageData || lastCurveKey !== curveKey) {
    buildOverlay(curveKey);
  }

  if (overlayImageData) {
    ctx.putImageData(overlayImageData, 0, 0);
  }
}

/* =========================
   Events
   ========================= */

toggleBtn?.addEventListener("click", () => {
  if (!hasImage) return;
  elOn = !elOn;
  toggleBtn.textContent = elOn ? "EL Zone: ON" : "EL Zone: OFF";
  render();
});

logCurveSel?.addEventListener("change", () => {
  if (!hasImage) return;
  overlayImageData = null;
  render();
});

expOffsetEl?.addEventListener("input", () => {
  if (!hasImage) return;
  overlayImageData = null;
  render();
});

fileInput?.addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;

  hasImage = false;
  baseImageData = null;
  overlayImageData = null;
  lastCurveKey = null;
  baseBitmap = null;

  toggleBtn.disabled = false;
  if (logCurveSel) logCurveSel.disabled = false;
  toggleBtn.textContent = "EL Zone: OFF";
  elOn = false;

  try {
    // Prefer: bypass ICC/sRGB conversions where possible
    let bmp = null;
    if ("createImageBitmap" in window) {
      try {
        bmp = await createImageBitmap(f, { colorSpaceConversion: "none" });
      } catch (_) {
        bmp = await createImageBitmap(f);
      }
    }

    if (bmp) {
      baseBitmap = bmp;
      canvas.width = bmp.width;
      canvas.height = bmp.height;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, 0, 0);

      baseImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      hasImage = true;
      render();
      return;
    }

    // Fallback: old Image() path
    const url = URL.createObjectURL(f);
    img = new Image();
    img.onload = () => {
      baseBitmap = null;

      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);

      baseImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      hasImage = true;
      render();

      URL.revokeObjectURL(url);
    };
    img.src = url;

  } catch (err) {
    console.error(err);
    alert("Kon afbeelding niet laden. Probeer een andere file (liefst PNG/JPG).");
  }
});
