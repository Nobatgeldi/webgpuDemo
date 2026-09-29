// Flag cloth: two-sided, lit by sun and sky, with the Turkish flag drawn
// procedurally from its official construction (TS 3771), in units of the
// hoist G: sleeve 1/30 G, outer crescent circle centre 1/2 G from the sleeve
// with diameter 1/2 G, inner circle 1/16 G further with diameter 0.4 G, star
// circumscribed by a circle of diameter 1/4 G, 1/3 G beyond the inner circle,
// one point towards the hoist. Requires the scene prelude.

const FLAG_RED: vec3<f32> = vec3<f32>(0.768, 0.003, 0.009); // #E30A17 in linear sRGB
const FLAG_WHITE: vec3<f32> = vec3<f32>(0.82, 0.82, 0.8);
const FLAG_SLEEVE: f32 = 1.0 / 30.0;
const CRESCENT_OUTER_CENTRE: f32 = 0.5;
const CRESCENT_OUTER_RADIUS: f32 = 0.25;
const CRESCENT_INNER_OFFSET: f32 = 1.0 / 16.0;
const CRESCENT_INNER_RADIUS: f32 = 0.2;
const STAR_GAP: f32 = 1.0 / 3.0;
const STAR_RADIUS: f32 = 0.125;
// Inner to outer radius of a regular five-pointed star.
const STAR_INNER_RATIO: f32 = 0.381966;
// Fabric: diffuse translucency (light seen through the cloth) and sheen.
const FLAG_TRANSLUCENCY: f32 = 0.35;
const FLAG_FOG_DISTANCE_M: f32 = 25000.0;
// Haze gets denser under an overcast storm sky (as for the sea).
const FLAG_OVERCAST_FOG_REDUCTION: f32 = 0.6;

struct FlagVertexInput {
  // Camera-relative position (m), normal, flag coordinates in hoists (u from the hoist, v up)
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
}

struct FlagVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) relative: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,
}

@vertex
fn vsMain(input: FlagVertexInput) -> FlagVertexOutput {
  var output: FlagVertexOutput;
  output.position = frame.viewProj * vec4<f32>(input.position, 1.0);
  output.relative = input.position;
  output.normal = input.normal;
  output.uv = input.uv;
  return output;
}

// Signed distance to a regular five-pointed star with a point along +y (after I. Quilez).
fn starDistance(point: vec2<f32>, radius: f32, innerRatio: f32) -> f32 {
  let k1 = vec2<f32>(0.809016994375, -0.587785252292);
  let k2 = vec2<f32>(-k1.x, k1.y);
  var p = vec2<f32>(abs(point.x), point.y);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= radius;
  let ba = innerRatio * vec2<f32>(-k1.y, k1.x) - vec2<f32>(0.0, 1.0);
  let h = clamp(dot(p, ba) / dot(ba, ba), 0.0, radius);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}

// White emblem coverage (0..1) at flag coordinates, anti-aliased over `width`.
fn turkishFlagWhite(uv: vec2<f32>, width: f32) -> f32 {
  let centreV = 0.5;
  let outerCentre = vec2<f32>(FLAG_SLEEVE + CRESCENT_OUTER_CENTRE, centreV);
  let innerCentre = outerCentre + vec2<f32>(CRESCENT_INNER_OFFSET, 0.0);
  let outer = length(uv - outerCentre) - CRESCENT_OUTER_RADIUS;
  let inner = length(uv - innerCentre) - CRESCENT_INNER_RADIUS;
  let crescent = max(outer, -inner);
  let starCentre = vec2<f32>(innerCentre.x + CRESCENT_INNER_RADIUS + STAR_GAP + STAR_RADIUS, centreV);
  let local = uv - starCentre;
  // Rotate so the point along +y of starDistance points towards the hoist (-u).
  let star = starDistance(vec2<f32>(local.y, -local.x), STAR_RADIUS, STAR_INNER_RATIO);
  let sleeve = uv.x - FLAG_SLEEVE;
  let emblem = min(min(crescent, star), sleeve);
  return 1.0 - smoothstep(-width, width, emblem);
}

@fragment
fn fsMain(input: FlagVertexOutput, @builtin(front_facing) front: bool) -> @location(0) vec4<f32> {
  let width = max(length(fwidth(input.uv)), 1e-4);
  let albedo = mix(FLAG_RED, FLAG_WHITE, turkishFlagWhite(input.uv, width));
  var n = normalize(input.normal);
  if (!front) {
    n = -n;
  }
  let distance = length(input.relative);
  let v = -input.relative / max(distance, 1e-3);
  let sunDir = frame.sunDirection.xyz;
  let sun = frame.sunIrradiance.rgb;
  let lit = saturate(dot(n, sunDir));
  // Thin bunting: sunlight on the far side shows through.
  let through = FLAG_TRANSLUCENCY * saturate(-dot(n, sunDir));
  var color = albedo / PI * (sun * (lit + through) + skyIrradiance() * (0.5 + 0.5 * n.y));
  let fog = 1.0 - exp(-distance / (FLAG_FOG_DISTANCE_M * (1.0 - FLAG_OVERCAST_FOG_REDUCTION * frame.sky.x)));
  let viewDir = -v;
  color = mix(color, skyRadiance(vec3<f32>(viewDir.x, abs(viewDir.y), viewDir.z)), fog);
  return vec4<f32>(clampHdr(color), 1.0);
}
