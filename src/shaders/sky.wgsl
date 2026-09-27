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
  // Below the horizon the sea normally covers the view. Where it does not (sub-pixel
  // gaps between far clipmap triangles at grazing angles) show what the sea fades
  // into at great distance, the mirrored sky, instead of the dark ground of the LUT.
  let seen = vec3<f32>(dir.x, abs(dir.y), dir.z);
  return vec4<f32>(clampHdr(skyRadiance(seen) + sunDiskRadiance(dir)), 1.0);
}
