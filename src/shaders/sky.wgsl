// Sky background pass. Drawn after opaque geometry at the far plane (depth 0 in
// reversed Z) with 'greater-equal', so it only fills pixels nothing else covered.
// Requires the scene prelude (shaders/index.ts).

@vertex
fn vsMain(@builtin(vertex_index) vertexIndex: u32) -> FullscreenVertex {
  return fullscreenTriangle(vertexIndex, 0.0);
}

@fragment
fn fsMain(in: FullscreenVertex) -> @location(0) vec4<f32> {
  let dir = viewRayFromNdc(frame.invViewProj, in.ndc);
  return vec4<f32>(clampHdr(skyRadiance(dir) + sunDiskRadiance(dir)), 1.0);
}
