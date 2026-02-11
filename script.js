// TVL EL ZONE — vNext (Legal/Full + proper Gamut->Rec709 luminance)

const fileInput   = document.getElementById("file");
const logCurveSel = document.getElementById("logCurve");
const toggleBtn   = document.getElementById("toggleEl");
const canvas      = document.getElementById("canvas");
const ctx         = canvas.getContext("2d", { willReadFrequently: true });

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

/* =========================
   Palette + legend
   ========================= */

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

/* =========================
   Utils
   ========================= */

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

function getExposureOffsetStops() {
  if (!expOffsetEl) return 0;
  const n = parseFloat(expOffsetEl.value);
  return Number.isFinite(n) ? n : 0;
}

/* =========================
   Levels: Full vs Legal
   ========================= */

function isLegalLevels() {
  return !!(legalLevelsEl && legalLevelsEl.checked);
}

// If the file is "legal/video range" (16–235), expand to full 0–1 before log decode.
function remapLevels01(v) {
  if (!isLegalLevels()) return v;
  const min = 16 / 255;
  const max = 235 / 255;
  return clamp01((v - min) / (max - min));
}

/* =========================
   Log decoders (to linear)
   ========================= */

// Sony S-Log3 inverse (practical)
function decodeSLog3(v) {
  v = clamp01(v);
  const cut = 171.2102946929 / 1023.0;
  if (v >= cut) {
    return Math.pow(10.0, ((v * 1023.0 - 420.0) / 261.5)) * 0.19 - 0.01;
  } else {
    return (v * 1023.0 - 95.0) * 0.01125 / (171.2102946929 - 95.0);
  }
}

// ARRI LogC3 EI800 inverse (approx)
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

// Blackmagic Film Gen5 inverse (log -> linear)
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

function decodeToLinear(curveKey, v) {
  const c = CURVES[curveKey];
  return c ? c.decode(v) : v;
}

/* =========================
   3x3 matrix helpers
   ========================= */

function mulMat3Vec3(M, v) {
  return [
    M[0][0]*v[0] + M[0][1]*v[1] + M[0][2]*v[2],
    M[1][0]*v[0] + M[1][1]*v[1] + M[1][2]*v[2],
    M[2][0]*v[0] + M[2][1]*v[1] + M[2][2]*v[2],
  ];
}

// Rec.709 / sRGB D65 matrices (scene-linear)
const MAT_REC709_TO_XYZ = [
  [0.41239079926595934, 0.357584339383878,   0.1804807884018343],
  [0.21263900587151027, 0.715168678767756,   0.07219231536073371],
  [0.01933081871559182, 0.11919477979462598, 0.9505321522496607],
];
const MAT_XYZ_TO_REC709 = [
  [ 3.2409699419045213,  -1.5373831775700935, -0.4986107602930033],
  [-0.9692436362808798,   1.8759675015077206,  0.04155505740717561],
  [ 0.05563007969699361, -0.20397695888897652, 1.0569715142428786],
];

/* =========================
   Camera gamut matrices
   ========================= */

// S-Gamut3.Cine (RGB->XYZ) from colour-science
const MAT_SGAMUT3CINE_TO_XYZ = [
  [ 0.59908392,  0.24892552,  0.10244649],
  [ 0.21507582,  0.88506850, -0.10014432],
  [-0.03206585, -0.02765839,  1.14878199],
];

// Blackmagic Wide Gamut (Gen5 primaries) RGB->XYZ from colour-science
const MAT_BWG_TO_XYZ = [
  [ 0.60653839,  0.22041247,  0.12350483],
  [ 0.26799269,  0.83274847, -0.10074116],
  [-0.02944256, -0.08661244,  1.20511281],
];

function camRGB_to_rec709RGB(curveKey, rgb) {
  const c = CURVES[curveKey];
  const camToXYZ = c?.matRGBtoXYZ;
  if (!camToXYZ) return rgb; // fallback: no gamut conversion
  const xyz = mulMat3Vec3(camToXYZ, rgb);
  const r709 = mulMat3Vec3(MAT_XYZ_TO_REC709, xyz);
  return r709;
}

/* =========================
   Curve registry
   - stopOffset: helps Gen5 near-black segment
   - stopBias: final tuning in stops (0 = off)
   - matRGBtoXYZ: camera primaries -> XYZ (for proper luminance)
   ========================= */

const CURVES = {
  slog3: {
    label: "S-Gamut3.Cine / S-Log3 (Sony)",
    decode: decodeSLog3,
    midGrey: 0.18,
    stopOffset: 0.0,
    stopBias: 0.0,
    matRGBtoXYZ: MAT_SGAMUT3CINE_TO_XYZ,
  },
  logc3_ei800: {
    label: "ARRI LogC3 (EI 800)",
    decode: decodeLogC3_EI800,
    midGrey: 0.18,
    stopOffset: 0.0,
    stopBias: 0.0,
    // (optional) add ARRI Wide Gamut matrix later if you want
    matRGBtoXYZ: null,
  },
  bmd_film_gen5: {
    label: "Blackmagic Film Gen 5 (PYXIS)",
    decode: decodeBmdFilmGen5,
    midGrey: 0.18,
    // your “Gen5 stopOffset fix” lives HERE:
    stopOffset: BMD_GEN5.b + 0.0325,
    // if you still need “net iets lichter”, tweak this +0.05..+0.20:
    stopBias: 0.0,
    matRGBtoXYZ: MAT_BWG_TO_XYZ,
  },
};

/* =========================
   Rendering
   ========================= */

function drawBaseFromSources() {
  if (!hasImage) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (baseBitmap) return void ctx.drawImage(baseBitmap, 0, 0);
  if (img && img.complete) return void ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
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

  const off  = curve.stopOffset ?? 0.0;
  const bias = curve.stopBias  ?? 0.0;

  for (let i = 0; i < src.length; i += 4) {
    const r0 = src[i]     / 255;
    const g0 = src[i + 1] / 255;
    const b0 = src[i + 2] / 255;

    // expand legal -> full BEFORE decode
    const r = remapLevels01(r0);
    const g = remapLevels01(g0);
    const b = remapLevels01(b0);

    // log -> linear (camera primaries)
    let R = decodeToLinear(curveKey, r);
    let G = decodeToLinear(curveKey, g);
    let B = decodeToLinear(curveKey, b);

    // Gen5 can go slightly negative in linear toe
    R = Math.max(0, R);
    G = Math.max(0, G);
    B = Math.max(0, B);

    // Convert camera-gamut linear RGB -> Rec709 linear RGB (for SmallHD-like luma)
    const [r709, g709, b709] = camRGB_to_rec709RGB(curveKey, [R, G, B]).map(v => Math.max(0, v));

    // Rec709 luma in linear
    const Y = 0.2126 * r709 + 0.7152 * g709 + 0.0722 * b709;

    const st = log2((Y + off + 1e-12) / (YrefAdj + off + 1e-12)) + bias;
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

  const curveKey   = logCurveSel?.value || "slog3";
  const levelsKey  = isLegalLevels() ? "legal" : "full";
  const expKey     = String(getExposureOffsetStops());

  if (!elOn) return void drawBaseFromSources();

  const needsRebuild =
    !overlayImageData ||
    lastCurveKey !== curveKey ||
    lastLevelsKey !== levelsKey ||
    lastExpKey !== expKey;

  if (needsRebuild) buildOverlay(curveKey);
  if (overlayImageData) ctx.putImageData(overlayImageData, 0, 0);
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

legalLevelsEl?.addEventListener("change", () => {
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
