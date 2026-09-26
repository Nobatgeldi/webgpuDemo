// HDR -> display pass: exposure (manual, optionally adapted to the sky
// brightness), tone mapping (ACES fit or AgX), sRGB encoding and triangular
// dithering against banding in smooth gradients (sky).
// Requires common.wgsl.

struct TonemapUniforms {
  // Linear exposure multiplier (2^EV).
  exposure: f32,
  // 0 = ACES (Hill fit), 1 = AgX
  operatorId: u32,
  // Dither amplitude in output code values (1 = +-1 LSB triangular).
  ditherLsb: f32,
  frameIndex: u32,
  // x: auto exposure on (0/1), y: target exposed mean sky radiance, z: minimum adaptation radiance
  autoExposure: vec4<f32>,
}

struct SkyLight {
  irradiance: vec4<f32>,
}

const LUMA: vec3<f32> = vec3<f32>(0.2126, 0.7152, 0.0722);

// True when the swap chain view is not an -srgb format and encoding must happen here.
override MANUAL_SRGB_ENCODE: bool = true;
// Quantisation step of the 8-bit swap chain.
const OUTPUT_LSB: f32 = 1.0 / 255.0;

const TONEMAP_ACES: u32 = 0u;
const TONEMAP_AGX: u32 = 1u;

@group(0) @binding(0) var<uniform> params: TonemapUniforms;
@group(0) @binding(1) var hdrTexture: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> skyLight: SkyLight;

// --- ACES filmic fit (Stephen Hill, BakingLab; MIT). Matrices are column-major. ---
const ACES_INPUT: mat3x3<f32> = mat3x3<f32>(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777,
);
const ACES_OUTPUT: mat3x3<f32> = mat3x3<f32>(
  1.60475, -0.10208, -0.00327,
  -0.53108, 1.10813, -0.07276,
  -0.07367, -0.00605, 1.07602,
);

fn rrtAndOdtFit(v: vec3<f32>) -> vec3<f32> {
  let a = v * (v + 0.0245786) - 0.000090537;
  let b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

fn tonemapAces(linearRgb: vec3<f32>) -> vec3<f32> {
  var color = ACES_INPUT * linearRgb;
  color = rrtAndOdtFit(color);
  return saturate(ACES_OUTPUT * color);
}

// --- AgX (Troy Sobotka), minimal polynomial fit by Benjamin Wrensch. ---
const AGX_INSET: mat3x3<f32> = mat3x3<f32>(
  0.842479062253094, 0.0423282422610123, 0.0423756549057051,
  0.0784335999999992, 0.878468636469772, 0.0784336,
  0.0792237451477643, 0.0791661274605434, 0.879142973793104,
);
const AGX_OUTSET: mat3x3<f32> = mat3x3<f32>(
  1.19687900512017, -0.0528968517574562, -0.0529716355144438,
  -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
  -0.0990297440797205, -0.0989611768448433, 1.15107367264116,
);
const AGX_MIN_EV: f32 = -12.47393;
const AGX_MAX_EV: f32 = 4.026069;
// Display gamma baked into the AgX curve; undone to return linear values.
const AGX_DISPLAY_GAMMA: f32 = 2.2;

fn agxContrastApprox(x: vec3<f32>) -> vec3<f32> {
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x
    - 0.00232;
}

fn tonemapAgx(linearRgb: vec3<f32>) -> vec3<f32> {
  var v = AGX_INSET * max(linearRgb, vec3<f32>(1e-10));
  v = clamp(log2(v), vec3<f32>(AGX_MIN_EV), vec3<f32>(AGX_MAX_EV));
  v = (v - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV);
  v = agxContrastApprox(v);
  v = AGX_OUTSET * v;
  return pow(saturate(v), vec3<f32>(AGX_DISPLAY_GAMMA));
}

fn linearToSrgb(c: vec3<f32>) -> vec3<f32> {
  let low = c * 12.92;
  let high = 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - 0.055;
  return select(high, low, c <= vec3<f32>(0.0031308));
}

// PCG-style integer hash -> uniform float in [0, 1).
fn hashUniform(seed: u32) -> f32 {
  let state = seed * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return f32((word >> 22u) ^ word) * (1.0 / 4294967296.0);
}

@vertex
fn vsMain(@builtin(vertex_index) vertexIndex: u32) -> FullscreenVertex {
  return fullscreenTriangle(vertexIndex, 0.0);
}

@fragment
fn fsMain(in: FullscreenVertex) -> @location(0) vec4<f32> {
  let pixel = vec2<u32>(in.position.xy);
  var exposure = params.exposure;
  if (params.autoExposure.x > 0.5) {
    // Adapt to the mean sky radiance so that day, dusk and storm stay readable;
    // below the floor the scene is allowed to get dark (night).
    let meanSkyRadiance = dot(skyLight.irradiance.rgb, LUMA) / PI;
    exposure *= params.autoExposure.y / max(meanSkyRadiance, params.autoExposure.z);
  }
  let hdr = textureLoad(hdrTexture, vec2<i32>(pixel), 0).rgb * exposure;

  var display: vec3<f32>;
  if (params.operatorId == TONEMAP_AGX) {
    display = tonemapAgx(hdr);
  } else {
    display = tonemapAces(hdr);
  }

  if (MANUAL_SRGB_ENCODE) {
    display = linearToSrgb(display);
    // Triangular-PDF dither: sum of two uniform variables, centred on zero.
    let seed = pixel.x * 1973u + pixel.y * 9277u + params.frameIndex * 26699u;
    let noise = hashUniform(seed) + hashUniform(seed ^ 0x9E3779B9u) - 1.0;
    display += noise * params.ditherLsb * OUTPUT_LSB;
  }
  return vec4<f32>(display, 1.0);
}
