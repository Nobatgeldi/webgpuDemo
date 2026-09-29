import { samplerEntry, storageBufferEntry, uniformEntry } from '../core/bindings';
import { composeWgsl, createShaderModule } from '../core/shader';
import { WGSL } from '../shaders';
import type { SunState } from './atmosphereModel';

export const TRANSMITTANCE_LUT_SIZE = { width: 256, height: 64 } as const;
export const SKY_VIEW_LUT_SIZE = { width: 192, height: 128 } as const;
const LUT_FORMAT: GPUTextureFormat = 'rgba16float';
const LUT_WORKGROUP = 8;
const ATMOSPHERE_UNIFORM_BYTES = 16;
/** SkyLight struct: one vec4. */
export const SKY_LIGHT_BYTES = 16;

/**
 * Physically based sky (Hillaire 2020 style): a transmittance LUT computed
 * once, and a sky-view LUT plus the resulting sky irradiance recomputed when
 * the sun or the cloud cover changes. Scene shaders sample both through the
 * frame bind group.
 */
export class Atmosphere {
  readonly transmittanceLut: GPUTexture;
  readonly skyViewLut: GPUTexture;
  /** SkyLight (horizontal sky irradiance), read by scene shaders and auto exposure. */
  readonly skyLightBuffer: GPUBuffer;
  readonly sampler: GPUSampler;

  private readonly uniformBuffer: GPUBuffer;
  private readonly uniformData = new Float32Array(ATMOSPHERE_UNIFORM_BYTES / 4);
  private transmittanceReady = false;
  private skyDirty = true;
  private lastKey = '';

  private constructor(
    private readonly device: GPUDevice,
    private readonly pipelines: {
      transmittance: { pipeline: GPUComputePipeline; bindGroup: GPUBindGroup };
      skyView: { pipeline: GPUComputePipeline; bindGroup: GPUBindGroup };
      irradiance: { pipeline: GPUComputePipeline; bindGroup: GPUBindGroup };
    },
    resources: {
      transmittanceLut: GPUTexture;
      skyViewLut: GPUTexture;
      skyLightBuffer: GPUBuffer;
      uniformBuffer: GPUBuffer;
      sampler: GPUSampler;
    },
  ) {
    this.transmittanceLut = resources.transmittanceLut;
    this.skyViewLut = resources.skyViewLut;
    this.skyLightBuffer = resources.skyLightBuffer;
    this.uniformBuffer = resources.uniformBuffer;
    this.sampler = resources.sampler;
  }

