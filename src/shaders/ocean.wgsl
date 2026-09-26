// Sea surface: camera-centred clipmap levels displaced by the FFT cascades,
// with basic water shading (Fresnel, sky reflection, GGX sun glint, body
// scattering, distance fog). Phase 2 extends the shading.
// Requires frame.wgsl, common.wgsl, skyCommon.wgsl.

const OCEAN_MAX_CASCADES: u32 = 3u;
// Normal-incidence reflectance of water (n = 1.33).
const WATER_F0: f32 = 0.02;
// GGX roughness of the sun glint.
const WATER_SUN_ROUGHNESS: f32 = 0.08;
// Lower bound of the surface stretch (1 + dD/dx) when deriving normals, avoids
// singular normals where choppy waves fold over.
const MIN_SURFACE_STRETCH: f32 = 0.1;

struct OceanRenderUniforms {
  // xyz: patch sizes of cascades 0..2 (m), w: cascade count
  patchSizes: vec4<f32>,
  // x: FFT size, y: highest mip level, z: morph start, w: morph end (fractions of the level half-size)
  lod: vec4<f32>,
  // x: half cells per level M, y: index of the outermost level
  mesh: vec4<f32>,
  // rgb: water body scattering albedo, w: fog distance (m)
  water: vec4<f32>,
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
  return output;
}

fn ggxSunSpecular(n: vec3<f32>, v: vec3<f32>, l: vec3<f32>, roughness: f32) -> f32 {
  let h = normalize(v + l);
  let nDotL = saturate(dot(n, l));
  let nDotV = max(dot(n, v), 1e-4);
  let nDotH = saturate(dot(n, h));
  let vDotH = saturate(dot(v, h));
  let a = roughness * roughness;
  let a2 = a * a;
  let denom = nDotH * nDotH * (a2 - 1.0) + 1.0;
  let distribution = a2 / (PI * denom * denom);
  let k = (roughness + 1.0) * (roughness + 1.0) / 8.0;
  let geometry = nDotV / (nDotV * (1.0 - k) + k) * nDotL / (nDotL * (1.0 - k) + k);
  let fresnel = WATER_F0 + (1.0 - WATER_F0) * pow(1.0 - vDotH, 5.0);
  return distribution * geometry * fresnel / (4.0 * nDotV) ;
}

@fragment
fn fsMain(input: OceanVertexOutput) -> @location(0) vec4<f32> {
  let cascadeCount = u32(oceanRender.patchSizes.w);
  var derivatives = textureSample(derivativesTexture, oceanSampler, input.uv01.xy, 0);
  if (cascadeCount > 1u) {
    derivatives += textureSample(derivativesTexture, oceanSampler, input.uv01.zw, 1);
  }
  if (cascadeCount > 2u) {
    derivatives += textureSample(derivativesTexture, oceanSampler, input.uv2, 2);
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

  let fresnel = WATER_F0 + (1.0 - WATER_F0) * pow(1.0 - saturate(dot(n, v)), 5.0);
  var reflected = reflect(-v, n);
  reflected.y = abs(reflected.y);
  let skyReflection = skyRadiance(reflected);

  let sunDir = frame.sunDirection.xyz;
  let sunSpecular = frame.sunIrradiance.rgb * ggxSunSpecular(n, v, sunDir, WATER_SUN_ROUGHNESS);

  // Light scattered back out of the water body, lit by sun and sky.
  let skyIrradiance = PI * 0.5 * (frame.skyZenith.rgb + frame.skyHorizon.rgb);
  let irradiance = frame.sunIrradiance.rgb * max(sunDir.y, 0.0) + skyIrradiance;
  let body = oceanRender.water.rgb * irradiance / PI;

  var color = mix(body, skyReflection, fresnel) + sunSpecular;

  // Haze towards the horizon.
  let fog = 1.0 - exp(-distance / oceanRender.water.w);
  let viewDir = -v;
  color = mix(color, skyRadiance(vec3<f32>(viewDir.x, abs(viewDir.y), viewDir.z)), fog);
  return vec4<f32>(clampHdr(color), 1.0);
}
