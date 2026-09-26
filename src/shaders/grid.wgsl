// Debug reference grid on the y = 0 plane (sea level). Verifies camera-relative
// rendering and reversed-Z depth: lines stay stable at any distance from the origin.
// Requires the scene prelude (shaders/index.ts).

// Half-size of the grid quad around the camera (m); beyond it only sky is visible.
const GRID_HALF_EXTENT_M: f32 = 40000.0;
// Line spacings (m). Must divide the CPU-side wrap period (CAMERA_WRAP_PERIOD_M).
const GRID_MINOR_SPACING_M: f32 = 1.0;
const GRID_MAJOR_SPACING_M: f32 = 10.0;
const GRID_SUPER_SPACING_M: f32 = 100.0;
// Line widths as a fraction of their cell (world-space width = fraction x spacing).
const GRID_MINOR_LINE_FRACTION: f32 = 0.02;
const GRID_MAJOR_LINE_FRACTION: f32 = 0.012;
const GRID_SUPER_LINE_FRACTION: f32 = 0.008;
// Axis half-width in pixels.
const GRID_AXIS_HALF_WIDTH_PX: f32 = 1.5;
// Diffuse albedo of the base plane, the line levels and the axes.
const GRID_BASE_ALBEDO: vec3<f32> = vec3<f32>(0.02, 0.045, 0.07);
const GRID_MINOR_ALBEDO: vec3<f32> = vec3<f32>(0.06, 0.08, 0.1);
const GRID_MAJOR_ALBEDO: vec3<f32> = vec3<f32>(0.12, 0.15, 0.18);
const GRID_SUPER_ALBEDO: vec3<f32> = vec3<f32>(0.2, 0.24, 0.28);
const GRID_AXIS_X_ALBEDO: vec3<f32> = vec3<f32>(0.5, 0.06, 0.05);
const GRID_AXIS_Z_ALBEDO: vec3<f32> = vec3<f32>(0.05, 0.12, 0.5);
// Distance (m) over which the grid fades into the horizon haze.
const GRID_FOG_DISTANCE_M: f32 = 12000.0;

struct GridVertex {
  @builtin(position) position: vec4<f32>,
  // Position relative to the camera (m).
  @location(0) relative: vec3<f32>,
}

@vertex
fn vsMain(@builtin(vertex_index) vertexIndex: u32) -> GridVertex {
  // Two triangles: (0,1,2) (2,1,3) over the corners of a square.
  var corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(-1.0, 1.0),
    vec2<f32>(-1.0, 1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
  );
  let corner = corners[vertexIndex] * GRID_HALF_EXTENT_M;
  let relative = vec3<f32>(corner.x, -frame.cameraWorld.y, corner.y);
  var out: GridVertex;
  out.position = frame.viewProj * vec4<f32>(relative, 1.0);
  out.relative = relative;
  return out;
}

// Anti-aliased line coverage with world-space line width that converges to the
// average coverage when the cells get smaller than a pixel, so there is neither
// moire nor a dark band towards the horizon. After Ben Golus, "The Best Darn
// Grid Shader (Yet)" (2023).
fn gridLines(coord: vec2<f32>, spacing: f32, lineFraction: f32) -> f32 {
  let uv = coord / spacing;
  let ddx = dpdx(uv);
  let ddy = dpdy(uv);
  let uvDeriv = max(vec2<f32>(length(vec2<f32>(ddx.x, ddy.x)), length(vec2<f32>(ddx.y, ddy.y))),
    vec2<f32>(1e-6));
  let targetWidth = vec2<f32>(lineFraction);
  let drawWidth = clamp(targetWidth, uvDeriv, vec2<f32>(0.5));
  let lineAA = uvDeriv * 1.5;
  let gridUV = 1.0 - abs(fract(uv) * 2.0 - 1.0);
  var lines = smoothstep(drawWidth + lineAA, drawWidth - lineAA, gridUV);
  lines *= saturate(targetWidth / drawWidth);
  lines = mix(lines, targetWidth, saturate(uvDeriv * 2.0 - 1.0));
  return mix(lines.x, 1.0, lines.y);
}

fn axisLine(coord: f32) -> f32 {
  let footprint = max(fwidth(coord), 1e-6);
  return 1.0 - saturate(abs(coord) / footprint - GRID_AXIS_HALF_WIDTH_PX);
}

@fragment
fn fsMain(in: GridVertex) -> @location(0) vec4<f32> {
  // Wrapped world XZ: exact far from the origin because the wrap happened in double precision.
  let wrappedXZ = frame.cameraWrapped.xz + in.relative.xz;
  var albedo = GRID_BASE_ALBEDO;
  albedo = mix(albedo, GRID_MINOR_ALBEDO,
    gridLines(wrappedXZ, GRID_MINOR_SPACING_M, GRID_MINOR_LINE_FRACTION));
  albedo = mix(albedo, GRID_MAJOR_ALBEDO,
    gridLines(wrappedXZ, GRID_MAJOR_SPACING_M, GRID_MAJOR_LINE_FRACTION));
  albedo = mix(albedo, GRID_SUPER_ALBEDO,
    gridLines(wrappedXZ, GRID_SUPER_SPACING_M, GRID_SUPER_LINE_FRACTION));

  // Axes through the true world origin (approximate absolute position is fine here).
  let absoluteXZ = frame.cameraWorld.xz + in.relative.xz;
  albedo = mix(albedo, GRID_AXIS_X_ALBEDO, axisLine(absoluteXZ.y));
  albedo = mix(albedo, GRID_AXIS_Z_ALBEDO, axisLine(absoluteXZ.x));

  // Lambertian lighting from the sun and the sky.
  let sunCos = max(frame.sunDirection.y, 0.0);
  let irradiance = frame.sunIrradiance.rgb * sunCos + skyIrradiance();
  var color = albedo * irradiance / PI;

  // Fade into the horizon haze, approximated by the sky mirrored at the horizon.
  let distance = length(in.relative);
  let dir = in.relative / max(distance, 1e-3);
  let fog = 1.0 - exp(-distance / GRID_FOG_DISTANCE_M);
  color = mix(color, skyRadiance(vec3<f32>(dir.x, abs(dir.y), dir.z)), fog);
  return vec4<f32>(clampHdr(color), 1.0);
}
