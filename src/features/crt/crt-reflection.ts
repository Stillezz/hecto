// Front-surface reflection for the CRT glass.
//
// The Fresnel treatment and the reflect-then-sample structure are adapted from
// the MIT-licensed "It Is All Just a Reflection" by Matthias Hurrle (@atzedent),
// https://codepen.io/atzedent/pen/PovvpvR. That pen raymarches a sphere and
// samples a procedural sky along the bounced ray; the same idea works here
// without any marching, because the surface being reflected off is a single
// known quad.
//
// The environment is evaluated procedurally from the reflected direction rather
// than from a CubeCamera. A cube map would cost six scene renders per frame to
// show what is, from the hero framing, almost entirely sky. The palette
// constants below are the ones the sky in sand-environment.ts is built from, so
// what the glass shows agrees with what is actually behind the camera.

export type ScreenReflectionUniforms = {
  uReflectionStrength: { value: number };
  uReflectionCurvature: { value: number };
};

export function createScreenReflectionUniforms(): ScreenReflectionUniforms {
  return {
    uReflectionStrength: { value: 0 },
    // The screen mesh has only a shallow z-bulge, which on its own bends the
    // reflection by a couple of degrees and reads as a flat mirror. Real tube
    // glass is far more curved than its own silhouette suggests, so the normal
    // used for reflection is bowed independently of the geometry.
    uReflectionCurvature: { value: 0.42 },
  };
}

export const screenReflectionVaryings = /* glsl */ `
  varying vec3 vHectoGlassWorldPosition;
  varying vec3 vHectoGlassWorldNormal;
`;

export const screenReflectionVertex = /* glsl */ `
  vHectoGlassWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vec2 hectoGlassCentered = uv * 2.0 - 1.0;
  vec3 hectoGlassBowed = normalize(
    vec3(hectoGlassCentered * uReflectionCurvature, 1.0)
  );
  vHectoGlassWorldNormal = normalize(mat3(modelMatrix) * hectoGlassBowed);
`;

export const screenReflectionShader = /* glsl */ `
  float hectoReflectionHash(vec3 cell) {
    return fract(sin(dot(cell, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
  }

  vec3 hectoReflectionEnvironment(vec3 direction) {
    vec3 skyTop = vec3(0.045, 0.052, 0.115);
    vec3 skyHorizon = vec3(0.36, 0.325, 0.43);
    vec3 moonColor = vec3(0.69, 0.74, 0.90);
    vec3 horizonColor = vec3(0.58, 0.57, 0.70);
    vec3 fogColor = vec3(0.20, 0.205, 0.30);
    vec3 sandColor = vec3(0.115, 0.118, 0.155);

    float height = direction.y;
    vec3 sky = mix(skyHorizon, skyTop, pow(clamp(height, 0.0, 1.0), 0.42));

    vec3 moonDirection = normalize(vec3(-0.58, 0.055, -1.0));
    float moonFacing = max(dot(direction, moonDirection), 0.0);
    sky += moonColor * pow(moonFacing, 5.0) * 0.10;
    sky += moonColor * pow(moonFacing, 2.0) * 0.04;
    sky += horizonColor * exp(-abs(height) * 5.5) * 0.085;
    sky += fogColor * exp(-abs(height) * 13.0) * 0.07;

    // Quantised by direction rather than by fragment, so the stars sit still in
    // the glass as the camera orbits instead of crawling across the face.
    float star = step(0.9975, hectoReflectionHash(floor(direction * 190.0)))
      * smoothstep(-0.02, 0.16, height);
    sky += vec3(0.91, 0.94, 1.0) * star;

    // Below the horizon the glass picks up the dunes. The ripple banding is
    // compressed hard because every ground-bound reflected ray leaves the screen
    // at a grazing angle.
    float ripple = sin(direction.x * 46.0 + direction.z * 17.0) * 0.5 + 0.5;
    vec3 ground = sandColor * (0.82 + ripple * 0.24);
    ground = mix(ground, fogColor * 0.55, smoothstep(-0.35, -0.02, height));

    return mix(ground, sky, smoothstep(-0.035, 0.035, height));
  }

  vec3 hectoGlassReflection() {
    if (uReflectionStrength <= 0.0) {
      return vec3(0.0);
    }

    vec3 viewDirection = normalize(vHectoGlassWorldPosition - cameraPosition);
    vec3 glassNormal = normalize(vHectoGlassWorldNormal);
    float facing = clamp(dot(glassNormal, -viewDirection), 0.0, 1.0);
    // Schlick. The hero framing puts the camera nearly square to the tube, so
    // the head-on term has to carry the effect, with the corners lifting as the
    // bowed normal turns them away.
    float fresnel = 0.045 + 0.955 * pow(1.0 - facing, 4.2);
    vec3 reflected = reflect(viewDirection, glassNormal);

    return hectoReflectionEnvironment(reflected)
      * fresnel
      * uReflectionStrength;
  }
`;
