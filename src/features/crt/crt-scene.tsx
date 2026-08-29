"use client";

import { useEffect, useRef } from "react";
import Lenis from "lenis";
import { useMotionValue, useSpring } from "motion/react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

import { crtEntryFragmentShader, crtEntryVertexShader } from "./crt-entry-shader";
import { createSandEnvironment } from "./sand-environment";
import {
  createScreenReflectionUniforms,
  screenReflectionShader,
  screenReflectionVaryings,
  screenReflectionVertex,
} from "./crt-reflection";
import {
  createScreenLightUniforms,
  readScreenEmission,
  updateScreenLightTransform,
} from "./screen-light";

const CRT_WIDTH = 14.4;
const CRT_HEIGHT = 10.24;

// The crop the screen material samples out of the reference artwork, mirrored
// here so the emitter averages exactly the pixels that are actually onscreen.
const SCREEN_CROP = { x: 70, y: 44, width: 1300, height: 936 };

// Art-directed scale on the emitter. The tube is the only thing in the scene
// that is not moonlight, so it is deliberately stronger than a real 50cd/m2 CRT
// would be at this distance.
const SCREEN_LIGHT_STRENGTH = 13.0;

// The dark tube is a mirror before it powers on. Once the picture is up the
// glass keeps reflecting, but far enough down that the scanlines and pixel
// lattice underneath stay the thing you read.
const SCREEN_REFLECTION_CLOSED = 1.0;
const SCREEN_REFLECTION_OPEN = 0.22;

function createRoundedMaskMap(insetX: number, insetY: number, radius: number) {
  const canvas = document.createElement("canvas");
  canvas.width = 1300;
  canvas.height = 936;

  const context = canvas.getContext("2d");

  if (!context) {
    return null;
  }

  context.fillStyle = "#000";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#fff";
  context.beginPath();
  context.roundRect(
    insetX,
    insetY,
    canvas.width - insetX * 2,
    canvas.height - insetY * 2,
    radius,
  );
  context.fill();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  return texture;
}

