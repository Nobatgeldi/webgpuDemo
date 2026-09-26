// Shared constants and helpers.

const PI: f32 = 3.141592653589793;
// Largest radiance written to the rgba16float HDR target. Half floats overflow to
// infinity above 65504, which the tone mapper would turn into NaN (black pixels).
const HDR_MAX_RADIANCE: f32 = 60000.0;

fn clampHdr(color: vec3<f32>) -> vec3<f32> {
  return min(color, vec3<f32>(HDR_MAX_RADIANCE));
}

struct FullscreenVertex {
  @builtin(position) position: vec4<f32>,
  // Normalised device coordinates of the vertex (x right, y up).
  @location(0) ndc: vec2<f32>,
}

// One oversized triangle covering the viewport: draw(3) with no vertex buffer.
fn fullscreenTriangle(vertexIndex: u32, depth: f32) -> FullscreenVertex {
  let uv = vec2<f32>(f32((vertexIndex << 1u) & 2u), f32(vertexIndex & 2u));
  let ndc = uv * 2.0 - 1.0;
  var out: FullscreenVertex;
  out.position = vec4<f32>(ndc, depth, 1.0);
  out.ndc = ndc;
  return out;
}

// World-space view direction through an NDC position (camera-relative space).
fn viewRayFromNdc(invViewProj: mat4x4<f32>, ndc: vec2<f32>) -> vec3<f32> {
  // Reversed Z: the near plane is at depth 1, which is numerically the most precise.
  let p = invViewProj * vec4<f32>(ndc, 1.0, 1.0);
  return normalize(p.xyz / p.w);
}

fn henyeyGreenstein(cosTheta: f32, g: f32) -> f32 {
  let g2 = g * g;
  let denom = max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4);
  return (1.0 - g2) / (4.0 * PI * denom * sqrt(denom));
}
