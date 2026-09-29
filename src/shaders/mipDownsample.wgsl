// 2x2 box downsampling of one mip level of a texture array (WebGPU has no
// automatic mipmap generation).

@group(0) @binding(0) var sourceLevel: texture_2d_array<f32>;
@group(0) @binding(1) var destinationLevel: texture_storage_2d_array<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(destinationLevel);
  if (id.x >= size.x || id.y >= size.y) {
    return;
  }
  let base = id.xy * 2u;
  let layer = id.z;
  let sum = textureLoad(sourceLevel, base, layer, 0)
    + textureLoad(sourceLevel, base + vec2<u32>(1u, 0u), layer, 0)
    + textureLoad(sourceLevel, base + vec2<u32>(0u, 1u), layer, 0)
    + textureLoad(sourceLevel, base + vec2<u32>(1u, 1u), layer, 0);
  textureStore(destinationLevel, id.xy, layer, sum * 0.25);
}
