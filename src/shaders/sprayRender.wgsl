// Spray sprites: camera-facing soft sprites, premultiplied alpha.
// Requires the scene prelude and sprayCommon.wgsl.

struct SprayRenderUniforms {
  // xyz: particle origin relative to the camera (m), w: opacity at birth
  origin: vec4<f32>,
  // x: sprite radius at birth, y: at death (m), z: droplet albedo, w: forward scattering strength
  look: vec4<f32>,
}

@group(1) @binding(0) var<uniform> sprayRender: SprayRenderUniforms;
@group(1) @binding(1) var<storage, read> sprayParticles: array<Particle>;

// Sprite size variation between particles (factor range).
const SPRITE_SIZE_MIN: f32 = 0.6;
const SPRITE_SIZE_MAX: f32 = 1.4;
// Soft Gaussian falloff: exp(-k r^2) over the unit quad.
const SPRITE_FALLOFF: f32 = 3.0;
// Henyey-Greenstein asymmetry of light scattered by droplets (strong forward peak).
const SPRAY_PHASE_G: f32 = 0.7;

struct SprayVertexOutput {
  @builtin(position) position: vec4<f32>,
  // xy: corner in [-1, 1], z: opacity
  @location(0) corner: vec3<f32>,
  @location(1) relative: vec3<f32>,
}

@vertex
fn vsMain(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> SprayVertexOutput {
  var output: SprayVertexOutput;
  let p = sprayParticles[instance];
  if (p.position.w >= p.velocity.w) {
    // Dead: outside the clip volume.
    output.position = vec4<f32>(0.0, 0.0, -1.0, 1.0);
    return output;
  }
  let corners = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0),
    vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0),
  );
  let corner = corners[vertex];
  let life = saturate(p.position.w / p.velocity.w);
  let size = mix(sprayRender.look.x, sprayRender.look.y, sqrt(life)) *
    mix(SPRITE_SIZE_MIN, SPRITE_SIZE_MAX, particleConstant(instance, 2u));
  // Camera right and up from the rows of the view rotation.
  let right = vec3<f32>(frame.view[0][0], frame.view[1][0], frame.view[2][0]);
  let up = vec3<f32>(frame.view[0][1], frame.view[1][1], frame.view[2][1]);
  let relative = p.position.xyz + sprayRender.origin.xyz + (right * corner.x + up * corner.y) * size;
  output.position = frame.viewProj * vec4<f32>(relative, 1.0);
  output.corner = vec3<f32>(corner, sprayRender.origin.w * (1.0 - life) * (1.0 - life));
  output.relative = relative;
  return output;
}

@fragment
fn fsMain(input: SprayVertexOutput) -> @location(0) vec4<f32> {
  let r2 = dot(input.corner.xy, input.corner.xy);
  if (r2 > 1.0) {
    discard;
  }
  let alpha = input.corner.z * exp(-SPRITE_FALLOFF * r2);
  let view = normalize(input.relative);
  let sunDir = frame.sunDirection.xyz;
  // Droplets scatter sunlight mostly forward (bright against the sun) plus the sky light.
  let phase = henyeyGreenstein(dot(view, sunDir), SPRAY_PHASE_G) * 4.0 * PI;
  let sun = frame.sunIrradiance.rgb * mix(1.0, phase, sprayRender.look.w);
  let radiance = sprayRender.look.z * (sun + skyIrradiance()) / PI;
  return vec4<f32>(clampHdr(radiance) * alpha, alpha);
}
