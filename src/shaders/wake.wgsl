// Wake foam: a foam amount field on a toroidally addressed texture that
// follows the ship. Texel t holds the world cell c in the current window
// [origin, origin + N) with c = t (mod N), so moving the window needs no copy:
// cells that were not inside the previous window start empty.
// Each update: diffusion (the turbulent wake widens), exponential decay, and
// foam laid down along the path of each emitter since the previous frame.
// Channel r: foam amount (slow decay); g: fresh foam (fast decay), which lets
// the renderer draw young foam dense and old foam as broken streaks.

const WAKE_MAX_EMITTERS: u32 = 16u;

struct WakeUpdateUniforms {
  // xy: current window origin (cells), zw: previous window origin (cells)
  origin: vec4<i32>,
  // x: decay factor over the step, y: diffusion number D dt / dx^2, z: maximum foam, w: emitter count
  params: vec4<f32>,
  // x: cell size (m), y: texture size N (texels), z: decay factor of the fresh foam over the step
  grid: vec4<f32>,
  // Per emitter: segment start xy and end zw relative to the current window origin (m).
  segments: array<vec4<f32>, 16>,
  // Per emitter: x: Gaussian radius (m), y: foam added at the centre over this step
  shapes: array<vec4<f32>, 16>,
}

@group(0) @binding(0) var<uniform> wake: WakeUpdateUniforms;
@group(0) @binding(1) var previousFoam: texture_2d<f32>;
@group(0) @binding(2) var nextFoam: texture_storage_2d<rgba16float, write>;

fn positiveMod(a: vec2<i32>, n: i32) -> vec2<i32> {
  return ((a % n) + n) % n;
}

fn insideWindow(cell: vec2<i32>, origin: vec2<i32>, n: i32) -> bool {
  let local = cell - origin;
  return all(local >= vec2<i32>(0)) && all(local < vec2<i32>(n));
}

// Foam (r) and fresh foam (g) of a world cell in the previous field (zero outside the previous window).
fn previousAt(cell: vec2<i32>, n: i32) -> vec2<f32> {
  if (!insideWindow(cell, wake.origin.zw, n)) {
    return vec2<f32>(0.0);
  }
  return textureLoad(previousFoam, positiveMod(cell, n), 0).xy;
}

fn distanceToSegment(p: vec2<f32>, a: vec2<f32>, b: vec2<f32>) -> f32 {
  let ab = b - a;
  let t = saturate(dot(p - a, ab) / max(dot(ab, ab), 1e-8));
  return length(p - (a + t * ab));
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let n = i32(wake.grid.y);
  let texel = vec2<i32>(id.xy);
  if (any(texel >= vec2<i32>(n))) {
    return;
  }
  let origin = wake.origin.xy;
  let cell = origin + positiveMod(texel - origin, n);

  let centre = previousAt(cell, n);
  let neighbours =
    previousAt(cell + vec2<i32>(1, 0), n) + previousAt(cell - vec2<i32>(1, 0), n) +
    previousAt(cell + vec2<i32>(0, 1), n) + previousAt(cell - vec2<i32>(0, 1), n);
  var foam = (centre + wake.params.y * (neighbours - 4.0 * centre)) * vec2<f32>(wake.params.x, wake.grid.z);

  let p = (vec2<f32>(cell - origin) + 0.5) * wake.grid.x;
  let count = u32(wake.params.w);
  for (var i = 0u; i < WAKE_MAX_EMITTERS; i++) {
    if (i >= count) {
      break;
    }
    let segment = wake.segments[i];
    let shape = wake.shapes[i];
    let d = distanceToSegment(p, segment.xy, segment.zw) / shape.x;
    foam += shape.y * exp(-0.5 * d * d);
  }
  foam = clamp(foam, vec2<f32>(0.0), vec2<f32>(wake.params.z));
  textureStore(nextFoam, texel, vec4<f32>(foam, 0.0, 1.0));
}
