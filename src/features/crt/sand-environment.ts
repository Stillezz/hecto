import * as THREE from "three";

import { screenLightShader, type ScreenLightUniforms } from "./screen-light";

// Animated surface and opening atmosphere adapted from the MIT-licensed
// WebGL Scroll Sync V2 by Luis Alberto Martinez Riancho,
// https://codepen.io/luis-lessrain/pen/bNwBYMM.

const SAND_BASE_Y = -4.92;
const TERRAIN_SIZE = 700;
const TERRAIN_SEGMENTS = 280;

function fract(value: number) {
  return value - Math.floor(value);
}

function mix(start: number, end: number, amount: number) {
  return start + (end - start) * amount;
}

function hash(x: number, y: number) {
  return fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453123);
}

function noise(x: number, y: number) {
  const integerX = Math.floor(x);
  const integerY = Math.floor(y);
  const fractionX = fract(x);
  const fractionY = fract(y);
  const smoothX = fractionX * fractionX * (3 - 2 * fractionX);
  const smoothY = fractionY * fractionY * (3 - 2 * fractionY);
  const bottom = mix(hash(integerX, integerY), hash(integerX + 1, integerY), smoothX);
  const top = mix(hash(integerX, integerY + 1), hash(integerX + 1, integerY + 1), smoothX);
  return mix(bottom, top, smoothY);
}

function roundedRectangleDistance(
  x: number,
  z: number,
  halfWidth: number,
  halfDepth: number,
  radius: number,
) {
  const qx = Math.abs(x) - halfWidth + radius;
  const qz = Math.abs(z) - halfDepth + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qz, 0))
    + Math.min(Math.max(qx, qz), 0)
    - radius;
}

function duneMound(
  worldX: number,
  worldZ: number,
  centerX: number,
  centerZ: number,
  radiusX: number,
  radiusZ: number,
  height: number,
  rotation: number,
) {
  const offsetX = worldX - centerX;
  const offsetZ = worldZ - centerZ;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const localX = offsetX * cosine - offsetZ * sine;
  const localZ = offsetX * sine + offsetZ * cosine;
  const ellipticalDistance = (localX / radiusX) ** 2 + (localZ / radiusZ) ** 2;

  if (ellipticalDistance >= 1) {
    return 0;
  }

  const mound = 1 - THREE.MathUtils.smoothstep(ellipticalDistance, 0.08, 1);
  const organicVariation = 0.88
    + noise(worldX * 0.31 + centerX, worldZ * 0.31 - centerZ) * 0.22;

  return mound * height * organicVariation;
}

function terrainBaseHeight(worldX: number, worldZ: number) {
  const distance = Math.hypot(worldX, worldZ);
  const distantBlend = THREE.MathUtils.smoothstep(distance, 30, 205);
  const distantDunes = (
    (noise(worldX * 0.012 - 19.2, worldZ * 0.012 + 4.8) - 0.5) * 7.2
    + (noise(worldX * 0.027 + 7.1, worldZ * 0.027 - 12.7) - 0.5) * 2.1
  ) * distantBlend;
  const footprintDistance = roundedRectangleDistance(
    worldX,
    worldZ + 2.8,
    7,
    3.8,
    1.55,
  );
  const contactBlend = 1 - THREE.MathUtils.smoothstep(footprintDistance, -0.45, 3.1);
  const outside = THREE.MathUtils.smoothstep(footprintDistance, -0.08, 0.38);
  const packedRidge = Math.exp(-1 * ((footprintDistance - 0.68) / 1.32) ** 2)
    * 0.24
    * outside;
  const irregularEdge = (noise(worldX * 0.72 + 2.4, worldZ * 0.72 - 6.1) - 0.5)
    * 0.08
    * contactBlend
    * outside;

  // Uneven banks where wind-blown sand has accumulated against the CRT over
  // time. These are part of the main terrain geometry, so the same material,
  // lighting, grain and ripple displacement continue across them.
  const accumulatedDunes =
    duneMound(worldX, worldZ, -5.25, 0.25, 4.25, 2.85, 0.86, -0.18)
    + duneMound(worldX, worldZ, 4.75, 0.15, 4.5, 3.0, 0.94, 0.16)
    + duneMound(worldX, worldZ, 0.15, 1.05, 6.1, 2.35, 0.42, 0.04)
    + duneMound(worldX, worldZ, -6.2, -2.25, 2.45, 4.5, 0.58, -0.1)
    + duneMound(worldX, worldZ, 6.05, -2.55, 2.55, 4.8, 0.7, 0.12)
    // The rear bank is deliberately broader and taller than the exposed front
    // piles, suggesting years of wind-driven buildup against the casing.
    + duneMound(worldX, worldZ, 0.0, -6.85, 11.5, 3.8, 1.02, 0.02)
    + duneMound(worldX, worldZ, -7.15, -5.95, 4.55, 3.75, 1.22, -0.14)
    + duneMound(worldX, worldZ, 7.15, -6.1, 4.75, 3.95, 1.42, 0.17)
    + duneMound(worldX, worldZ, 0.4, -8.15, 7.2, 2.8, 0.68, -0.03);

  return mix(distantDunes, -0.1, contactBlend)
    + packedRidge
    + irregularEdge
    + accumulatedDunes;
}

