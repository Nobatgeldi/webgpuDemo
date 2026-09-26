import { samplerEntry, storageBufferEntry, textureEntry, uniformEntry } from '../core/bindings';
import { wrapPeriodic } from '../core/cameraRelative';
import { composeWgsl, createShaderModule } from '../core/shader';
import type { Camera } from '../render/camera';
import type { FrameUniforms } from '../render/frameUniforms';
import { DEPTH_COMPARE_CLOSER, DEPTH_FORMAT, HDR_FORMAT } from '../render/renderConfig';
import { WGSL } from '../shaders';
import type { OceanCascades } from './cascades';
import { MAX_CASCADES, OCEAN_SKIRT_DISTANCE_M, type OceanQualityConfig } from './oceanConfig';
import {
  OCEAN_VERTEX_STRIDE_FLOATS,
  buildOceanGeometry,
  computeLevelLayouts,
  ringRangeIndex,
  type IndexRange,
} from './oceanMesh';

/** Float offsets of OceanRenderUniforms and OceanLevel (shaders/ocean.wgsl); verified by tests. */
export const OCEAN_RENDER_UNIFORM_OFFSETS = { patchSizes: 0, lod: 4, mesh: 8, water: 12 } as const;
export const OCEAN_LEVEL_OFFSETS = { centre: 0, origin01: 4, origin2: 8 } as const;
export const RENDER_UNIFORM_BYTES = 64;
/** Floats per OceanLevel entry (three vec4). */
export const LEVEL_FLOATS = 12;

/** Geomorph starts at this fraction of a level's half-size. Must exceed 0.5 + 1/M. */
const MORPH_START = 0.6;
/** Cells before the level edge by which the morph must be complete (the centre may be one cell off). */
const MORPH_END_MARGIN_CELLS = 1.5;

/**
 * Diffuse albedo of light scattered back out of deep open-ocean water
 * (linear sRGB); gives the dark blue-green body colour under the reflection.
 */
const WATER_SCATTER_ALBEDO: readonly [number, number, number] = [0.004, 0.016, 0.022];
/** e-folding distance of the haze towards the horizon (m). */
const OCEAN_FOG_DISTANCE_M = 25_000;
/** Anisotropic filtering of the wave textures at grazing angles. */
const OCEAN_MAX_ANISOTROPY = 8;

/** Draws the clipmap levels of the sea surface. */
export class OceanRenderer {
  private readonly levelData: Float32Array;
  private readonly levelRanges: IndexRange[] = [];

  private constructor(
    private readonly device: GPUDevice,
    private readonly pipeline: GPURenderPipeline,
    private readonly bindGroup: GPUBindGroup,
    private readonly vertexBuffer: GPUBuffer,
    private readonly indexBuffer: GPUBuffer,
    private readonly levelBuffer: GPUBuffer,
    private readonly geometry: ReturnType<typeof buildOceanGeometry>,
    private readonly config: OceanQualityConfig,
    private readonly patchSizes: readonly number[],
  ) {
    this.levelData = new Float32Array(config.meshLevels * LEVEL_FLOATS);
  }

