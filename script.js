// TVL EL ZONE — complete script (Legal/Full + Gen5 stopOffset + luma mode + BMD contrast)

const fileInput     = document.getElementById("file");
const logCurveSel   = document.getElementById("logCurve");
const toggleBtn     = document.getElementById("toggleEl");
const canvas        = document.getElementById("canvas");
const ctx           = canvas.getContext("2d", { willReadFrequently: true });

const legalLevelsEl = document.getElementById("legalLevels"); // optional
const expOffsetEl   = document.getElementById("expOffset");   // optional

let img = new Image();
let baseBitmap = null;
let hasImage = false;
let elOn = false;

let baseImageData = null;
let overlayImageData = null;

let lastCurveKey = null;
let lastLevelsKey = null;
let lastExpKey = null;

// =========================
// Palette
// =========================
const ZCOL = new Map([
  [ 6,  "#ffffff"],
  [ 5,  "#ff2a2a"],
  [ 4,  "#ff6a00"],
  [ 3,  "#ffb000"],
  [ 2,  "#fff04a"],
  [ 1,  "#e6ff00"],
  [ 0.5,"#c8ff6a"],
  [ 0,  "#8a8a8a"],
  [-0.5,"#3cff3c"],
  [-1,  "#00ff66"],
  [-2,  "#00d9ff"],
  [-3,  "#0070ff"],
  [-4,  "#3a2bff"],
  [-5,  "#7b2bff"],
  [-6,  "#000000"],
]);

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
const pal = {};
for (const [k, hex] of ZCOL.entries()) pal[k] = hexToRgb(hex);

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const log2 = (x) => Math.log(x) / Math.log(2);

// =========================
// Stops quantize
// =========================
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

function getExposureOffsetStops() {
  if (!expOffsetEl) return 0;
  const n = parseFloat(expOffsetEl.value);
  return Number.isFinite(n) ? n : 0;
}

// =========================
// Levels: Full vs Legal
// =========================
function isLegalLevels() {
  return !!(legalLevelsEl && legalLevelsEl.checked);
}

// If legal: stretch 16–235 to 0–1 (8-bit video range)
function remapLevels01(v) {
  if (!isLegalLevels()) return v;
  const min = 16 / 255;
  const max = 235 / 255;
  return clamp01((v - min) / (max - min));
}

// =========================
// LOG decoders (to linear)
// =========================
function decodeSLog3(v) {
  v = clamp01(v);
  const cut = 171.2102946929 / 1023.0;
  if (v >= cut) {
    return Math.pow(10.0, ((v * 1023.0 - 420.0) / 261.5)) * 0.19 - 0.01;
  }
  return (v * 1023.0 - 95.0) * 0.01125 / (171.2102946929 - 95.0);
}

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

