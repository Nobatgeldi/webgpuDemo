// Debug geometry (force vectors, submerged hull triangles) drawn on top of the
// tone-mapped image, without depth test so that underwater parts stay visible.
// Requires frame.wgsl.

override MANUAL_SRGB_ENCODE: bool = true;

struct DebugVertexInput {
  // Position relative to the camera (m).
  @location(0) position: vec3<f32>,
  // Display-referred linear colour and opacity.
  @location(1) color: vec4<f32>,
}

struct DebugVertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
}

@vertex
fn vsMain(input: DebugVertexInput) -> DebugVertexOutput {
  var output: DebugVertexOutput;
  output.position = frame.viewProj * vec4<f32>(input.position, 1.0);
  output.color = input.color;
  return output;
}

@fragment
fn fsMain(input: DebugVertexOutput) -> @location(0) vec4<f32> {
  var color = saturate(input.color.rgb);
  if (MANUAL_SRGB_ENCODE) {
    color = select(1.055 * pow(color, vec3<f32>(1.0 / 2.4)) - 0.055, color * 12.92, color <= vec3<f32>(0.0031308));
  }
  return vec4<f32>(color, input.color.a);
}