  static async create(
    device: GPUDevice,
    frameUniforms: FrameUniforms,
    cascades: OceanCascades,
    config: OceanQualityConfig,
  ): Promise<OceanRenderer> {
    const geometry = buildOceanGeometry(config.meshHalfCells);
    const vertexBuffer = device.createBuffer({
      label: 'ocean-vertices',
      size: geometry.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vertexBuffer, 0, geometry.vertices);
    const indexBuffer = device.createBuffer({
      label: 'ocean-indices',
      size: geometry.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(indexBuffer, 0, geometry.indices);
    const levelBuffer = device.createBuffer({
      label: 'ocean-levels',
      size: config.meshLevels * LEVEL_FLOATS * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const patchSizes = cascades.bands.map((band) => band.patchSizeM);
    const uniforms = new Float32Array(RENDER_UNIFORM_BYTES / 4);
    const u = OCEAN_RENDER_UNIFORM_OFFSETS;
    for (let c = 0; c < MAX_CASCADES; c++) {
      // Unused cascades keep a non-zero size so the shader's divisions stay finite.
      uniforms[u.patchSizes + c] = patchSizes[c] ?? 1;
    }
    uniforms[u.patchSizes + 3] = cascades.cascadeCount;
    uniforms[u.lod] = cascades.size;
    uniforms[u.lod + 1] = cascades.mipLevelCount - 1;
    uniforms[u.lod + 2] = MORPH_START;
    uniforms[u.lod + 3] = 1 - MORPH_END_MARGIN_CELLS / config.meshHalfCells;
    uniforms[u.mesh] = config.meshHalfCells;
    uniforms[u.mesh + 1] = config.meshLevels - 1;
    uniforms.set(WATER_SCATTER_ALBEDO, u.water);
    uniforms[u.water + 3] = OCEAN_FOG_DISTANCE_M;
    const uniformBuffer = device.createBuffer({
      label: 'ocean-render-uniforms',
      size: RENDER_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(uniformBuffer, 0, uniforms);

    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const layout = device.createBindGroupLayout({
      label: 'ocean-render',
      entries: [
        uniformEntry(0, VF, RENDER_UNIFORM_BYTES),
        storageBufferEntry(1, GPUShaderStage.VERTEX, 'read-only-storage'),
        textureEntry(2, VF, 'float'),
        textureEntry(3, VF, 'float'),
        samplerEntry(4, VF),
      ],
    });
    const sampler = device.createSampler({
      label: 'ocean',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      maxAnisotropy: OCEAN_MAX_ANISOTROPY,
    });
    const bindGroup = device.createBindGroup({
      label: 'ocean-render',
      layout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: { buffer: levelBuffer } },
        { binding: 2, resource: cascades.displacement.createView({ dimension: '2d-array' }) },
        { binding: 3, resource: cascades.derivatives.createView({ dimension: '2d-array' }) },
        { binding: 4, resource: sampler },
      ],
    });

    const module = await createShaderModule(
      device,
      composeWgsl('ocean', [WGSL.frame, WGSL.common, WGSL.skyCommon, WGSL.ocean]),
    );
    const pipeline = await device.createRenderPipelineAsync({
      label: 'ocean',
      layout: device.createPipelineLayout({
        label: 'ocean',
        bindGroupLayouts: [frameUniforms.bindGroupLayout, layout],
      }),
      vertex: {
        module,
        entryPoint: 'vsMain',
        buffers: [
          {
            arrayStride: OCEAN_VERTEX_STRIDE_FLOATS * Float32Array.BYTES_PER_ELEMENT,
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
          },
        ],
      },
      fragment: { module, entryPoint: 'fsMain', targets: [{ format: HDR_FORMAT }] },
      // Folding choppy crests produce back-facing triangles; they must still be drawn.
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: DEPTH_COMPARE_CLOSER,
      },
    });
    return new OceanRenderer(
      device,
      pipeline,
      bindGroup,
      vertexBuffer,
      indexBuffer,
      levelBuffer,
      geometry,
      config,
      patchSizes,
    );
  }

  /** Places the levels around the camera. Call once per frame before {@link OceanRenderer.draw}. */
  update(camera: Camera): void {
    const cameraX = camera.position[0] as number;
    const cameraZ = camera.position[2] as number;
    const layouts = computeLevelLayouts(
      cameraX,
      cameraZ,
      this.config.meshBaseSpacingM,
      this.config.meshLevels,
    );
    const d = this.levelData;
    layouts.forEach((level, l) => {
      const o = l * LEVEL_FLOATS;
      const centre = o + OCEAN_LEVEL_OFFSETS.centre;
      // Camera-relative centre and wrapped cascade origins, both computed in double precision.
      d[centre] = level.centreX - cameraX;
      d[centre + 1] = level.centreZ - cameraZ;
      d[centre + 2] = level.spacingM;
      d[centre + 3] = OCEAN_SKIRT_DISTANCE_M;
      for (let c = 0; c < MAX_CASCADES; c++) {
        // origin01.xy, origin01.zw and origin2.xy are consecutive.
        const origin = o + OCEAN_LEVEL_OFFSETS.origin01 + 2 * c;
        const size = this.patchSizes[c] ?? 1;
        d[origin] = wrapPeriodic(level.centreX, size);
        d[origin + 1] = wrapPeriodic(level.centreZ, size);
      }
      this.levelRanges[l] =
        l === 0
          ? this.geometry.fullLevel
          : (this.geometry.rings[ringRangeIndex(level.holeOffsetX, level.holeOffsetZ)] as IndexRange);
    });
    this.device.queue.writeBuffer(this.levelBuffer, 0, d);
  }

  /** Records the draws; bind group 0 (frame uniforms) must already be set. */
  draw(pass: GPURenderPassEncoder): void {
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(1, this.bindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, 'uint32');
    this.levelRanges.forEach((range, level) => {
      pass.drawIndexed(range.indexCount, 1, range.firstIndex, 0, level);
    });
    const outermost = this.levelRanges.length - 1;
    pass.drawIndexed(this.geometry.skirt.indexCount, 1, this.geometry.skirt.firstIndex, 0, outermost);
  }

  dispose(): void {
    this.vertexBuffer.destroy();
    this.indexBuffer.destroy();
    this.levelBuffer.destroy();
  }
}