function setShadow(mesh: THREE.Mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function CrtScene() {
  const hostRef = useRef<HTMLDivElement>(null);
  const scrollProgress = useMotionValue(0);
  const cameraProgress = useSpring(scrollProgress, {
    damping: 20,
    mass: 0.9,
    stiffness: 70,
  });

  useEffect(() => {
    const lenis = new Lenis({
      autoRaf: true,
      lerp: 0.075,
      smoothWheel: true,
      syncTouch: true,
      touchMultiplier: 1,
      wheelMultiplier: 0.9,
    });
    let glideDirection: -1 | 0 | 1 = 0;

    function getEntryRange() {
      const startMarker = document.getElementById("crt-close");
      const endMarker = document.getElementById("crt-entry-mid");
      const start = startMarker?.offsetTop ?? lenis.limit * 0.56;
      const end = endMarker?.offsetTop ?? lenis.limit * 0.78;

      return { start, end };
    }

    function updateSequence(scroll: number) {
      const { start, end } = getEntryRange();
      let progress = 0;

      if (scroll <= start) {
        progress = start > 0 ? (scroll / start) * 0.56 : 0;
      } else {
        const entryProgress = THREE.MathUtils.clamp((scroll - start) / (end - start), 0, 1);
        progress = 0.56 + entryProgress * 0.44;
      }

      scrollProgress.set(THREE.MathUtils.clamp(progress, 0, 1));
    }

    function glideTo(target: number, direction: -1 | 1) {
      if (glideDirection !== 0) {
        return;
      }

      glideDirection = direction;
      lenis.scrollTo(target, {
        force: true,
        lerp: 0.065,
        lock: true,
        onComplete: () => {
          glideDirection = 0;
        },
      });
    }

    const unsubscribe = lenis.on("scroll", ({ direction, scroll }) => {
      updateSequence(scroll);

      if (glideDirection !== 0 || direction === 0) {
        return;
      }

      const { start, end } = getEntryRange();
      const range = end - start;
      const forwardTrigger = start + range * 0.15;
      const reverseTrigger = start + range * 0.85;

      if (direction > 0 && scroll >= forwardTrigger && scroll < end) {
        glideTo(end, 1);
      } else if (direction < 0 && scroll <= reverseTrigger && scroll > start) {
        glideTo(start, -1);
      }
    });

    const initialFrame = requestAnimationFrame(() => {
      updateSequence(lenis.scroll);
    });

    return () => {
      cancelAnimationFrame(initialFrame);
      unsubscribe();
      lenis.destroy();
    };
  }, [scrollProgress]);

  useEffect(() => {
    const host = hostRef.current;

    if (!host) {
      return;
    }

    const hostElement = host;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c1024);
    scene.fog = new THREE.Fog(0x363747, 92, 250);
    const camera = new THREE.PerspectiveCamera(38, CRT_WIDTH / CRT_HEIGHT, 0.1, 300);
    camera.position.set(23.4, 7.2, 29.4);

    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x0c1024, 1);
    renderer.autoClear = false;
    hostElement.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.enablePan = false;
    controls.enableZoom = false;
    controls.enabled = false;
    controls.minDistance = 15;
    controls.maxDistance = 32;
    controls.rotateSpeed = 0.7;
    controls.target.set(0, 0, -1.6);
    controls.update();

    const screenLightUniforms = createScreenLightUniforms();
    // Held until the artwork decodes, then replaced with the measured value.
    let screenEmission = 0.25;

    const sandEnvironment = createSandEnvironment(screenLightUniforms);
    scene.add(sandEnvironment.root);

    const crt = new THREE.Group();
    const abandonedPitch = THREE.MathUtils.degToRad(-2.5);
    const abandonedYaw = THREE.MathUtils.degToRad(-1.4);
    const abandonedLean = THREE.MathUtils.degToRad(-3.2);
    const buriedOffset = -0.14;
    crt.position.y = buriedOffset;
    crt.rotation.set(abandonedPitch, abandonedYaw, abandonedLean);
    scene.add(crt);

    const caseMaterial = new THREE.MeshStandardMaterial({
      color: 0x817e75,
      metalness: 0.18,
      roughness: 0.62,
    });
    const edgeMaterial = new THREE.MeshStandardMaterial({
      color: 0x55534d,
      metalness: 0.16,
      roughness: 0.72,
    });
    const bezelMaterial = new THREE.MeshStandardMaterial({
      color: 0x0e0e0d,
      metalness: 0.05,
      roughness: 0.7,
    });
    const ventMaterial = new THREE.MeshStandardMaterial({
      color: 0x181816,
      roughness: 0.88,
    });
    const sideMaterial = new THREE.MeshStandardMaterial({
      color: 0x65625b,
      metalness: 0.12,
      roughness: 0.7,
    });
    const body = setShadow(
      new THREE.Mesh(
        new RoundedBoxGeometry(13.5, 9.52, 4.8, 10, 0.72),
        caseMaterial,
      ),
    );
    body.position.z = -2.3;
    crt.add(body);

    const rearHousing = setShadow(
      new THREE.Mesh(
        new RoundedBoxGeometry(10.3, 7.4, 2.65, 8, 0.68),
        caseMaterial,
      ),
    );
    rearHousing.position.z = -5.55;
    crt.add(rearHousing);

    const rearPanel = setShadow(
      new THREE.Mesh(
        new RoundedBoxGeometry(8.9, 6.1, 0.18, 6, 0.35),
        edgeMaterial,
      ),
    );
    rearPanel.position.z = -6.95;
    crt.add(rearPanel);

    const sidePanelGeometry = new RoundedBoxGeometry(0.18, 7.9, 3.9, 6, 0.08);

    for (const side of [-1, 1]) {
      const sidePanel = setShadow(new THREE.Mesh(sidePanelGeometry, sideMaterial));
      sidePanel.position.set(side * 6.79, 0, -2.45);
      crt.add(sidePanel);
    }

    const faceplate = setShadow(
      new THREE.Mesh(
        new RoundedBoxGeometry(CRT_WIDTH, CRT_HEIGHT, 0.78, 12, 0.48),
        caseMaterial,
      ),
    );
    faceplate.position.z = 0.24;
    crt.add(faceplate);

    const bezel = setShadow(
      new THREE.Mesh(
        new RoundedBoxGeometry(13.48, 9.62, 0.46, 32, 0.48),
        bezelMaterial,
      ),
    );
    bezel.position.z = 0.73;
    crt.add(bezel);

    const screenGeometry = new THREE.PlaneGeometry(13.0, 9.36, 80, 56);
    const screenPositions = screenGeometry.attributes.position;

    for (let index = 0; index < screenPositions.count; index += 1) {
      const x = screenPositions.getX(index) / 6.5;
      const y = screenPositions.getY(index) / 4.68;
      const distanceFromCenter = x * x + y * y;
      screenPositions.setZ(index, 0.26 * Math.max(0, 1 - distanceFromCenter * 0.5));
    }

    screenGeometry.computeVertexNormals();

    const screenTexture = new THREE.TextureLoader().load(
      `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/assets/figma/crt-reference.png`,
      (texture) => {
        const emission = readScreenEmission(texture.image, SCREEN_CROP);

        if (emission) {
          screenLightUniforms.uScreenLightColor.value.copy(emission.color);
          screenEmission = emission.luminance;
        }

        render();
      },
    );
    screenTexture.colorSpace = THREE.SRGBColorSpace;
    screenTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    screenTexture.repeat.set(1300 / 1440, 936 / 1024);
    screenTexture.offset.set(70 / 1440, 44 / 1024);

    const screenAlphaMap = createRoundedMaskMap(0, 0, 54);
    const screenEffectMask = createRoundedMaskMap(20, 14, 58);
    const screenReflectionUniforms = createScreenReflectionUniforms();
    const screenWarpUniform = { value: 0 };
    const screenTimeUniform = { value: 0 };
    const screenLoadUniform = { value: 0 };
    const screenMaterial = new THREE.MeshBasicMaterial({
      alphaMap: screenAlphaMap ?? undefined,
      fog: false,
      map: screenTexture,
      toneMapped: false,
      transparent: true,
    });
    screenMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uPreEntryWarp = screenWarpUniform;
      shader.uniforms.uScreenTime = screenTimeUniform;
      shader.uniforms.uLoadProgress = screenLoadUniform;
      shader.uniforms.uEffectMask = { value: screenEffectMask };
      Object.assign(shader.uniforms, screenReflectionUniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
          uniform float uReflectionCurvature;
          ${screenReflectionVaryings}`,
        )
        .replace(
          "#include <project_vertex>",
          `#include <project_vertex>
          ${screenReflectionVertex}`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <map_pars_fragment>",
          `#include <map_pars_fragment>
          uniform float uReflectionStrength;
          uniform float uReflectionCurvature;
          ${screenReflectionVaryings}
          ${screenReflectionShader}
          uniform float uPreEntryWarp;
          uniform float uScreenTime;
          uniform float uLoadProgress;
          uniform sampler2D uEffectMask;

          float hectoScreenPulse(float time, float center, float width) {
            return smoothstep(0.0, 1.0, max(0.0, 1.0 - abs(time - center) / width));
          }

          float hectoAmberMask(vec3 color) {
            float amberDelta = color.r - max(color.g, color.b);
            return smoothstep(0.012, 0.055, amberDelta)
              * smoothstep(0.018, 0.085, color.r);
          }

          float hectoEllipseMask(vec2 point, vec2 center, vec2 radius) {
            float ellipseDistance = length((point - center) / radius);
            return 1.0 - smoothstep(0.82, 1.16, ellipseDistance);
          }

          float hectoRectMask(vec2 point, vec2 minimum, vec2 maximum) {
            vec2 feather = vec2(0.0015);
            return smoothstep(minimum.x, minimum.x + feather.x, point.x)
              * (1.0 - smoothstep(maximum.x - feather.x, maximum.x, point.x))
              * smoothstep(minimum.y, minimum.y + feather.y, point.y)
              * (1.0 - smoothstep(maximum.y - feather.y, maximum.y, point.y));
          }`,
        )
        .replace(
          "#include <map_fragment>",
          `#ifdef USE_MAP
            vec2 preEntryCentered = vMapUv - 0.5;
            float preEntryRadiusSquared = dot(preEntryCentered, preEntryCentered);
            vec2 preEntryUv = preEntryCentered
              * (1.0 + preEntryRadiusSquared * 0.64 * uPreEntryWarp)
              + 0.5;
            vec2 screenCropMin = vec2(70.0 / 1440.0, 44.0 / 1024.0);
            vec2 screenCropMax = vec2(1370.0 / 1440.0, 980.0 / 1024.0);
            vec2 screenCropSize = screenCropMax - screenCropMin;
            vec2 surfaceUv = (vMapUv - screenCropMin) / screenCropSize;
            vec2 contentUv = (preEntryUv - screenCropMin) / screenCropSize;
            float effectMask = texture2D(
              uEffectMask,
              clamp(surfaceUv, 0.0, 1.0)
            ).r;

            // Match the source's two-second power-on keyframes without scaling the
            // texture itself. The content remains stationary and is revealed by
            // a centered aperture, so no part of the UI slides into view.
            float apertureX = 0.0;
            float apertureY = 0.0;

            if (uScreenTime >= 0.60 && uScreenTime < 0.80) {
              float horizontalOpen = smoothstep(0.60, 0.80, uScreenTime);
              apertureX = mix(0.02, 1.0, horizontalOpen);
              apertureY = 0.01;
            } else if (uScreenTime >= 0.80 && uScreenTime < 0.96) {
              float verticalOpen = smoothstep(0.80, 0.96, uScreenTime);
              apertureX = 1.0;
              apertureY = mix(0.01, 1.0, verticalOpen);
            } else if (uScreenTime >= 0.96) {
              apertureX = 1.0;
              apertureY = 1.0;
            }

            vec2 apertureDistance = abs(surfaceUv - 0.5);
            float apertureFeatherX = max(fwidth(surfaceUv.x) * 1.5, 0.001);
            float apertureFeatherY = max(fwidth(surfaceUv.y) * 1.5, 0.001);
            float apertureMaskX = 1.0 - smoothstep(
              apertureX * 0.5 - apertureFeatherX,
              apertureX * 0.5 + apertureFeatherX,
              apertureDistance.x
            );
            float apertureMaskY = 1.0 - smoothstep(
              apertureY * 0.5 - apertureFeatherY,
              apertureY * 0.5 + apertureFeatherY,
              apertureDistance.y
            );
            float apertureMask = apertureMaskX * apertureMaskY;

            // The source crosses through two extremely short inverted keyframes.
            // Represent those as phosphor flickers rather than holding a mirrored
            // image onscreen for a complete rendered frame.
            float firstFlicker = hectoScreenPulse(uScreenTime, 1.40, 0.018);
            float secondFlicker = hectoScreenPulse(uScreenTime, 1.60, 0.018);
            float settleFlicker = hectoScreenPulse(uScreenTime, 0.98, 0.018);
            float startupFlicker = max(
              settleFlicker,
              max(firstFlicker, secondFlicker)
            );

            vec2 sampledUv = mix(
              screenCropMin,
              screenCropMax,
              clamp(contentUv, 0.0, 1.0)
            );
            vec4 sampledDiffuseColor = texture2D(map, sampledUv);
            vec3 staticScreenEdge = sampledDiffuseColor.rgb;

            // Match Triggr's console transcript: a cursor-only beat, 10ms per
            // character, and a 100ms pause between lines. The source lettering
            // is revealed in place, retaining the authored pixel font.
            const float terminalTypingStart = 1.36;
            const float terminalLineOneCharacters = 35.0;
            const float terminalLineTwoCharacters = 19.0;
            const float terminalLineTwoTotalCharacters = 22.0;
            const float terminalCharacterTime = 0.01;
            const float terminalLinePause = 0.10;
            const float terminalDotsDelay = 5.0;
            vec2 terminalLineOneMin = vec2(0.063, 0.713);
            vec2 terminalLineOneMax = vec2(0.520, 0.743);
            vec2 terminalLineTwoMin = vec2(0.063, 0.664);
            vec2 terminalLineTwoMax = vec2(0.385, 0.694);
            const float terminalLineTwoBaseEnd = 0.346;
            float terminalLineTwoStart = terminalTypingStart
              + terminalLineOneCharacters * terminalCharacterTime
              + terminalLinePause;
            float terminalTypingComplete = terminalLineTwoStart
              + terminalLineTwoCharacters * terminalCharacterTime;
            float terminalDotsStart = terminalTypingComplete + terminalDotsDelay;
            float terminalLineOneTyped = clamp(
              floor(max(uScreenTime - terminalTypingStart, 0.0)
                / terminalCharacterTime),
              0.0,
              terminalLineOneCharacters
            );
            float terminalLineTwoTyped = clamp(
              floor(max(uScreenTime - terminalLineTwoStart, 0.0)
                / terminalCharacterTime),
              0.0,
              terminalLineTwoCharacters
            );
            float terminalDotCycle = mod(
              max(uScreenTime - terminalDotsStart, 0.0),
              1.35
            );
            float terminalDotCount = min(
              3.0,
              floor(terminalDotCycle / 0.18)
            );
            float terminalDotsActive = step(terminalDotsStart, uScreenTime);
            float terminalLineTwoVisibleCharacters = mix(
              terminalLineTwoTyped,
              terminalLineTwoCharacters + terminalDotCount,
              terminalDotsActive
            );
            float terminalLineOneCutoff = mix(
              terminalLineOneMin.x,
              terminalLineOneMax.x,
              terminalLineOneTyped / terminalLineOneCharacters
            );
            float terminalLineTwoTypingCutoff = mix(
              terminalLineTwoMin.x,
              terminalLineTwoBaseEnd,
              terminalLineTwoTyped / terminalLineTwoCharacters
            );
            float terminalLineTwoDotsCutoff = mix(
              terminalLineTwoBaseEnd,
              terminalLineTwoMax.x,
              terminalDotCount / 3.0
            );
            float terminalLineTwoCutoff = mix(
              terminalLineTwoTypingCutoff,
              terminalLineTwoDotsCutoff,
              terminalDotsActive
            );
            float terminalLineOneRegion = hectoRectMask(
              contentUv,
              terminalLineOneMin,
              terminalLineOneMax
            );
            float terminalLineTwoRegion = hectoRectMask(
              contentUv,
              terminalLineTwoMin,
              terminalLineTwoMax
            );
            float terminalLineOneReveal = 1.0 - smoothstep(
              terminalLineOneCutoff - 0.0008,
              terminalLineOneCutoff + 0.0008,
              contentUv.x
            );
            float terminalLineTwoReveal = 1.0 - smoothstep(
              terminalLineTwoCutoff - 0.0008,
              terminalLineTwoCutoff + 0.0008,
              contentUv.x
            );
            float terminalTextRegion = max(
              terminalLineOneRegion,
              terminalLineTwoRegion
            );
            float terminalTextReveal = max(
              terminalLineOneRegion * terminalLineOneReveal,
              terminalLineTwoRegion * terminalLineTwoReveal
            );
            float terminalHiddenText = terminalTextRegion
              * (1.0 - terminalTextReveal);
            vec3 terminalLineOneBackground = texture2D(
              map,
              vec2(sampledUv.x, 754.0 / 1024.0)
            ).rgb;
            vec3 terminalLineTwoBackground = texture2D(
              map,
              vec2(sampledUv.x, 654.0 / 1024.0)
            ).rgb;
            vec3 terminalBackground = mix(
              terminalLineOneBackground,
              terminalLineTwoBackground,
              terminalLineTwoRegion
            );
            sampledDiffuseColor.rgb = mix(
              sampledDiffuseColor.rgb,
              terminalBackground,
              terminalHiddenText
            );

            float terminalOnSecondLine = step(
              terminalLineTwoStart,
              uScreenTime
            );
            float terminalCursorX = mix(
              terminalLineOneMin.x
                + (terminalLineOneMax.x - terminalLineOneMin.x)
                  * terminalLineOneTyped / terminalLineOneCharacters,
              terminalLineTwoCutoff,
              terminalOnSecondLine
            );
            float terminalCursorY = mix(
              terminalLineOneMin.y,
              terminalLineTwoMin.y,
              terminalOnSecondLine
            );
            float terminalCursorOpacity = step(0.96, uScreenTime)
              * (1.0 - fract(max(uScreenTime - 0.96, 0.0)));
            float terminalCursor = hectoRectMask(
              contentUv,
              vec2(terminalCursorX, terminalCursorY + 0.003),
              vec2(terminalCursorX + 0.0075, terminalCursorY + 0.026)
            ) * terminalCursorOpacity;
            sampledDiffuseColor.rgb = mix(
              sampledDiffuseColor.rgb,
              vec3(0.94, 0.245, 0.008),
              terminalCursor
            );

            // Blur only the three authored reflection features: the sweeping
            // curve and the two angular facets. Sampling is clamped well inside
            // the black glass so the bezel and preserved screen edge can never
            // bleed into the reflection blur.
            float screenYFromTop = 1.0 - surfaceUv.y;
            float reflectionCurveY = 0.06
              + 0.68 * (1.0 - exp(-3.15 * surfaceUv.x));
            float curvedReflection = 1.0 - smoothstep(
              0.055,
              0.145,
              abs(screenYFromTop - reflectionCurveY)
            );
            vec2 reflectionPoint = vec2(surfaceUv.x, screenYFromTop);
            float centerReflection = hectoEllipseMask(
              reflectionPoint,
              vec2(0.54, 0.41),
              vec2(0.17, 0.30)
            );
            float rightReflection = hectoEllipseMask(
              reflectionPoint,
              vec2(0.82, 0.39),
              vec2(0.16, 0.31)
            );
            float reflectionTarget = max(
              curvedReflection,
              max(centerReflection, rightReflection)
            );
            reflectionTarget *= smoothstep(0.82, 0.98, effectMask);

            vec2 reflectionOffset = vec2(14.0 / 1440.0, 14.0 / 1024.0);
            vec2 reflectionSafeMin = screenCropMin
              + vec2(34.0 / 1440.0, 30.0 / 1024.0);
            vec2 reflectionSafeMax = screenCropMax
              - vec2(34.0 / 1440.0, 30.0 / 1024.0);
            vec3 reflectionA = texture2D(
              map,
              clamp(
                sampledUv + reflectionOffset * vec2(-1.0, -1.0),
                reflectionSafeMin,
                reflectionSafeMax
              )
            ).rgb;
            vec3 reflectionB = texture2D(
              map,
              clamp(
                sampledUv + reflectionOffset * vec2(1.0, -1.0),
                reflectionSafeMin,
                reflectionSafeMax
              )
            ).rgb;
            vec3 reflectionC = texture2D(
              map,
              clamp(
                sampledUv + reflectionOffset * vec2(-1.0, 1.0),
                reflectionSafeMin,
                reflectionSafeMax
              )
            ).rgb;
            vec3 reflectionD = texture2D(
              map,
              clamp(
                sampledUv + reflectionOffset * vec2(1.0, 1.0),
                reflectionSafeMin,
                reflectionSafeMax
              )
            ).rgb;
            vec3 reflectionE = texture2D(
              map,
              clamp(
                sampledUv + reflectionOffset * vec2(-1.0, 0.0),
                reflectionSafeMin,
                reflectionSafeMax
              )
            ).rgb;
            vec3 reflectionF = texture2D(
              map,
              clamp(
                sampledUv + reflectionOffset * vec2(1.0, 0.0),
                reflectionSafeMin,
                reflectionSafeMax
              )
            ).rgb;
            vec3 reflectionG = texture2D(
              map,
              clamp(
                sampledUv + reflectionOffset * vec2(0.0, -1.0),
                reflectionSafeMin,
                reflectionSafeMax
              )
            ).rgb;
            vec3 reflectionH = texture2D(
              map,
              clamp(
                sampledUv + reflectionOffset * vec2(0.0, 1.0),
                reflectionSafeMin,
                reflectionSafeMax
              )
            ).rgb;
            reflectionA = mix(reflectionA, sampledDiffuseColor.rgb, hectoAmberMask(reflectionA));
            reflectionB = mix(reflectionB, sampledDiffuseColor.rgb, hectoAmberMask(reflectionB));
            reflectionC = mix(reflectionC, sampledDiffuseColor.rgb, hectoAmberMask(reflectionC));
            reflectionD = mix(reflectionD, sampledDiffuseColor.rgb, hectoAmberMask(reflectionD));
            reflectionE = mix(reflectionE, sampledDiffuseColor.rgb, hectoAmberMask(reflectionE));
            reflectionF = mix(reflectionF, sampledDiffuseColor.rgb, hectoAmberMask(reflectionF));
            reflectionG = mix(reflectionG, sampledDiffuseColor.rgb, hectoAmberMask(reflectionG));
            reflectionH = mix(reflectionH, sampledDiffuseColor.rgb, hectoAmberMask(reflectionH));
            vec3 softenedReflection = sampledDiffuseColor.rgb * 0.10
              + (reflectionA + reflectionB + reflectionC + reflectionD) * 0.10
              + (reflectionE + reflectionF + reflectionG + reflectionH) * 0.125;
            float reflectionBlur = reflectionTarget
              * (1.0 - hectoAmberMask(sampledDiffuseColor.rgb))
              * 0.94;
            sampledDiffuseColor.rgb = mix(
              sampledDiffuseColor.rgb,
              softenedReflection,
              reflectionBlur
            );

            // The authored texture contains nine lit loading blocks. Remove only
            // those amber pixels inside the bar, then rebuild all 23 blocks from
            // the first authored block so their exact CRT texture is preserved.
            const float loadingSegmentCount = 23.0;
            vec2 loadingBarMin = vec2(0.075, 0.607);
            vec2 loadingBarMax = vec2(0.902, 0.635);
            float loadingBoundsX = smoothstep(
              loadingBarMin.x,
              loadingBarMin.x + 0.003,
              contentUv.x
            ) * (1.0 - smoothstep(
              loadingBarMax.x - 0.003,
              loadingBarMax.x,
              contentUv.x
            ));
            float loadingBoundsY = smoothstep(
              loadingBarMin.y,
              loadingBarMin.y + 0.003,
              contentUv.y
            ) * (1.0 - smoothstep(
              loadingBarMax.y - 0.003,
              loadingBarMax.y,
              contentUv.y
            ));
            float loadingBarInterior = loadingBoundsX * loadingBoundsY;
            float authoredLoadingBlock = loadingBarInterior
              * hectoAmberMask(sampledDiffuseColor.rgb);
            vec3 loadingBarBackground = texture2D(
              map,
              vec2(sampledUv.x, sampledUv.y - 24.0 / 1024.0)
            ).rgb;
            sampledDiffuseColor.rgb = mix(
              sampledDiffuseColor.rgb,
              loadingBarBackground,
              authoredLoadingBlock
            );

            float loadingPosition = clamp(
              (contentUv.x - loadingBarMin.x)
                / (loadingBarMax.x - loadingBarMin.x),
              0.0,
              0.99999
            ) * loadingSegmentCount;
            float loadingSegmentIndex = floor(loadingPosition);
            float loadingCellX = fract(loadingPosition);
            float loadingCellMask = smoothstep(0.08, 0.13, loadingCellX)
              * (1.0 - smoothstep(0.80, 0.85, loadingCellX));
            float loadingThreshold = (loadingSegmentIndex + 0.5)
              / loadingSegmentCount;
            float loadingOpacity = smoothstep(
              loadingThreshold - 0.45 / loadingSegmentCount,
              loadingThreshold + 1.15 / loadingSegmentCount,
              uLoadProgress
            );
            vec2 loadingSourceUv = vec2(
              mix(
                168.0 / 1440.0,
                205.0 / 1440.0,
                clamp((loadingCellX - 0.08) / 0.72, 0.0, 1.0)
              ),
              sampledUv.y
            );
            vec3 loadingSegmentColor = texture2D(map, loadingSourceUv).rgb;
            float proceduralLoadingBlock = loadingBarInterior
              * loadingCellMask
              * loadingOpacity
              * hectoAmberMask(loadingSegmentColor);
            sampledDiffuseColor.rgb = mix(
              sampledDiffuseColor.rgb,
              loadingSegmentColor,
              proceduralLoadingBlock
            );

            // Recreate the source's 50/50 repeating pixel rows moving upward by
            // five row periods per second. This affects display color only—not
            // the mesh alpha, glass outline, or the surrounding CRT body.
            float scanlinePhase = fract(surfaceUv.y * 94.0 + uScreenTime * 5.0);
            float scanlineEdge = max(fwidth(surfaceUv.y * 94.0) * 0.75, 0.015);
            float scanlineStripe = smoothstep(
              0.50 - scanlineEdge,
              0.50 + scanlineEdge,
              scanlinePhase
            );
            float scanlineStrength = mix(1.0, 0.74, scanlineStripe);

            // The source's second effect layer is a moving five-pixel lattice.
            // Keep it monochrome so Hecto's amber phosphor color does not split
            // into the reference's RGB test-pattern colors.
            float pixelColumn = step(
              0.50,
              fract(surfaceUv.x * 260.0 - uScreenTime * 2.0)
            );
            float pixelRow = step(
              0.50,
              fract(surfaceUv.y * 187.0 + uScreenTime * 4.0)
            );
            float pixelLattice = 1.0 - max(pixelColumn, pixelRow) * 0.035;

            // Recreate the source's persistent light pseudo-element: a dark body
            // radial from the right over a blurred white reflection radial from
            // the left. This layer contains no UI texture at all.
            const float glassRadius = 1.11803399;
            float rightRadius = clamp(
              length(surfaceUv - vec2(1.0, 0.5)) / glassRadius,
              0.0,
              1.0
            );
            float leftRadius = clamp(
              length(surfaceUv - vec2(0.0, 0.5)) / glassRadius,
              0.0,
              1.0
            );
            float leftReflection = smoothstep(0.0, 0.77, leftRadius)
              * (1.0 - smoothstep(0.77, 1.0, leftRadius));
            vec3 sourceBody = vec3(45.0, 49.0, 59.0) / 255.0;
            vec3 sourceWhite = vec3(242.0, 253.0, 255.0) / 255.0;
            vec3 radialGlass = sourceBody * rightRadius
              + sourceWhite * leftReflection * (1.0 - rightRadius);
            vec3 offGlass = vec3(0.00015) + radialGlass * 0.0045;

            vec3 liveDisplay = sampledDiffuseColor.rgb
              * scanlineStrength
              * pixelLattice;
            liveDisplay *= mix(1.0, 0.48, startupFlicker);
            vec3 openedPicture = mix(offGlass, liveDisplay, apertureMask);

            // During the source's horizontal-line phase the whole picture is
            // compressed into a slit. Approximate that column average without
            // ever moving or mirroring the UI itself.
            float lineStage = smoothstep(0.60, 0.66, uScreenTime)
              * (1.0 - smoothstep(0.80, 0.86, uScreenTime));
            vec3 collapsedPicture = (
              texture2D(map, vec2(sampledUv.x, mix(screenCropMin.y, screenCropMax.y, 0.10))).rgb
              + texture2D(map, vec2(sampledUv.x, mix(screenCropMin.y, screenCropMax.y, 0.26))).rgb
              + texture2D(map, vec2(sampledUv.x, mix(screenCropMin.y, screenCropMax.y, 0.42))).rgb
              + texture2D(map, vec2(sampledUv.x, mix(screenCropMin.y, screenCropMax.y, 0.58))).rgb
              + texture2D(map, vec2(sampledUv.x, mix(screenCropMin.y, screenCropMax.y, 0.74))).rgb
              + texture2D(map, vec2(sampledUv.x, mix(screenCropMin.y, screenCropMax.y, 0.90))).rgb
            ) / 6.0;
            float compressedLine = exp(-pow((surfaceUv.y - 0.5) / 0.0045, 2.0))
              * apertureMaskX
              * lineStage;
            openedPicture = mix(
              openedPicture,
              collapsedPicture * 1.35,
              clamp(compressedLine, 0.0, 1.0)
            );
            sampledDiffuseColor.rgb = mix(
              staticScreenEdge,
              openedPicture,
              effectMask
            );
            // The authored reflection blur can otherwise resample dim text
            // pixels above each row before its actual typing reveal. Clear the
            // two narrow reflection bands after all screen/reflection passes,
            // then composite back only source pixels inside the valid reveal.
            float terminalLineOneCleanup = hectoRectMask(
              contentUv,
              vec2(0.057, 0.704),
              vec2(0.528, 0.764)
            );
            float terminalLineTwoCleanup = hectoRectMask(
              contentUv,
              vec2(0.057, 0.650),
              vec2(0.394, 0.710)
            );
            vec3 terminalLineOneCleanDisplay = terminalLineOneBackground
              * scanlineStrength
              * pixelLattice;
            vec3 terminalLineTwoCleanDisplay = terminalLineTwoBackground
              * scanlineStrength
              * pixelLattice;
            sampledDiffuseColor.rgb = mix(
              sampledDiffuseColor.rgb,
              terminalLineOneCleanDisplay,
              terminalLineOneCleanup * effectMask * apertureMask
            );
            sampledDiffuseColor.rgb = mix(
              sampledDiffuseColor.rgb,
              terminalLineTwoCleanDisplay,
              terminalLineTwoCleanup * effectMask * apertureMask
            );
            float terminalAuthoredText = terminalTextReveal
              * hectoAmberMask(staticScreenEdge);
            sampledDiffuseColor.rgb = mix(
              sampledDiffuseColor.rgb,
              staticScreenEdge * scanlineStrength * pixelLattice,
              terminalAuthoredText * effectMask * apertureMask
            );
            sampledDiffuseColor.rgb = mix(
              sampledDiffuseColor.rgb,
              vec3(0.94, 0.245, 0.008) * scanlineStrength * pixelLattice,
              terminalCursor * effectMask * apertureMask
            );
            #ifdef DECODE_VIDEO_TEXTURE
              sampledDiffuseColor = sRGBTransferEOTF(sampledDiffuseColor);
            #endif
            diffuseColor *= sampledDiffuseColor;
          #endif`,
        )
        .replace(
          "#include <opaque_fragment>",
          `// Added rather than mixed: light bouncing off the front of the glass
          // reaches the eye on top of whatever the phosphor is transmitting, so
          // the scanlines and pixel lattice stay legible through it.
          outgoingLight += hectoGlassReflection();
          #include <opaque_fragment>`,
        );
    };
    screenMaterial.customProgramCacheKey = () => "hecto-crt-display-v14";
    const screen = new THREE.Mesh(screenGeometry, screenMaterial);
    screen.position.z = 0.98;
    screen.renderOrder = 2;
    crt.add(screen);

    const overlayScene = new THREE.Scene();
    const overlayCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const overlayUniforms = {
      uTexture: { value: screenTexture },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uBlend: { value: 0 },
      uEntry: { value: 0 },
      uLoadProgress: screenLoadUniform,
      uTime: { value: 0 },
    };
    const overlayMaterial = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      fragmentShader: crtEntryFragmentShader,
      transparent: true,
      uniforms: overlayUniforms,
      vertexShader: crtEntryVertexShader,
    });
    const overlayQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), overlayMaterial);
    overlayScene.add(overlayQuad);

    const footGeometry = new RoundedBoxGeometry(3.05, 0.5, 2.35, 5, 0.18);

    for (const x of [-4.6, 4.6]) {
      const foot = setShadow(new THREE.Mesh(footGeometry, edgeMaterial));
      foot.position.set(x, -5.2, -2.55);
      crt.add(foot);
    }

    const ventGeometry = new RoundedBoxGeometry(0.09, 0.24, 1.28, 3, 0.045);

    for (const side of [-1, 1]) {
      for (let index = 0; index < 7; index += 1) {
        const vent = new THREE.Mesh(ventGeometry, ventMaterial);
        vent.position.set(side * 6.92, 1.75 - index * 0.52, -2.5);
        crt.add(vent);
      }
    }

    const topVentGeometry = new RoundedBoxGeometry(0.25, 0.08, 1.55, 3, 0.04);

    for (let index = 0; index < 11; index += 1) {
      const vent = new THREE.Mesh(topVentGeometry, ventMaterial);
      vent.position.set(-2.5 + index * 0.5, 4.79, -2.8);
      crt.add(vent);
    }

    const powerSocket = new THREE.Mesh(
      new THREE.CylinderGeometry(0.36, 0.36, 0.22, 24),
      ventMaterial,
    );
    powerSocket.rotation.x = Math.PI / 2;
    powerSocket.position.set(0, -1.75, -7.08);
    crt.add(powerSocket);

    const ambientLight = new THREE.HemisphereLight(0x7785b5, 0x272938, 0.82);
    scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xaebce8, 1.72);
    keyLight.position.set(-24, 22, -40);
    keyLight.target.position.set(0, -3.8, -2.2);
    keyLight.castShadow = false;
    keyLight.shadow.mapSize.set(1536, 1536);
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 78;
    keyLight.shadow.camera.left = -24;
    keyLight.shadow.camera.right = 24;
    keyLight.shadow.camera.top = 24;
    keyLight.shadow.camera.bottom = -24;
    keyLight.shadow.bias = -0.00035;
    keyLight.shadow.normalBias = 0.035;
    keyLight.shadow.radius = 5;
    scene.add(keyLight, keyLight.target);

    const fillLight = new THREE.DirectionalLight(0x777a9c, 0.38);
    fillLight.position.set(18, 14, 28);
    fillLight.target.position.set(0, -1.2, -1.8);
    scene.add(fillLight, fillLight.target);

    // Mirrors the power-on aperture in the screen material: the emitted area is
    // the lit part of the tube, so the sand brightens in the same two steps the
    // picture does rather than snapping on with it.
    function screenApertureArea(elapsed: number) {
      if (elapsed < 0.6) {
        return 0;
      }

      if (elapsed < 0.8) {
        return THREE.MathUtils.lerp(
          0.02,
          1,
          THREE.MathUtils.smoothstep(elapsed, 0.6, 0.8),
        ) * 0.01;
      }

      if (elapsed < 0.96) {
        return THREE.MathUtils.lerp(
          0.01,
          1,
          THREE.MathUtils.smoothstep(elapsed, 0.8, 0.96),
        );
      }

      return 1;
    }

    function screenPulse(elapsed: number, center: number, width: number) {
      return THREE.MathUtils.smoothstep(
        Math.max(0, 1 - Math.abs(elapsed - center) / width),
        0,
        1,
      );
    }

    function updateScreenLight() {
      updateScreenLightTransform(screenLightUniforms, screen);

      const startupFlicker = Math.max(
        screenPulse(currentElapsed, 0.98, 0.018),
        Math.max(
          screenPulse(currentElapsed, 1.4, 0.018),
          screenPulse(currentElapsed, 1.6, 0.018),
        ),
      );
      // A couple of percent of flyback hum, enough that the pool of light on the
      // sand is never perfectly still.
      const hum = 1
        + Math.sin(currentElapsed * 31.7) * 0.018
        + Math.sin(currentElapsed * 8.3) * 0.012;
      const strength = SCREEN_LIGHT_STRENGTH
        * screenEmission
        * screenApertureArea(currentElapsed)
        * (1 + startupFlicker * 0.85)
        * hum;

      screenLightUniforms.uScreenLightIntensity.value = strength;
      // Same timeline as the emitted light, read the other way round: the glass
      // is most mirror-like while the tube is still dark.
      screenReflectionUniforms.uReflectionStrength.value = THREE.MathUtils.lerp(
        SCREEN_REFLECTION_CLOSED,
        SCREEN_REFLECTION_OPEN,
        screenApertureArea(currentElapsed),
      );
    }

    function render() {
      updateScreenLight();
      renderer.clear();
      renderer.render(scene, camera);

      if (overlayUniforms.uBlend.value > 0.001) {
        renderer.render(overlayScene, overlayCamera);
      }
    }

    const cameraTarget = new THREE.Vector3(0, 0, -1.6);
    const animatedCameraTarget = cameraTarget.clone();
    const startAzimuth = THREE.MathUtils.degToRad(37);
    const startElevation = THREE.MathUtils.degToRad(10.5);

    function smootherstep(value: number) {
      const t = THREE.MathUtils.clamp(value, 0, 1);
      return t * t * t * (t * (t * 6 - 15) + 10);
    }

    function easeOutCubic(value: number) {
      const t = THREE.MathUtils.clamp(value, 0, 1);
      return 1 - (1 - t) ** 3;
    }

    let currentEntryProgress = 0;
    let currentElapsed = 0;
    let fullscreenSettledAt: number | null = null;

    function updateLoadingProgress() {
      const initialFill = (9 / 23) * easeOutCubic(
        (currentElapsed - 0.84) / 0.9,
      );
      const fullscreenFill = easeOutCubic(
        (currentEntryProgress - 0.72) / 0.28,
      );
      const transitionFill = THREE.MathUtils.lerp(
        initialFill,
        21 / 23,
        fullscreenFill,
      );

      if (currentEntryProgress >= 0.999) {
        fullscreenSettledAt ??= currentElapsed;
      } else {
        fullscreenSettledAt = null;
      }

      const settledFill = fullscreenSettledAt === null
        ? 0
        : easeOutCubic((currentElapsed - fullscreenSettledAt - 0.12) / 0.55);
      screenLoadUniform.value = THREE.MathUtils.lerp(
        transitionFill,
        1,
        settledFill,
      );
    }

    function updateCamera(progress: number) {
      const approachProgress = THREE.MathUtils.clamp(progress / 0.56, 0, 1);
      const entryProgress = THREE.MathUtils.clamp((progress - 0.56) / 0.44, 0, 1);
      currentEntryProgress = entryProgress;
      updateLoadingProgress();
      const zoomProgress = smootherstep(approachProgress / 0.88);
      const rotationProgress = smootherstep((approachProgress - 0.56) / 0.44);
      const approachRadius = THREE.MathUtils.lerp(39.5, 16.62, zoomProgress);
      const entryCameraProgress = smootherstep(entryProgress / 0.78);
      const approachArc = Math.sin(approachProgress * Math.PI);
      const entryArc = Math.sin(entryCameraProgress * Math.PI);
      const halfVerticalFov = THREE.MathUtils.degToRad(camera.fov * 0.5);
      const verticalProjection = Math.tan(halfVerticalFov);
      const distanceToCoverHeight = 4.68 / verticalProjection;
      const distanceToCoverWidth = 6.5 / (verticalProjection * camera.aspect);
      const screenPlaneOffset = 0.98 - cameraTarget.z;
      const frameClearRadius =
        screenPlaneOffset + Math.min(distanceToCoverHeight, distanceToCoverWidth) * 0.88;
      const radius = THREE.MathUtils.lerp(
        approachRadius,
        frameClearRadius,
        entryCameraProgress,
      );
      const azimuth = THREE.MathUtils.lerp(startAzimuth, 0, rotationProgress)
        + THREE.MathUtils.degToRad(7.5) * approachArc;
      const elevation = THREE.MathUtils.lerp(startElevation, 0, rotationProgress)
        + THREE.MathUtils.degToRad(3.2) * approachArc;
      const horizontalRadius = radius * Math.cos(elevation);

      camera.position.set(
        horizontalRadius * Math.sin(azimuth) + entryArc * 0.42,
        radius * Math.sin(elevation) - entryArc * 0.18,
        cameraTarget.z + horizontalRadius * Math.cos(azimuth),
      );
      animatedCameraTarget.set(
        -approachArc * 0.72 - entryArc * 0.18,
        approachArc * 0.28 + entryArc * 0.08,
        cameraTarget.z + approachArc * 0.16,
      );
      const cameraBank = THREE.MathUtils.degToRad(-3.6) * approachArc
        + THREE.MathUtils.degToRad(1.4) * entryArc;
      camera.up.set(Math.sin(cameraBank), Math.cos(cameraBank), 0);
      camera.lookAt(animatedCameraTarget);
      controls.target.copy(animatedCameraTarget);
      controls.enabled = approachProgress >= 0.995 && entryProgress < 0.01;
      const blackVeil = smootherstep((entryProgress - 0.8) / 0.08);
      const screenBulgeProgress = smootherstep((progress - 0.62) / 0.18);
      const straightenProgress = smootherstep((entryProgress - 0.64) / 0.18);
      sandEnvironment.skyTransition.value = smootherstep(
        (approachProgress - 0.42) / 0.42,
      );
      crt.position.y = THREE.MathUtils.lerp(buriedOffset, 0, straightenProgress);
      crt.rotation.set(
        THREE.MathUtils.lerp(abandonedPitch, -0.025, straightenProgress),
        THREE.MathUtils.lerp(abandonedYaw, 0, straightenProgress),
        THREE.MathUtils.lerp(abandonedLean, 0, straightenProgress),
      );
      screenWarpUniform.value = screenBulgeProgress;

      overlayUniforms.uEntry.value = entryProgress;
      overlayUniforms.uBlend.value = blackVeil;
      hostElement.parentElement?.style.setProperty(
        "--entry-progress",
        smootherstep(entryProgress).toString(),
      );
      render();
    }

    function resize() {
      const width = hostElement.clientWidth;
      const height = hostElement.clientHeight;

      if (width === 0 || height === 0) {
        return;
      }

      renderer.setSize(width, height, false);
      const pixelRatio = renderer.getPixelRatio();
      const renderWidth = Math.max(1, Math.floor(width * pixelRatio));
      const renderHeight = Math.max(1, Math.floor(height * pixelRatio));
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      overlayUniforms.uResolution.value.set(
        renderWidth,
        renderHeight,
      );
      sandEnvironment.skyResolution.set(renderWidth, renderHeight);
      updateCamera(cameraProgress.get());
    }

    controls.addEventListener("change", render);
    const unsubscribeCamera = cameraProgress.on("change", updateCamera);

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(hostElement);
    resize();
    updateCamera(cameraProgress.get());

    let animationFrame = 0;
    const animationStart = performance.now();

    function animate(now: number) {
      const elapsed = (now - animationStart) / 1000;
      currentElapsed = elapsed;
      screenTimeUniform.value = elapsed;
      overlayUniforms.uTime.value = elapsed;
      sandEnvironment.time.value = elapsed;
      updateLoadingProgress();
      render();
      animationFrame = requestAnimationFrame(animate);
    }

    animationFrame = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animationFrame);
      unsubscribeCamera();
      controls.removeEventListener("change", render);
      controls.dispose();
      resizeObserver.disconnect();
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.Points)) {
          return;
        }

        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => material.dispose());
      });
      screenTexture.dispose();
      screenAlphaMap?.dispose();
      screenEffectMask?.dispose();
      overlayQuad.geometry.dispose();
      overlayMaterial.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [cameraProgress]);

  return (
    <div
      ref={hostRef}
      className="crtScene"
      role="img"
      aria-label="Scroll-driven three-dimensional Hecto CRT partly buried in a static sand landscape."
    />
  );
}
