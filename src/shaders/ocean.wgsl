// Sea surface: camera-centred clipmap levels displaced by the FFT cascades.
// Shading: Schlick Fresnel between sky reflection and light scattered out of
// the water body, GGX sun glint whose roughness accounts for the slopes the
// filtered textures cannot resolve at the pixel footprint (anti-aliasing),
// subsurface light through wave crests, foam and atmospheric haze.
// Requires the scene prelude (shaders/index.ts).

const OCEAN_MAX_CASCADES: u32 = 3u;
const FOAM_CASCADES: u32 = 2u;
// Normal-incidence reflectance of water (n = 1.33).
const WATER_F0: f32 = 0.02;
const LUMA: vec3<f32> = vec3<f32>(0.2126, 0.7152, 0.0722);
// Subsurface scattering through thin wave crests (colour of light transmitted
// through ~1 m of sea water, relative strength and view-to-sun focus).
const SSS_COLOR: vec3<f32> = vec3<f32>(0.1, 0.5, 0.45);
const SSS_STRENGTH: f32 = 0.03;
const SSS_FOCUS_POWER: f32 = 4.0;
// Crest height (as a fraction of Hs) at which subsurface light is fully visible.
const SSS_CREST_FRACTION_OF_HS: f32 = 0.5;
// Diffuse albedo of foam (bubbles scatter almost all light).
const FOAM_ALBEDO: f32 = 0.75;
// Foam amount mapped to coverage: soft onset, full at 1.
const FOAM_COVERAGE_START: f32 = 0.15;
// Wake foam: fresh foam covers from this amount on; aged foam needs more
// (plus wave convergence) and so survives only as streaks and patches.
const WAKE_FRESH_THRESHOLD: f32 = 0.2;
// How much fresh foam ignores the wave convergence (1 = uniformly white).
const WAKE_FRESH_UNIFORMITY: f32 = 0.7;
const WAKE_AGED_THRESHOLD: f32 = 0.55;
const WAKE_COVERAGE_WIDTH: f32 = 0.35;
// Weight of the wave convergence (surface compression) in breaking up aged wake foam.
const WAKE_DETAIL_BASE: f32 = 0.3;
const WAKE_DETAIL_GAIN: f32 = 1.4;
// Foam gathers where the smallest waves converge (compressed surface), which
// breaks the texel-sized foam patches of the long cascades into filaments:
// amount *= BASE + GAIN * saturate(0.5 - SCALE * (dDx/dx + dDz/dz) of the finest cascade).
const FOAM_DETAIL_BASE: f32 = 0.4;
const FOAM_DETAIL_GAIN: f32 = 1.2;
const FOAM_DETAIL_SCALE: f32 = 3.0;
// Specular reflection that survives under full foam cover.
const FOAM_SPECULAR_SCALE: f32 = 0.2;
// Haze gets denser under an overcast storm sky (spray, drizzle).
const OVERCAST_FOG_REDUCTION: f32 = 0.6;
const WIREFRAME_LINE_PX: f32 = 1.0;
// Lower bound of the surface stretch (1 + dD/dx) when deriving normals, avoids
// singular normals where choppy waves fold over.
const MIN_SURFACE_STRETCH: f32 = 0.1;

struct OceanRenderUniforms {
  // xyz: patch sizes of cascades 0..2 (m), w: cascade count
  patchSizes: vec4<f32>,
  // x: FFT size, y: highest mip level, z: morph start, w: morph end (fractions of the level half-size)
  lod: vec4<f32>,
  // x: half cells per level M, y: index of the outermost level, z: wireframe (0/1), w: Hs (m)
  mesh: vec4<f32>,
  // rgb: water body scattering albedo, w: fog distance (m)
  water: vec4<f32>,
  // x: ln(first table wavenumber), y: ln step, z: entries, w: minimum GGX alpha
  roughness: vec4<f32>,
  // Unresolved mean-square slope for cutoff wavenumbers k_i = exp(roughness.x + i * roughness.y).
  slopeVariance: array<vec4<f32>, 4>,
}

struct OceanLevel {
  // xy: level centre relative to the camera (m), z: vertex spacing (m), w: skirt distance (m)
  centre: vec4<f32>,
  // xy / zw: world XZ of the level centre wrapped by the patch size of cascade 0 / 1
  origin01: vec4<f32>,
  // xy: same for cascade 2
  origin2: vec4<f32>,
}

