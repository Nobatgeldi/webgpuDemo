// Spray particle simulation: bow spray and slamming spray thrown up by the
// hull. Spawning from the emitters of this frame into a ring of particles,
// gravity, drag towards the wind, death on hitting the water.
// Positions are relative to a particle origin near the ship (m).
// Requires oceanSampling.wgsl and sprayCommon.wgsl.

const SPRAY_MAX_EMITTERS: u32 = 4u;
// Fixed-point iterations for the water height under a particle.
const SPRAY_WATER_ITERATIONS: u32 = 2u;

struct SprayUpdateUniforms {
  // Particle origin wrapped per cascade and the patch sizes.
  ocean: OceanSamplingFrame,
  // xyz: shift of the particle origin since the last update (m), w: time step (s)
  shift: vec4<f32>,
  // xyz: wind velocity at spray height (m/s), w: gravitational acceleration (m/s^2)
  wind: vec4<f32>,
  // x: particle capacity, y: emitter count, z: random seed, w: unused
  params: vec4<f32>,
  // x, y: lifetime range (s), z, w: drag time constant range (s)
  variation: vec4<f32>,
  // Per emitter: xyz position (m), w: position spread (m)
  emitterPositions: array<vec4<f32>, 4>,
  // Per emitter: xyz mean velocity (m/s), w: velocity spread (m/s)
  emitterVelocities: array<vec4<f32>, 4>,
  // Per emitter: x: first particle index, y: particle count
  emitterRanges: array<vec4<u32>, 4>,
}

@group(0) @binding(0) var<uniform> spray: SprayUpdateUniforms;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(2) var displacementTexture: texture_2d_array<f32>;
@group(0) @binding(3) var displacementSampler: sampler;

@compute @workgroup_size(64)
fn csUpdate(@builtin(global_invocation_id) id: vec3<u32>) {
  let capacity = u32(spray.params.x);
  let index = id.x;
  if (index >= capacity) {
    return;
  }
  let seed = u32(spray.params.z);
  var p = particles[index];

  // Spawn: each emitter owns a contiguous range of the ring this frame.
  let emitterCount = u32(spray.params.y);
  for (var e = 0u; e < SPRAY_MAX_EMITTERS; e++) {
    if (e >= emitterCount) {
      break;
    }
    let range = spray.emitterRanges[e];
    if ((index + capacity - range.x) % capacity < range.y) {
      let origin = spray.emitterPositions[e];
      let velocity = spray.emitterVelocities[e];
      p.position = vec4<f32>(origin.xyz + origin.w * randomNormal3(index, seed, 0u), 0.0);
      let lifetime = mix(spray.variation.x, spray.variation.y, random01(index, seed, 8u));
      p.velocity = vec4<f32>(velocity.xyz + velocity.w * randomNormal3(index, seed, 4u), lifetime);
      particles[index] = p;
      return;
    }
  }

  if (p.position.w >= p.velocity.w) {
    return;
  }
  let dt = spray.shift.w;
  let dragTime = mix(spray.variation.z, spray.variation.w, particleConstant(index, 1u));
  var velocity = p.velocity.xyz;
  // Semi-implicit drag towards the wind velocity.
  velocity = (velocity + dt * (spray.wind.xyz / dragTime - vec3<f32>(0.0, spray.wind.w, 0.0))) / (1.0 + dt / dragTime);
  let position = p.position.xyz + velocity * dt - spray.shift.xyz;
  var age = p.position.w + dt;
  if (velocity.y < 0.0) {
    let water = oceanHeightAt(displacementTexture, displacementSampler, spray.ocean, position.xz, SPRAY_WATER_ITERATIONS);
    if (position.y < water) {
      age = p.velocity.w;
    }
  }
  particles[index] = Particle(vec4<f32>(position, age), vec4<f32>(velocity, p.velocity.w));
}