const skyVertexShader = /* glsl */ `
  varying vec3 vSkyWorldPosition;

  void main() {
    vSkyWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const skyFragmentShader = /* glsl */ `
  precision highp float;

  uniform vec2 uResolution;
  uniform float uTime;
  uniform float uSkyTransition;
  varying vec3 vSkyWorldPosition;

  float starHash(vec2 point) {
    return fract(sin(dot(point, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float movingStarLayer(
    vec2 fragment,
    float cellSize,
    float starSize,
    float activeChance,
    float speed,
    float seed
  ) {
    // The source repeats each box-shadow field after a 2000px vertical travel.
    vec2 movingPoint = mod(
      fragment - vec2(0.0, uTime * speed),
      vec2(2000.0)
    );
    vec2 cell = floor(movingPoint / cellSize);
    vec2 localPoint = mod(movingPoint, cellSize);
    float enabled = step(
      starHash(cell + vec2(seed, seed * 1.73)),
      activeChance
    );
    vec2 randomPosition = vec2(
      starHash(cell + vec2(seed * 2.13, 17.17)),
      starHash(cell + vec2(43.71, seed * 3.07))
    ) * cellSize;
    vec2 distanceToStar = abs(localPoint - randomPosition);
    float squareDistance = max(distanceToStar.x, distanceToStar.y);

    return enabled * (
      1.0 - smoothstep(starSize * 0.42, starSize * 0.5 + 0.8, squareDistance)
    );
  }

  void main() {
    vec2 uv = (gl_FragCoord.xy - uResolution * 0.5) / uResolution.y;
    vec3 screenDirection = normalize(vec3(uv.x, uv.y - 0.22, -1.4));
    vec3 worldDirection = normalize(vSkyWorldPosition - cameraPosition);
    vec3 direction = normalize(mix(
      screenDirection,
      worldDirection,
      uSkyTransition
    ));
    vec3 skyTop = vec3(0.045, 0.052, 0.115);
    vec3 skyHorizon = vec3(0.36, 0.325, 0.43);
    vec3 moonColor = vec3(0.69, 0.74, 0.90);
    vec3 originalHorizonColor = vec3(0.84, 0.73, 0.77);
    vec3 responsiveHorizonColor = vec3(0.58, 0.57, 0.70);
    vec3 fogColor = vec3(0.20, 0.205, 0.30);
    float height = clamp(direction.y, 0.0, 1.0);
    vec3 color = mix(skyHorizon, skyTop, pow(height, 0.42));
    vec3 moonDirection = normalize(vec3(-0.58, 0.055, -1.0));
    float moonFacing = max(dot(direction, moonDirection), 0.0);

    // Only the broad moonlit atmosphere is rendered. Concentrated disk and
    // core terms stay absent, keeping the light source itself invisible.
    color += moonColor * pow(moonFacing, 5.0) * 0.10;
    color += moonColor * pow(moonFacing, 2.0) * 0.04;
    // Preserve the original bright screen-space horizon at rest. As the camera
    // closes in, blend only that atmospheric treatment toward a broad,
    // world-aligned glow so the newly exposed sky stays cohesive.
    float originalHorizonBand = exp(-abs(screenDirection.y) * 22.0);
    float originalHorizonMist = exp(-abs(screenDirection.y) * 44.0);
    vec3 originalHorizonGlow =
      originalHorizonColor * originalHorizonBand * 0.34
      + fogColor * originalHorizonMist * 0.15;
    float responsiveHorizonBand = exp(-abs(worldDirection.y) * 5.5);
    float responsiveHorizonMist = exp(-abs(worldDirection.y) * 13.0);
    vec3 responsiveHorizonGlow =
      responsiveHorizonColor * responsiveHorizonBand * 0.085
      + fogColor * responsiveHorizonMist * 0.07;
    color += mix(
      originalHorizonGlow,
      responsiveHorizonGlow,
      uSkyTransition
    );

    // Match the pasted source's 700/200/100-star layers. The cell/chance pairs
    // produce those exact expected counts per repeating 2000x2000 field, while
    // the speeds preserve its 50s, 100s and 150s upward animation durations.
    float smallStars = movingStarLayer(
      gl_FragCoord.xy,
      50.0,
      1.0,
      0.4375,
      40.0,
      11.0
    );
    float mediumStars = movingStarLayer(
      gl_FragCoord.xy,
      100.0,
      2.0,
      0.5,
      20.0,
      29.0
    );
    float largeStars = movingStarLayer(
      gl_FragCoord.xy,
      200.0,
      3.0,
      1.0,
      13.333333,
      47.0
    );
    float skyStarMask = mix(
      0.68,
      1.0,
      smoothstep(-0.16, 0.11, worldDirection.y)
    );
    vec3 starColor = vec3(0.91, 0.94, 1.0);
    color += starColor
      * (smallStars * 0.66 + mediumStars * 0.82 + largeStars)
      * skyStarMask;
    gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
  }
`;

const sourceWaveShader = /* glsl */ `
  float sourceHash(vec2 point) {
    return fract(sin(dot(point, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float sourceNoise(vec2 point) {
    vec2 cell = floor(point);
    vec2 local = fract(point);
    local = local * local * (3.0 - 2.0 * local);
    float a = sourceHash(cell);
    float b = sourceHash(cell + vec2(1.0, 0.0));
    float c = sourceHash(cell + vec2(0.0, 1.0));
    float d = sourceHash(cell + vec2(1.0, 1.0));
    return mix(mix(a, b, local.x), mix(c, d, local.x), local.y);
  }

  float sourceWaveHeight(vec2 point, float time) {
    vec2 p = point * 0.72;
    float height = 0.0;
    vec2 swellDirection = normalize(vec2(1.0, 0.35));
    float alongSwell = dot(p, swellDirection);

    height += 0.090 * sin(alongSwell * 0.80 + time * 0.60);
    height += 0.128 * sin(p.x * 0.70 + time * 0.55 + p.y * 0.28);
    height += 0.077 * sin(p.x * 1.60 - time * 0.82 + p.y * 0.72);
    height += 0.051 * sin(p.x * 3.10 + time * 1.15 - p.y * 0.50);
    height += 0.032 * sin(p.x * 5.50 - time * 1.70 + p.y * 1.30);
    height += 0.016 * sin(p.x * 8.60 + time * 2.20 + p.y * 1.95);
    height += sourceNoise(p * 18.0 + vec2(time * 0.35, time * 0.12)) * 0.010;
    return height;
  }

  float sourceRoundedFootprint(vec2 point) {
    vec2 q = abs(point - vec2(0.0, -2.8)) - vec2(7.0, 3.8) + 1.55;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 1.55;
  }

  float sourceStaticShadow(vec2 point) {
    vec2 shadowAxis = normalize(vec2(0.52, 0.85));
    vec2 shadowOffset = point - vec2(-0.25, 0.45);
    float alongShadow = dot(shadowOffset, shadowAxis);
    float acrossShadow = dot(shadowOffset, vec2(-shadowAxis.y, shadowAxis.x));
    float shadowProgress = clamp(alongShadow / 6.2, 0.0, 1.0);
    float shadowHalfWidth = mix(10.4, 4.8, shadowProgress);
    float longitudinalMask = smoothstep(-1.25, 0.1, alongShadow)
      * (1.0 - smoothstep(4.35, 6.2, alongShadow));
    float lateralMask = 1.0 - smoothstep(
      0.62,
      1.0,
      abs(acrossShadow) / shadowHalfWidth
    );
    float castShadow = longitudinalMask
      * lateralMask
      * mix(0.78, 0.34, shadowProgress);
    vec2 contactPoint = (point - vec2(0.25, 1.15)) / vec2(10.1, 1.25);
    float contact = 1.0 - smoothstep(0.38, 1.0, length(contactPoint));
    return clamp(max(castShadow, contact * 0.72), 0.0, 1.0);
  }

  float sourceWaveMask(vec2 point) {
    return smoothstep(-1.15, -0.05, sourceRoundedFootprint(point));
  }
`;

const dustVertexShader = /* glsl */ `
  uniform float uTime;

  attribute float aOpacity;
  attribute float aPhase;
  attribute float aSize;
  attribute float aSpeed;
  attribute float aWander;

  varying float vDustOpacity;
  varying vec3 vDustWorldPosition;

  void main() {
    // Project the combined ripple flow into the same down-left screen direction
    // seen across the foreground dunes. The positive Z component carries dust
    // toward the camera while negative X moves it left.
    vec3 windDirection = normalize(vec3(-1.0, 0.0, 1.15));
    vec3 crossDirection = vec3(-windDirection.z, 0.0, windDirection.x);
    float travelLength = 115.0;
    float alongWind = mod(position.x + aPhase + uTime * aSpeed, travelLength)
      - travelLength * 0.5;
    float verticalWander = sin(
      alongWind * 0.085 + aWander * 6.2831853 + uTime * (0.34 + aSpeed * 0.04)
    ) * mix(0.05, 0.32, aWander);
    vec3 worldPosition = windDirection * alongWind
      + crossDirection * position.z
      + vec3(0.0, position.y + verticalWander, -2.5);
    vDustWorldPosition = worldPosition;
    vec4 viewPosition = modelViewMatrix * vec4(worldPosition, 1.0);
    float perspectiveSize = 108.0 / max(8.0, -viewPosition.z);

    gl_PointSize = clamp(aSize * perspectiveSize, 1.15, 6.2);
    gl_Position = projectionMatrix * viewPosition;
    vDustOpacity = aOpacity
      * (1.0 - smoothstep(76.0, 138.0, -viewPosition.z));
  }
`;

const dustFragmentShader = /* glsl */ `
  precision highp float;

  uniform vec3 uDustColor;
  varying float vDustOpacity;
  varying vec3 vDustWorldPosition;

  ${screenLightShader}

  void main() {
    vec2 point = gl_PointCoord - 0.5;
    float particle = 1.0 - smoothstep(0.12, 0.5, length(point));

    if (particle <= 0.001) {
      discard;
    }

    // A mote has no meaningful normal, so it is treated as facing the camera.
    // Grains drifting through the beam in front of the glass pick the screen
    // colour up strongly, which is what reads as light hanging in the air.
    vec3 towardCamera = normalize(cameraPosition - vDustWorldPosition);
    vec3 litDust = uDustColor
      + hectoScreenLight(vDustWorldPosition, towardCamera) * 1.85;

    gl_FragColor = vec4(litDust, particle * vDustOpacity);
  }
`;

export function createSandEnvironment(screenLight: ScreenLightUniforms) {
  const root = new THREE.Group();
  const geometry = new THREE.PlaneGeometry(
    TERRAIN_SIZE,
    TERRAIN_SIZE,
    TERRAIN_SEGMENTS,
    TERRAIN_SEGMENTS,
  );
  const positions = geometry.attributes.position;
  const colors = new Float32Array(positions.count * 3);
  const sandColor = new THREE.Color();

  for (let index = 0; index < positions.count; index += 1) {
    const normalizedX = positions.getX(index) / (TERRAIN_SIZE * 0.5);
    const normalizedZ = -positions.getY(index) / (TERRAIN_SIZE * 0.5);
    const worldX = Math.sign(normalizedX)
      * Math.pow(Math.abs(normalizedX), 1.72)
      * TERRAIN_SIZE
      * 0.5;
    const worldZ = Math.sign(normalizedZ)
      * Math.pow(Math.abs(normalizedZ), 1.72)
      * TERRAIN_SIZE
      * 0.5;
    const height = terrainBaseHeight(worldX, worldZ);
    const grain = noise(worldX * 0.48 + 3.1, worldZ * 0.48 - 7.8) - 0.5;
    const lightness = THREE.MathUtils.clamp(0.52 + grain * 0.055, 0.46, 0.59);

    positions.setXYZ(index, worldX, -worldZ, height);
    sandColor.setHSL(0.64 + grain * 0.01, 0.13, lightness);
    sandColor.toArray(colors, index * 3);
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();

  const time = { value: 0 };
  const material = new THREE.MeshStandardMaterial({
    color: 0xb9b4bd,
    metalness: 0,
    roughness: 0.92,
    vertexColors: true,
  });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSandTime = time;
    Object.assign(shader.uniforms, screenLight);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform float uSandTime;
        varying vec3 vSourceSandWorldPosition;
        ${sourceWaveShader}`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vec2 sourcePoint = vec2(position.x, -position.y);
        transformed.z += sourceWaveHeight(sourcePoint, uSandTime)
          * sourceWaveMask(sourcePoint);`,
      )
      .replace(
        "#include <project_vertex>",
        `#include <project_vertex>
        vSourceSandWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform float uSandTime;
        varying vec3 vSourceSandWorldPosition;
        ${sourceWaveShader}
        ${screenLightShader}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        float sourceGrain = sourceNoise(vSourceSandWorldPosition.xz * 22.0);
        diffuseColor.rgb *= mix(0.88, 1.08, sourceGrain);`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
        float sourceStep = 0.025;
        vec2 sourcePoint = vSourceSandWorldPosition.xz;
        float sourceLeft = sourceWaveHeight(sourcePoint - vec2(sourceStep, 0.0), uSandTime);
        float sourceRight = sourceWaveHeight(sourcePoint + vec2(sourceStep, 0.0), uSandTime);
        float sourceDown = sourceWaveHeight(sourcePoint - vec2(0.0, sourceStep), uSandTime);
        float sourceUp = sourceWaveHeight(sourcePoint + vec2(0.0, sourceStep), uSandTime);
        vec3 sourceNormalWorld = normalize(vec3(
          -(sourceRight - sourceLeft) / (2.0 * sourceStep),
          1.0,
          -(sourceUp - sourceDown) / (2.0 * sourceStep)
        ));
        vec3 sourceNormalView = normalize(mat3(viewMatrix) * sourceNormalWorld);
        float sourceNormalBlend = sourceWaveMask(sourcePoint) * 0.84;
        normal = normalize(mix(normal, sourceNormalView, sourceNormalBlend));`,
      )
      .replace(
        "#include <opaque_fragment>",
        `float sourceContactShadow = sourceStaticShadow(vSourceSandWorldPosition.xz);
        outgoingLight *= 1.0 - sourceContactShadow * 0.92;
        // Added after the contact shadow so the pool of screen light fills the
        // darkened sand right under the bezel instead of being cut away with it.
        outgoingLight += hectoScreenLight(
          vSourceSandWorldPosition,
          hectoWorldNormalFromView(normal)
        ) * diffuseColor.rgb;
        #include <opaque_fragment>`,
      );
  };
  material.customProgramCacheKey = () => "hecto-source-sand-v4";

  const sand = new THREE.Mesh(geometry, material);
  sand.position.y = SAND_BASE_Y;
  sand.rotation.x = -Math.PI / 2;
  sand.receiveShadow = true;
  root.add(sand);

  // Translate the pasted source's four CSS particle fields into true 3D dust.
  // Preserve the source's relative layer ratios and 50s/100s/150s/600s loop
  // durations, using twice its original density for a readable dust field.
  const dustLayers = [
    { count: 1400, duration: 50, opacity: 0.64, size: 1 },
    { count: 400, duration: 100, opacity: 0.72, size: 2 },
    { count: 200, duration: 150, opacity: 0.78, size: 3 },
    { count: 1200, duration: 600, opacity: 0.48, size: 1 },
  ];
  const dustCount = dustLayers.reduce((total, layer) => total + layer.count, 0);
  const dustPositions = new Float32Array(dustCount * 3);
  const dustOpacities = new Float32Array(dustCount);
  const dustPhases = new Float32Array(dustCount);
  const dustSizes = new Float32Array(dustCount);
  const dustSpeeds = new Float32Array(dustCount);
  const dustWanders = new Float32Array(dustCount);
  let dustRandomState = 0x5f3759df;

  function dustRandom() {
    dustRandomState = (Math.imul(dustRandomState, 1664525) + 1013904223) >>> 0;
    return dustRandomState / 4294967296;
  }

  let dustIndex = 0;

  for (const layer of dustLayers) {
    const layerSpeed = 115 / layer.duration;

    for (let index = 0; index < layer.count; index += 1) {
      const heightDistribution = dustRandom() ** 2.65;
      dustPositions[dustIndex * 3] = dustRandom() * 115;
      dustPositions[dustIndex * 3 + 1] = -3.75 + heightDistribution * 10.0;
      dustPositions[dustIndex * 3 + 2] = (dustRandom() - 0.5) * 115;
      dustOpacities[dustIndex] = layer.opacity * (0.62 + dustRandom() * 0.38);
      dustPhases[dustIndex] = dustRandom() * 115;
      dustSizes[dustIndex] = layer.size * (0.72 + dustRandom() * 0.55);
      dustSpeeds[dustIndex] = layerSpeed;
      dustWanders[dustIndex] = dustRandom();
      dustIndex += 1;
    }
  }

  const dustGeometry = new THREE.BufferGeometry();
  dustGeometry.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
  dustGeometry.setAttribute("aOpacity", new THREE.BufferAttribute(dustOpacities, 1));
  dustGeometry.setAttribute("aPhase", new THREE.BufferAttribute(dustPhases, 1));
  dustGeometry.setAttribute("aSize", new THREE.BufferAttribute(dustSizes, 1));
  dustGeometry.setAttribute("aSpeed", new THREE.BufferAttribute(dustSpeeds, 1));
  dustGeometry.setAttribute("aWander", new THREE.BufferAttribute(dustWanders, 1));

  const dustMaterial = new THREE.ShaderMaterial({
    blending: THREE.NormalBlending,
    depthTest: false,
    depthWrite: false,
    fragmentShader: dustFragmentShader,
    transparent: true,
    uniforms: {
      uDustColor: { value: new THREE.Color(0xb9b4bd) },
      uTime: time,
      ...screenLight,
    },
    vertexShader: dustVertexShader,
  });
  const dust = new THREE.Points(dustGeometry, dustMaterial);
  dust.frustumCulled = false;
  dust.renderOrder = 4;
  root.add(dust);

  const skyResolution = new THREE.Vector2(1, 1);
  const skyTransition = { value: 0 };
  const skyMaterial = new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    fog: false,
    fragmentShader: skyFragmentShader,
    side: THREE.BackSide,
    toneMapped: false,
    uniforms: {
      uResolution: { value: skyResolution },
      uSkyTransition: skyTransition,
      uTime: time,
    },
    vertexShader: skyVertexShader,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(180, 48, 32), skyMaterial);
  sky.renderOrder = -100;
  root.add(sky);

  return { root, skyResolution, skyTransition, time };
}