@group(1) @binding(0) var<uniform> oceanRender: OceanRenderUniforms;
@group(1) @binding(1) var<storage, read> levels: array<OceanLevel>;
@group(1) @binding(2) var displacementTexture: texture_2d_array<f32>;
@group(1) @binding(3) var derivativesTexture: texture_2d_array<f32>;
@group(1) @binding(4) var oceanSampler: sampler;
@group(1) @binding(5) var foamTexture: texture_2d_array<f32>;

// Wake foam around the ship (effects/wake.ts): toroidally addressed window.
struct WakeSampleUniforms {
  // xy: camera world XZ wrapped by the window size (m), z: window size (m)
  wrap: vec4<f32>,
  // xy: window lower corner relative to the camera (m), z: edge fade distance (m), w: enabled (0/1)
  window: vec4<f32>,
}

@group(2) @binding(0) var<uniform> wakeSample: WakeSampleUniforms;
@group(2) @binding(1) var wakeTexture: texture_2d<f32>;
@group(2) @binding(2) var wakeSampler: sampler;

// Wake foam (x: amount, y: fresh amount) at an undisplaced surface point
// (camera-relative XZ), so the foam rides on the waves.
fn wakeFoam(relativeXZ: vec2<f32>) -> vec2<f32> {
  if (wakeSample.window.w < 0.5) {
    return vec2<f32>(0.0);
  }
  let size = wakeSample.wrap.z;
  let local = relativeXZ - wakeSample.window.xy;
  let edge = min(min(local.x, local.y), min(size - local.x, size - local.y));
  let fade = saturate(edge / wakeSample.window.z);
  if (fade <= 0.0) {
    return vec2<f32>(0.0);
  }
  let uv = (wakeSample.wrap.xy + relativeXZ) / size;
  return textureSampleLevel(wakeTexture, wakeSampler, uv, 0.0).xy * fade;
}

struct OceanVertexInput {
  // xy: grid position in cells relative to the level centre, z: 1 for far skirt vertices
  @location(0) grid: vec3<f32>,
  @builtin(instance_index) level: u32,
}

struct OceanVertexOutput {
  @builtin(position) position: vec4<f32>,
  // Displaced surface position relative to the camera (m).
  @location(0) relative: vec3<f32>,
  // Undisplaced (Lagrangian) texture coordinates of cascades 0/1 and 2.
  @location(1) uv01: vec4<f32>,
  @location(2) uv2: vec2<f32>,
  // xy: grid position in cells, z: level (for the wireframe view)
  @location(3) grid: vec3<f32>,
  // Undisplaced surface position relative to the camera (XZ, m).
  @location(4) undisplaced: vec2<f32>,
}

fn cascadeOrigin(level: OceanLevel, cascade: u32) -> vec2<f32> {
  switch cascade {
    case 0u: { return level.origin01.xy; }
    case 1u: { return level.origin01.zw; }
    default: { return level.origin2.xy; }
  }
}

@vertex
fn vsMain(input: OceanVertexInput) -> OceanVertexOutput {
  let level = levels[input.level];
  let spacing = level.centre.z;
  let halfCells = oceanRender.mesh.x;

  var offset: vec2<f32>;
  var morph = 0.0;
  var displacementWeight = 1.0;
  if (input.grid.z > 0.5) {
    // Far skirt vertex: flat surface out to the horizon.
    offset = normalize(input.grid.xy) * level.centre.w;
    displacementWeight = 0.0;
  } else {
    // Geomorph: towards the outer edge of the level, odd vertices slide onto
    // their even neighbours, which coincide with the next coarser level.
    let unmorphed = level.centre.xy + input.grid.xy * spacing;
    let extent = max(abs(unmorphed.x), abs(unmorphed.y)) / (halfCells * spacing);
    morph = saturate((extent - oceanRender.lod.z) / (oceanRender.lod.w - oceanRender.lod.z));
    let odd = input.grid.xy - 2.0 * floor(input.grid.xy * 0.5);
    offset = (input.grid.xy - odd * morph) * spacing;
  }
  if (f32(input.level) == oceanRender.mesh.y) {
    // The outermost level flattens towards the skirt.
    displacementWeight *= 1.0 - morph;
  }

  let cascadeCount = u32(oceanRender.patchSizes.w);
  var uv: array<vec2<f32>, 3>;
  var displacement = vec3<f32>(0.0);
  for (var c = 0u; c < OCEAN_MAX_CASCADES; c++) {
    let patchSize = oceanRender.patchSizes[c];
    uv[c] = (cascadeOrigin(level, c) + offset) / patchSize;
    if (c < cascadeCount) {
      // Mip matching the vertex spacing; the morph term makes the fine level's
      // boundary sample exactly the same mip as the coarse level's vertices.
      let texelsPerVertex = spacing * oceanRender.lod.x / patchSize;
      let mip = clamp(log2(max(texelsPerVertex, 1e-6)) + morph, 0.0, oceanRender.lod.y);
      displacement += textureSampleLevel(displacementTexture, oceanSampler, uv[c], c, mip).xyz;
    }
  }
  displacement *= displacementWeight;

  let relativeXZ = level.centre.xy + offset;
  let relative = vec3<f32>(
    relativeXZ.x + displacement.x,
    displacement.y - frame.cameraWorld.y,
    relativeXZ.y + displacement.z,
  );
  var output: OceanVertexOutput;
  output.position = frame.viewProj * vec4<f32>(relative, 1.0);
  output.relative = relative;
  output.uv01 = vec4<f32>(uv[0], uv[1]);
  output.uv2 = uv[2];
  output.grid = vec3<f32>(input.grid.xy, f32(input.level));
  output.undisplaced = relativeXZ;
  return output;
}

