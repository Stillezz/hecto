import * as THREE from "three";

// The CRT face is described once, here, as a rectangular area emitter, and that
// description is shared by every surface that needs to react to it: the sand,
// the casing and the airborne dust. Nothing in the scene is a real THREE light.
// A PointLight at the tube would light the buried rear housing just as brightly
// as the dunes in front of the glass, and a RectAreaLight cannot reach the raw
// ShaderMaterial the dust uses, so the spill is evaluated analytically instead.

export type ScreenLightUniforms = {
  uScreenLightCenter: { value: THREE.Vector3 };
  uScreenLightRight: { value: THREE.Vector3 };
  uScreenLightUp: { value: THREE.Vector3 };
  uScreenLightNormal: { value: THREE.Vector3 };
  uScreenLightHalfSize: { value: THREE.Vector2 };
  uScreenLightColor: { value: THREE.Color };
  uScreenLightIntensity: { value: number };
  uScreenLightRange: { value: number };
};

// Slightly inside the 13.0 x 9.36 screen plane, so the emitter matches the lit
// area left by the rounded aperture mask rather than the full quad.
const EMITTER_HALF_WIDTH = 6.1;
const EMITTER_HALF_HEIGHT = 4.35;

// The sand sits 4.78 units below the tube, so anything much shorter than this
// dies before the light has travelled far enough forward to read as a pool. The
// distance cutoff below still closes it out before the far dunes.
const EMITTER_RANGE = 9.0;

export function createScreenLightUniforms(): ScreenLightUniforms {
  return {
    uScreenLightCenter: { value: new THREE.Vector3(0, 0, 0.98) },
    uScreenLightRight: { value: new THREE.Vector3(1, 0, 0) },
    uScreenLightUp: { value: new THREE.Vector3(0, 1, 0) },
    uScreenLightNormal: { value: new THREE.Vector3(0, 0, 1) },
    uScreenLightHalfSize: {
      value: new THREE.Vector2(EMITTER_HALF_WIDTH, EMITTER_HALF_HEIGHT),
    },
    uScreenLightColor: { value: new THREE.Color(0.62, 0.72, 0.95) },
    uScreenLightIntensity: { value: 0 },
    uScreenLightRange: { value: EMITTER_RANGE },
  };
}

const screenLightAxes = {
  right: new THREE.Vector3(),
  up: new THREE.Vector3(),
  normal: new THREE.Vector3(),
};

// The CRT group straightens as the camera closes in, so the emitter frame has to
// be re-read from the screen mesh every time the scene is drawn.
export function updateScreenLightTransform(
  uniforms: ScreenLightUniforms,
  screen: THREE.Object3D,
) {
  screen.updateWorldMatrix(true, false);
  screen.matrixWorld.extractBasis(
    screenLightAxes.right,
    screenLightAxes.up,
    screenLightAxes.normal,
  );
  uniforms.uScreenLightCenter.value.setFromMatrixPosition(screen.matrixWorld);
  uniforms.uScreenLightRight.value.copy(screenLightAxes.right).normalize();
  uniforms.uScreenLightUp.value.copy(screenLightAxes.up).normalize();
  uniforms.uScreenLightNormal.value.copy(screenLightAxes.normal).normalize();
}

