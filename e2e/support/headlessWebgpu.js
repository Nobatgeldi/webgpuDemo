// Headless Chromium with the SwiftShader software adapter loses the WebGPU
// device as soon as a canvas is presented (independent of this application; it
// also happens with a minimal WebGPU page). For the smoke test the canvas
// context is therefore redirected to an offscreen texture: every GPU pass of
// the application still runs, only the final presentation is skipped.
(() => {
  // Without presentation there is no back-pressure on requestAnimationFrame;
  // wait for the submitted GPU work so the slow software rasteriser keeps up.
  const requestFrame = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) =>
    requestFrame((time) => {
      const device = window.__smokeGpuDevice;
      if (device) device.queue.onSubmittedWorkDone().then(() => requestFrame(callback));
      else callback(time);
    });
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    if (type !== 'webgpu') return getContext.call(this, type, ...rest);
    const canvas = this;
    let device = null;
    let format = null;
    let texture = null;
    return {
      canvas,
      configure(config) {
        device = config.device;
        format = config.format;
        window.__smokeGpuDevice = device;
      },
      unconfigure() {},
      getConfiguration() {
        return { device, format };
      },
      getCurrentTexture() {
        if (!texture || texture.width !== canvas.width || texture.height !== canvas.height) {
          texture?.destroy();
          texture = device.createTexture({
            label: 'smoke-offscreen-canvas',
            size: [canvas.width, canvas.height],
            format,
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
          });
        }
        return texture;
      },
    };
  };
})();