// GGX specular times cos(theta_l) for a directional light; alpha = GGX width.
fn ggxSpecular(n: vec3<f32>, v: vec3<f32>, l: vec3<f32>, alpha: f32) -> f32 {
  let h = normalize(v + l);
  let nDotL = saturate(dot(n, l));
  let nDotV = max(dot(n, v), 1e-4);
  let nDotH = saturate(dot(n, h));
  let vDotH = saturate(dot(v, h));
  let a2 = alpha * alpha;
  let denom = nDotH * nDotH * (a2 - 1.0) + 1.0;
  let distribution = a2 / (PI * denom * denom);
  let k = alpha * 0.5;
  let geometry = nDotV / (nDotV * (1.0 - k) + k) * nDotL / (nDotL * (1.0 - k) + k);
  let fresnel = WATER_F0 + (1.0 - WATER_F0) * pow(1.0 - vDotH, 5.0);
  return distribution * geometry * fresnel / (4.0 * nDotV);
}

// Mean-square slope missing below the pixel footprint (table lookup in log k).
fn unresolvedSlopeVariance(footprintM: f32) -> f32 {
  let kCut = PI / max(footprintM, 1e-4);
  let count = oceanRender.roughness.z;
  let t = clamp((log(kCut) - oceanRender.roughness.x) / oceanRender.roughness.y, 0.0, count - 1.0);
  let i0 = u32(floor(t));
  let i1 = min(i0 + 1u, u32(count) - 1u);
  let a = oceanRender.slopeVariance[i0 / 4u][i0 % 4u];
  let b = oceanRender.slopeVariance[i1 / 4u][i1 % 4u];
  return mix(a, b, fract(t));
}

fn levelColor(level: f32) -> vec3<f32> {
  let hue = fract(level * 0.37);
  return saturate(abs(fract(hue + vec3<f32>(0.0, 0.667, 0.333)) * 6.0 - 3.0) - 1.0);
}

