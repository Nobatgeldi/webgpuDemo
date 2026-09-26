// Debug texture viewer: draws one layer of a simulation texture into a screen
// rectangle on top of the final image (after tone mapping).
// Requires common.wgsl.

const VIEW_SPECTRUM: u32 = 0u;
const VIEW_DISPLACEMENT: u32 = 1u;
const VIEW_DERIVATIVES: u32 = 2u;
const VIEW_FOAM: u32 = 3u;
const VIEW_LUT: u32 = 4u;
// Displayed decades of the spectrum magnitude |h0|.
const SPECTRUM_LOG_MIN: f32 = -7.0;
const SPECTRUM_LOG_RANGE: f32 = 6.0;

struct DebugViewUniforms {
  // xy: top-left corner (px), zw: size (px)
  rect: vec4<f32>,
  // x: mode, y: layer, z: value scale
  params: vec4<f32>,
  // xy: viewport size (px)
  viewport: vec4<f32>,
}

override MANUAL_SRGB_ENCODE: bool = true;

@group(0) @binding(0) var<uniform> view: DebugViewUniforms;
@group(0) @binding(1) var source: texture_2d_array<f32>;

struct DebugVertex {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
}

@vertex
fn vsMain(@builtin(vertex_index) index: u32) -> DebugVertex {
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(0.0, 1.0),
    vec2<f32>(0.0, 1.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0),
  );
  let corner = corners[index];
  let pixel = view.rect.xy + corner * view.rect.zw;
  let ndc = vec2<f32>(pixel.x / view.viewport.x * 2.0 - 1.0, 1.0 - pixel.y / view.viewport.y * 2.0);
  var out: DebugVertex;
  out.position = vec4<f32>(ndc, 0.0, 1.0);
  out.uv = corner;
  return out;
}

fn heat(t: f32) -> vec3<f32> {
  return saturate(vec3<f32>(1.5 * t, 1.5 * t - 0.5, 3.0 * t - 2.0) + vec3<f32>(0.0, 0.0, 0.3 * (1.0 - t)));
}

@fragment
fn fsMain(in: DebugVertex) -> @location(0) vec4<f32> {
  let dims = textureDimensions(source);
  let mode = u32(view.params.x);
  let layer = u32(view.params.y);
  let scale = view.params.z;
  var uv = in.uv;
  if (mode == VIEW_SPECTRUM) {
    // Centre k = 0 in the middle of the view.
    uv = fract(uv + 0.5);
  }
  let texel = min(vec2<u32>(uv * vec2<f32>(dims)), dims - vec2<u32>(1u));
  let value = textureLoad(source, texel, layer, 0);
  var color: vec3<f32>;
  switch mode {
    case VIEW_SPECTRUM: {
      let magnitude = length(value.xy);
      color = heat(saturate((log(magnitude + 1e-20) / log(10.0) - SPECTRUM_LOG_MIN) / SPECTRUM_LOG_RANGE));
    }
    case VIEW_DISPLACEMENT: {
      color = saturate(0.5 + value.xyz * scale);
    }
    case VIEW_DERIVATIVES: {
      color = saturate(vec3<f32>(0.5 + value.x * scale, 0.5 + value.y * scale, 0.5 + value.z));
    }
    case VIEW_FOAM: {
      // Foam in white, compressed surface (Jacobian < 1) tinted red.
      color = saturate(vec3<f32>(value.x) + vec3<f32>(0.4, 0.0, 0.0) * saturate(1.0 - value.y));
    }
    default: {
      let v = value.rgb * scale;
      color = v / (1.0 + v);
    }
  }
  if (MANUAL_SRGB_ENCODE) {
    color = select(1.055 * pow(color, vec3<f32>(1.0 / 2.4)) - 0.055, color * 12.92, color <= vec3<f32>(0.0031308));
  }
  return vec4<f32>(color, 1.0);
}