export const screenLightShader = /* glsl */ `
  uniform vec3 uScreenLightCenter;
  uniform vec3 uScreenLightRight;
  uniform vec3 uScreenLightUp;
  uniform vec3 uScreenLightNormal;
  uniform vec2 uScreenLightHalfSize;
  uniform vec3 uScreenLightColor;
  uniform float uScreenLightIntensity;
  uniform float uScreenLightRange;

  // Irradiance arriving from the tube, shaded against the closest point on the
  // emitting rectangle. Using the closest point rather than the centre keeps the
  // falloff right both for sand directly beneath the bezel, where the screen
  // subtends most of the sky, and for dunes far enough away that it reads as a
  // point source.
  vec3 hectoScreenLight(vec3 worldPosition, vec3 worldNormal) {
    if (uScreenLightIntensity <= 0.0) {
      return vec3(0.0);
    }

    vec3 offset = worldPosition - uScreenLightCenter;
    vec2 planar = clamp(
      vec2(dot(offset, uScreenLightRight), dot(offset, uScreenLightUp)),
      -uScreenLightHalfSize,
      uScreenLightHalfSize
    );
    vec3 emitterPoint = uScreenLightCenter
      + uScreenLightRight * planar.x
      + uScreenLightUp * planar.y;
    vec3 toFragment = worldPosition - emitterPoint;
    float distanceToEmitter = length(toFragment);
    vec3 direction = toFragment / max(distanceToEmitter, 0.0001);

    // Light only leaves the front of the glass, so the rear housing and the sand
    // banked up behind the CRT stay unlit no matter how close they are. The tube
    // face is convex, though, so a flat lambertian panel is too strict: a little
    // bleed past the plane keeps the sand at the foot of the bezel from cutting
    // to black exactly where the two meet.
    float emitterFacing = clamp(
      (dot(direction, uScreenLightNormal) + 0.1) / 1.1,
      0.0,
      1.0
    );

    // Sand scatters enough that a hard terminator reads as plastic. Wrapping the
    // diffuse term keeps the rim of the pool soft where it climbs the dunes.
    float surfaceFacing = clamp(
      (dot(worldNormal, -direction) + 0.22) / 1.22,
      0.0,
      1.0
    );

    float normalizedDistance = distanceToEmitter / uScreenLightRange;
    float attenuation = 1.0 / (1.0 + normalizedDistance * normalizedDistance);
    // Inverse square never reaches zero. Closing it out well inside the terrain
    // stops a faint wash from creeping across the distant dunes.
    attenuation *= 1.0 - smoothstep(1.7, 3.4, normalizedDistance);

    return uScreenLightColor
      * uScreenLightIntensity
      * emitterFacing
      * surfaceFacing
      * attenuation;
  }

  // viewMatrix is orthonormal in its rotation block, so multiplying from the left
  // transposes it and takes the shading normal back into world space.
  vec3 hectoWorldNormalFromView(vec3 viewNormal) {
    return normalize((vec4(viewNormal, 0.0) * viewMatrix).xyz);
  }
`;

export type ScreenEmission = {
  color: THREE.Color;
  luminance: number;
};

// Reduce the screen artwork to the single colour and strength the emitter should
// throw. Pixels are weighted by their own luminance so a mostly dark screen with
// a bright amber panel casts amber light rather than a muddy average grey.
export function readScreenEmission(
  image: TexImageSource,
  crop: { x: number; y: number; width: number; height: number },
): ScreenEmission | null {
  const sampleWidth = 64;
  const sampleHeight = 46;
  const canvas = document.createElement("canvas");
  canvas.width = sampleWidth;
  canvas.height = sampleHeight;

  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (!context) {
    return null;
  }

  context.drawImage(
    image as CanvasImageSource,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    sampleWidth,
    sampleHeight,
  );

  const { data } = context.getImageData(0, 0, sampleWidth, sampleHeight);
  const pixelCount = sampleWidth * sampleHeight;
  let weightedRed = 0;
  let weightedGreen = 0;
  let weightedBlue = 0;
  let totalWeight = 0;
  let totalLuminance = 0;

  for (let index = 0; index < pixelCount; index += 1) {
    const red = data[index * 4] / 255;
    const green = data[index * 4 + 1] / 255;
    const blue = data[index * 4 + 2] / 255;
    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    const weight = luminance * luminance;

    weightedRed += red * weight;
    weightedGreen += green * weight;
    weightedBlue += blue * weight;
    totalWeight += weight;
    totalLuminance += luminance;
  }

  const color = new THREE.Color();

  if (totalWeight <= 0.0001) {
    // A black screen still has a phosphor colour; fall back to the tube's tint
    // so the emitter never turns an unrelated hue when it fades back up.
    color.setRGB(0.62, 0.72, 0.95, THREE.SRGBColorSpace);
    return { color, luminance: 0 };
  }

  color.setRGB(
    weightedRed / totalWeight,
    weightedGreen / totalWeight,
    weightedBlue / totalWeight,
    THREE.SRGBColorSpace,
  );

  // Keep the hue but drop the brightness out of the colour, so strength stays a
  // single knob on the uniform rather than being baked into two places.
  const brightestChannel = Math.max(color.r, color.g, color.b);

  if (brightestChannel > 0.0001) {
    color.multiplyScalar(1 / brightestChannel);
  }

  // The artwork is mostly unlit phosphor, so its mean luminance sits near 0.06.
  // Taken literally that produces no visible spill at all, and it is not what the
  // eye does with a bright panel on a dark screen in a dark desert. The square
  // root pulls the measurement onto a perceptual curve while still letting a
  // brighter screen throw proportionally more light.
  return { color, luminance: Math.sqrt(totalLuminance / pixelCount) };
}