@fragment
fn fsMain(input: OceanVertexOutput) -> @location(0) vec4<f32> {
  let cascadeCount = u32(oceanRender.patchSizes.w);
  var derivatives = textureSample(derivativesTexture, oceanSampler, input.uv01.xy, 0);
  var finest = derivatives;
  if (cascadeCount > 1u) {
    finest = textureSample(derivativesTexture, oceanSampler, input.uv01.zw, 1);
    derivatives += finest;
  }
  if (cascadeCount > 2u) {
    finest = textureSample(derivativesTexture, oceanSampler, input.uv2, 2);
    derivatives += finest;
  }
  // Slopes of the displaced surface: dh/dx over the horizontal stretch 1 + dDx/dx.
  let stretchX = max(1.0 + derivatives.z, MIN_SURFACE_STRETCH);
  let stretchZ = max(1.0 + derivatives.w, MIN_SURFACE_STRETCH);
  var n = normalize(vec3<f32>(-derivatives.x / stretchX, 1.0, -derivatives.y / stretchZ));

  let distance = length(input.relative);
  let v = -input.relative / max(distance, 1e-3);
  // Normals facing away from the viewer (grazing angles) are bent back to the silhouette.
  let nDotV = dot(n, v);
  if (nDotV < 0.0) {
    n = normalize(n - v * (nDotV - 1e-3));
  }

  // Pixel footprint on the surface: slopes of finer waves are filtered away by
  // the mips and must widen the glint instead (anti-aliasing, LEAN-style).
  let footprint = max(length(dpdx(input.relative)), length(dpdy(input.relative)));
  let alpha = sqrt(oceanRender.roughness.w * oceanRender.roughness.w + unresolvedSlopeVariance(footprint));

  let fresnel = WATER_F0 + (1.0 - WATER_F0) * pow(1.0 - saturate(dot(n, v)), 5.0);
  var reflected = reflect(-v, n);
  reflected.y = abs(reflected.y);
  let skyReflection = skyRadiance(reflected);

  let sunDir = frame.sunDirection.xyz;
  let sunIrradiance = frame.sunIrradiance.rgb;
  let sunSpecular = sunIrradiance * ggxSpecular(n, v, sunDir, alpha);

  // Light scattered back out of the water body, lit by sun and sky.
  let diffuseIrradiance = sunIrradiance * max(sunDir.y, 0.0) + skyIrradiance();
  var body = oceanRender.water.rgb * diffuseIrradiance / PI;

  // Sunlight transmitted through thin crests towards the viewer.
  let heightAboveMean = input.relative.y + frame.cameraWorld.y;
  let crest = saturate(heightAboveMean / max(SSS_CREST_FRACTION_OF_HS * oceanRender.mesh.w, 1e-3));
  let towardsSun = pow(saturate(dot(-v, sunDir) * 0.5 + 0.5), SSS_FOCUS_POWER);
  body += SSS_COLOR * sunIrradiance * (SSS_STRENGTH * crest * towardsSun);

  var color = mix(body, skyReflection, fresnel);

  // Foam: bright diffuse cover that suppresses the reflection.
  var foamAmount = 0.0;
  let cascadeCountFoam = min(cascadeCount, FOAM_CASCADES);
  foamAmount += textureSample(foamTexture, oceanSampler, input.uv01.xy, 0).x;
  if (cascadeCountFoam > 1u) {
    foamAmount += textureSample(foamTexture, oceanSampler, input.uv01.zw, 1).x;
  }
  let detail = saturate(0.5 - FOAM_DETAIL_SCALE * (finest.z + finest.w));
  var coverage = smoothstep(FOAM_COVERAGE_START, 1.0, foamAmount * (FOAM_DETAIL_BASE + FOAM_DETAIL_GAIN * detail));
  let wake = wakeFoam(input.undisplaced);
  if (wake.x > 0.0) {
    let freshness = saturate(wake.y / wake.x);
    let threshold = mix(WAKE_AGED_THRESHOLD, WAKE_FRESH_THRESHOLD, freshness);
    let amount = wake.x * mix(WAKE_DETAIL_BASE + WAKE_DETAIL_GAIN * detail, 1.0, WAKE_FRESH_UNIFORMITY * freshness);
    coverage = max(coverage, smoothstep(threshold, threshold + WAKE_COVERAGE_WIDTH, amount));
  }
  let foamRadiance = FOAM_ALBEDO * (sunIrradiance * saturate(dot(n, sunDir)) + skyIrradiance()) / PI;
  color = mix(color, foamRadiance, coverage);
  color += sunSpecular * mix(1.0, FOAM_SPECULAR_SCALE, coverage);

  if (oceanRender.mesh.z > 0.5) {
    let cellDistance = abs(fract(input.grid.xy + 0.5) - 0.5) / max(fwidth(input.grid.xy), vec2<f32>(1e-5));
    let line = 1.0 - saturate(min(cellDistance.x, cellDistance.y) - WIREFRAME_LINE_PX);
    let wireRadiance = levelColor(input.grid.z) * dot(diffuseIrradiance, LUMA) / PI;
    color = mix(color, wireRadiance, line);
  }

  // Haze towards the horizon (denser in storms).
  let fogDistance = oceanRender.water.w * (1.0 - OVERCAST_FOG_REDUCTION * frame.sky.x);
  let fog = 1.0 - exp(-distance / fogDistance);
  let viewDir = -v;
  color = mix(color, skyRadiance(vec3<f32>(viewDir.x, abs(viewDir.y), viewDir.z)), fog);
  return vec4<f32>(clampHdr(color), 1.0);
}
