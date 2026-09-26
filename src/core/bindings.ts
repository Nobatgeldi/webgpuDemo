/**
 * Terse constructors for explicit bind group layout entries. Explicit layouts
 * (rather than layout: 'auto') make the sample types of float32 textures
 * unambiguous and let several pipelines share one layout.
 */

export function uniformEntry(
  binding: number,
  visibility: GPUShaderStageFlags,
  minBindingSize: number,
): GPUBindGroupLayoutEntry {
  return { binding, visibility, buffer: { type: 'uniform', minBindingSize } };
}

export function storageBufferEntry(
  binding: number,
  visibility: GPUShaderStageFlags,
  type: GPUBufferBindingType = 'storage',
): GPUBindGroupLayoutEntry {
  return { binding, visibility, buffer: { type } };
}

export function textureEntry(
  binding: number,
  visibility: GPUShaderStageFlags,
  sampleType: GPUTextureSampleType,
  viewDimension: GPUTextureViewDimension = '2d-array',
): GPUBindGroupLayoutEntry {
  return { binding, visibility, texture: { sampleType, viewDimension } };
}

export function storageTextureEntry(
  binding: number,
  format: GPUTextureFormat,
  viewDimension: GPUTextureViewDimension = '2d-array',
): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility: GPUShaderStage.COMPUTE,
    storageTexture: { access: 'write-only', format, viewDimension },
  };
}

export function samplerEntry(
  binding: number,
  visibility: GPUShaderStageFlags,
  type: GPUSamplerBindingType = 'filtering',
): GPUBindGroupLayoutEntry {
  return { binding, visibility, sampler: { type } };
}