  static async create(device: GPUDevice): Promise<Atmosphere> {
    const lut = (label: string, size: { width: number; height: number }): GPUTexture =>
      device.createTexture({
        label,
        size,
        format: LUT_FORMAT,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
      });
    const transmittanceLut = lut('atmosphere-transmittance', TRANSMITTANCE_LUT_SIZE);
    const skyViewLut = lut('atmosphere-sky-view', SKY_VIEW_LUT_SIZE);
    const skyLightBuffer = device.createBuffer({
      label: 'sky-light',
      size: SKY_LIGHT_BYTES,
      usage: GPUBufferUsage.STORAGE,
    });
    const uniformBuffer = device.createBuffer({
      label: 'atmosphere-uniforms',
      size: ATMOSPHERE_UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const sampler = device.createSampler({
      label: 'atmosphere-lut',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    const prelude = [WGSL.atmosphereConstants, WGSL.atmosphereCommon];
    const [transmittanceModule, skyViewModule, irradianceModule] = await Promise.all([
      createShaderModule(device, composeWgsl('atmosphere-transmittance', [...prelude, WGSL.atmosphereTransmittance])),
      createShaderModule(device, composeWgsl('atmosphere-sky-view', [...prelude, WGSL.atmosphereSkyView])),
      createShaderModule(device, composeWgsl('atmosphere-irradiance', [...prelude, WGSL.atmosphereIrradiance])),
    ]);
    const C = GPUShaderStage.COMPUTE;
    const storageLut: GPUBindGroupLayoutEntry = {
      binding: 0,
      visibility: C,
      storageTexture: { access: 'write-only', format: LUT_FORMAT, viewDimension: '2d' },
    };
    const lutTexture = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: C,
      texture: { sampleType: 'float', viewDimension: '2d' },
    });
    const transmittanceLayout = device.createBindGroupLayout({
      label: 'atmosphere-transmittance',
      entries: [storageLut],
    });
    const skyViewLayout = device.createBindGroupLayout({
      label: 'atmosphere-sky-view',
      entries: [
        uniformEntry(0, C, ATMOSPHERE_UNIFORM_BYTES),
        lutTexture(1),
        samplerEntry(2, C),
        { ...storageLut, binding: 3 },
      ],
    });
    const irradianceLayout = device.createBindGroupLayout({
      label: 'atmosphere-irradiance',
      entries: [lutTexture(0), samplerEntry(1, C), storageBufferEntry(2, C)],
    });
    const pipeline = (label: string, module: GPUShaderModule, layout: GPUBindGroupLayout) =>
      device.createComputePipelineAsync({
        label,
        layout: device.createPipelineLayout({ label, bindGroupLayouts: [layout] }),
        compute: { module, entryPoint: 'main' },
      });
    const [transmittancePipeline, skyViewPipeline, irradiancePipeline] = await Promise.all([
      pipeline('atmosphere-transmittance', transmittanceModule, transmittanceLayout),
      pipeline('atmosphere-sky-view', skyViewModule, skyViewLayout),
      pipeline('atmosphere-irradiance', irradianceModule, irradianceLayout),
    ]);
    const transmittanceView = transmittanceLut.createView();
    const skyViewView = skyViewLut.createView();
    return new Atmosphere(
      device,
      {
        transmittance: {
          pipeline: transmittancePipeline,
          bindGroup: device.createBindGroup({
            label: 'atmosphere-transmittance',
            layout: transmittanceLayout,
            entries: [{ binding: 0, resource: transmittanceView }],
          }),
        },
        skyView: {
          pipeline: skyViewPipeline,
          bindGroup: device.createBindGroup({
            label: 'atmosphere-sky-view',
            layout: skyViewLayout,
            entries: [
              { binding: 0, resource: { buffer: uniformBuffer } },
              { binding: 1, resource: transmittanceView },
              { binding: 2, resource: sampler },
              { binding: 3, resource: skyViewView },
            ],
          }),
        },
        irradiance: {
          pipeline: irradiancePipeline,
          bindGroup: device.createBindGroup({
            label: 'atmosphere-irradiance',
            layout: irradianceLayout,
            entries: [
              { binding: 0, resource: skyViewView },
              { binding: 1, resource: sampler },
              { binding: 2, resource: { buffer: skyLightBuffer } },
            ],
          }),
        },
      },
      { transmittanceLut, skyViewLut, skyLightBuffer, uniformBuffer, sampler },
    );
  }

  /** Sets the sun; the sky is only recomputed when it (or the cloud cover) changed. */
  setSun(sun: SunState): void {
    const sinElevation = sun.direction[1];
    const key = `${sinElevation}|${sun.overcast}`;
    if (key === this.lastKey) {
      return;
    }
    this.lastKey = key;
    this.uniformData[0] = sinElevation;
    this.uniformData[1] = Math.sqrt(Math.max(0, 1 - sinElevation * sinElevation));
    this.uniformData[2] = sun.overcast;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniformData);
    this.skyDirty = true;
  }

  /** Records pending LUT updates (nothing when the sky is unchanged). */
  encode(encoder: GPUCommandEncoder): void {
    if (this.transmittanceReady && !this.skyDirty) {
      return;
    }
    const pass = encoder.beginComputePass({ label: 'atmosphere' });
    if (!this.transmittanceReady) {
      pass.setPipeline(this.pipelines.transmittance.pipeline);
      pass.setBindGroup(0, this.pipelines.transmittance.bindGroup);
      pass.dispatchWorkgroups(
        Math.ceil(TRANSMITTANCE_LUT_SIZE.width / LUT_WORKGROUP),
        Math.ceil(TRANSMITTANCE_LUT_SIZE.height / LUT_WORKGROUP),
      );
      this.transmittanceReady = true;
    }
    pass.setPipeline(this.pipelines.skyView.pipeline);
    pass.setBindGroup(0, this.pipelines.skyView.bindGroup);
    pass.dispatchWorkgroups(
      Math.ceil(SKY_VIEW_LUT_SIZE.width / LUT_WORKGROUP),
      Math.ceil(SKY_VIEW_LUT_SIZE.height / LUT_WORKGROUP),
    );
    pass.setPipeline(this.pipelines.irradiance.pipeline);
    pass.setBindGroup(0, this.pipelines.irradiance.bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    this.skyDirty = false;
  }

  dispose(): void {
    this.transmittanceLut.destroy();
    this.skyViewLut.destroy();
    this.skyLightBuffer.destroy();
    this.uniformBuffer.destroy();
  }
}
