// Vessel rendering: hull (antifouling below the boot top), deck and
// superstructure, lit by the sun and the sky, with the same haze as the sea.
// Requires the scene prelude (shaders/index.ts).

const MATERIAL_HULL: u32 = 0u;
const MATERIAL_DECK: u32 = 1u;
const MATERIAL_SUPERSTRUCTURE: u32 = 2u;
const MATERIAL_DARK: u32 = 3u;
// Diffuse albedos (linear).
const ALBEDO_TOPSIDES: vec3<f32> = vec3<f32>(0.32, 0.34, 0.37);
const ALBEDO_ANTIFOULING: vec3<f32> = vec3<f32>(0.3, 0.045, 0.035);
const ALBEDO_DECK: vec3<f32> = vec3<f32>(0.14, 0.16, 0.15);
const ALBEDO_SUPERSTRUCTURE: vec3<f32> = vec3<f32>(0.62, 0.64, 0.66);
const ALBEDO_DARK: vec3<f32> = vec3<f32>(0.05, 0.05, 0.055);
const ALBEDO_GLASS: vec3<f32> = vec3<f32>(0.02, 0.025, 0.03);
// Height of the boot-top line above the design waterline (hull frame, m).
const BOOT_TOP_HEIGHT_M: f32 = 0.3;
// Blinn-Phong highlight of painted steel and of glass.
const PAINT_SPECULAR: f32 = 0.04;
const PAINT_SHININESS: f32 = 60.0;
const GLASS_SPECULAR: f32 = 0.5;
const GLASS_SHININESS: f32 = 400.0;
// Light reflected from the sea onto downward-facing surfaces (fraction of sky light).
const SEA_BOUNCE: f32 = 0.06;
// Haze distance matches the sea surface (m).
const SHIP_FOG_DISTANCE_M: f32 = 25000.0;

struct ShipUniforms {
  // Hull frame -> camera-relative world (rotation and translation).
  model: mat4x4<f32>,
}

@group(1) @binding(0) var<uniform> ship: ShipUniforms;

struct ShipVertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) material: f32,
}

struct ShipVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) relative: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) hullHeight: f32,
  @location(3) @interpolate(flat) material: u32,
}

@vertex
fn vsMain(input: ShipVertexInput) -> ShipVertexOutput {
  let relative = (ship.model * vec4<f32>(input.position, 1.0)).xyz;
  var output: ShipVertexOutput;
  output.position = frame.viewProj * vec4<f32>(relative, 1.0);
  output.relative = relative;
  output.normal = (ship.model * vec4<f32>(input.normal, 0.0)).xyz;
  output.hullHeight = input.position.y;
  output.material = u32(input.material + 0.5);
  return output;
}

@fragment
fn fsMain(input: ShipVertexOutput) -> @location(0) vec4<f32> {
  var albedo: vec3<f32>;
  var specular = PAINT_SPECULAR;
  var shininess = PAINT_SHININESS;
  switch input.material {
    case MATERIAL_HULL: {
      albedo = select(ALBEDO_TOPSIDES, ALBEDO_ANTIFOULING, input.hullHeight < BOOT_TOP_HEIGHT_M);
    }
    case MATERIAL_DECK: { albedo = ALBEDO_DECK; }
    case MATERIAL_SUPERSTRUCTURE: { albedo = ALBEDO_SUPERSTRUCTURE; }
    case MATERIAL_DARK: { albedo = ALBEDO_DARK; }
    default: {
      albedo = ALBEDO_GLASS;
      specular = GLASS_SPECULAR;
      shininess = GLASS_SHININESS;
    }
  }
  let n = normalize(input.normal);
  let distance = length(input.relative);
  let v = -input.relative / max(distance, 1e-3);
  let sunDir = frame.sunDirection.xyz;
  let sun = frame.sunIrradiance.rgb;
  // Sky light: full from above, fading to the dim sea bounce from below.
  let skyFraction = mix(SEA_BOUNCE, 1.0, 0.5 + 0.5 * n.y);
  let diffuse = albedo / PI * (sun * saturate(dot(n, sunDir)) + skyIrradiance() * skyFraction);
  let h = normalize(v + sunDir);
  let highlight = sun * specular * (shininess + 8.0) / (8.0 * PI) * pow(saturate(dot(n, h)), shininess) * saturate(dot(n, sunDir));
  var color = diffuse + highlight;
  let fog = 1.0 - exp(-distance / (SHIP_FOG_DISTANCE_M * (1.0 - 0.6 * frame.sky.x)));
  let viewDir = -v;
  color = mix(color, skyRadiance(vec3<f32>(viewDir.x, abs(viewDir.y), viewDir.z)), fog);
  return vec4<f32>(clampHdr(color), 1.0);
}