const BMD_GEN5 = {
  a: 0.08692876065491224,
  b: 0.005494072432257808,
  c: 0.5300133392291939,
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

// =========================
// Curve registry (ONE place)
// =========================
const CURVES = {
  slog3: {
    label: "S-Gamut3.Cine / S-Log3 (Sony)",
    decode: decodeSLog3,
    midGrey: 0.18,
    stopOffset: 0.0,
    contrastStops: 1.0,
    biasStops: 0.0,
  },
  logc3_ei800: {
    label: "ARRI LogC3 (EI 800)",
    decode: decodeLogC3_EI800,
    midGrey: 0.18,
    stopOffset: 0.0,
    contrastStops: 1.0,
    biasStops: 0.0,
  },
  bmd_film_gen5: {
    label: "Blackmagic Film Gen 5",
    decode: decodeBmdFilmGen5,
    midGrey: 0.18,
    stopOffset: BMD_GEN5.b + 0.0025,

    // === TUNE HIER ===
    // Contrast in stop-domain: >1 = meer contrast (high hoger, low lager)
    contrastStops: 1.08,   // jij had 1.14 → nu 1.08
    // Wil je "geen stops erbij"? zet dit op 0.0
    biasStops: 0.35        // jij zei 0.25 → nu 0.35 (optioneel)
  }
};

function decodeToLinear(curveKey, v) {
  const c = CURVES[curveKey];
  return c ? c.decode(v) : v;
}

// =========================
// Luma model (key fix)
// =========================
const LUMA_MODE = "maxRGB"; // "maxRGB" | "avgRGB" | "rec709"

function computeY(R, G, B) {
  if (LUMA_MODE === "maxRGB") return Math.max(R, G, B);
  if (LUMA_MODE === "avgRGB") return (R + G + B) / 3;
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

// =========================
// Rendering
// =========================
function drawBaseFromSources() {
  if (!hasImage) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (baseBitmap) return ctx.drawImage(baseBitmap, 0, 0);
  if (img && img.complete) return ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  if (baseImageData) ctx.putImageData(baseImageData, 0, 0);
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

  const expOff = getExposureOffsetStops();
  const YrefAdj = Yref * Math.pow(2, expOff);

  const off = curve.stopOffset ?? 0.0;
  const contrast = curve.contrastStops ?? 1.0;
  const bias = curve.biasStops ?? 0.0;

  for (let i = 0; i < src.length; i += 4) {
    const r0 = src[i]     / 255;
    const g0 = src[i + 1] / 255;
    const b0 = src[i + 2] / 255;

    // levels remap BEFORE log decode
    const r = remapLevels01(r0);
    const g = remapLevels01(g0);
    const b = remapLevels01(b0);

    const R = decodeToLinear(curveKey, r);
    const G = decodeToLinear(curveKey, g);
    const B = decodeToLinear(curveKey, b);

    const Y  = computeY(R, G, B);
    const Ycl = Math.max(0, Y);

    // Base stops
    let st = log2((Ycl + off + 1e-12) / (YrefAdj + off + 1e-12));

    // Contrast in stop-domain (dit is de echte “meer contrast” fix)
    st *= contrast;

    // Optional per-curve bias (alleen BMD gebruikt dit nu)
    st += bias;

    const z = quantizeStops(st);
    const [pr, pg, pb] = pal[z];

    out[i]     = pr;
    out[i + 1] = pg;
    out[i + 2] = pb;
    out[i + 3] = 255;
  }

  overlayImageData = dst;
  lastCurveKey = curveKey;
  lastLevelsKey = isLegalLevels() ? "legal" : "full";
  lastExpKey = String(getExposureOffsetStops());
}

function render() {
  if (!hasImage) return;

  const curveKey  = logCurveSel?.value || "slog3";
  const levelsKey = isLegalLevels() ? "legal" : "full";
  const expKey    = String(getExposureOffsetStops());

  if (!elOn) return drawBaseFromSources();

  const needsRebuild =
    !overlayImageData ||
    lastCurveKey !== curveKey ||
    lastLevelsKey !== levelsKey ||
    lastExpKey !== expKey;

  if (needsRebuild) buildOverlay(curveKey);
  if (overlayImageData) ctx.putImageData(overlayImageData, 0, 0);
}

// =========================
// Events
// =========================
toggleBtn?.addEventListener("click", () => {
  if (!hasImage) return;
  elOn = !elOn;
  toggleBtn.textContent = elOn ? "EL Zone: ON" : "EL Zone: OFF";
  render();
});

logCurveSel?.addEventListener("change", () => {
  overlayImageData = null;
  render();
});
expOffsetEl?.addEventListener("input", () => {
  overlayImageData = null;
  render();
});
legalLevelsEl?.addEventListener("change", () => {
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
  lastLevelsKey = null;
  lastExpKey = null;
  baseBitmap = null;

  toggleBtn.disabled = false;
  if (logCurveSel) logCurveSel.disabled = false;
  toggleBtn.textContent = "EL Zone: OFF";
  elOn = false;

  try {
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
