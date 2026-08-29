export const crtEntryVertexShader = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export const crtEntryFragmentShader = /* glsl */ `
  precision highp float;

  uniform sampler2D uTexture;
  uniform vec2 uResolution;
  uniform float uBlend;
  uniform float uEntry;
  uniform float uLoadProgress;
  uniform float uTime;
  varying vec2 vUv;

  float hash21(vec2 point) {
    point = fract(point * vec2(123.34, 456.21));
    point += dot(point, point + 45.32);
    return fract(point.x * point.y);
  }

  float roundedRectDistance(vec2 point, vec2 halfSize, float radius) {
    vec2 q = abs(point) - halfSize + radius;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;
  }

  vec2 distortUv(vec2 uv, float strength) {
    vec2 centered = uv - 0.5;
    float radiusSquared = dot(centered, centered);
    float radial = sqrt(max(radiusSquared, 0.00001));
    return centered * (1.0 + radiusSquared * strength * radial) + 0.5;
  }

  vec2 fitScreenUv(vec2 uv) {
    float viewportAspect = uResolution.x / uResolution.y;
    float sourceAspect = 1210.0 / 880.0;
    float fittedHeight = 0.90;
    float fittedWidth = fittedHeight * sourceAspect / viewportAspect;

    return vec2(
      (uv.x - 0.045) / fittedWidth,
      1.0 - ((1.0 - uv.y) - 0.05) / fittedHeight
    );
  }

  vec4 sampleReflection(vec2 screenUv) {
    vec2 cropScale = vec2(1300.0 / 1440.0, 936.0 / 1024.0);
    vec2 cropOffset = vec2(70.0 / 1440.0, 44.0 / 1024.0);
    vec2 extendedUv = clamp(screenUv, vec2(0.0), vec2(1.0));
    float horizontalBounds = smoothstep(-0.02, 0.02, screenUv.x)
      * (1.0 - smoothstep(0.98, 1.02, screenUv.x));
    float verticalBounds = smoothstep(-0.02, 0.02, screenUv.y)
      * (1.0 - smoothstep(0.98, 1.02, screenUv.y));
    vec4 screenSample = texture2D(uTexture, extendedUv * cropScale + cropOffset);
    return mix(vec4(0.0, 0.0, 0.0, 1.0), screenSample, horizontalBounds * verticalBounds);
  }

  vec4 sampleUi(vec2 fittedUv) {
    vec2 cropScale = vec2(1210.0 / 1440.0, 880.0 / 1024.0);
    vec2 cropOffset = vec2(115.0 / 1440.0, 70.0 / 1024.0);
    vec2 extendedUv = clamp(fittedUv, vec2(0.0), vec2(1.0));
    float horizontalBounds = smoothstep(-0.02, 0.02, fittedUv.x)
      * (1.0 - smoothstep(0.98, 1.02, fittedUv.x));
    float verticalBounds = smoothstep(-0.02, 0.02, fittedUv.y)
      * (1.0 - smoothstep(0.98, 1.02, fittedUv.y));
    vec4 screenSample = texture2D(uTexture, extendedUv * cropScale + cropOffset);
    return mix(vec4(0.0, 0.0, 0.0, 1.0), screenSample, horizontalBounds * verticalBounds);
  }

  float amberUiMask(vec3 color) {
    float amberDelta = color.r - max(color.g, color.b);
    return smoothstep(0.0015, 0.025, amberDelta)
      * smoothstep(0.003, 0.05, color.r);
  }

  float rectMask(vec2 point, vec2 minimum, vec2 maximum) {
    vec2 feather = vec2(0.0015);
    return smoothstep(minimum.x, minimum.x + feather.x, point.x)
      * (1.0 - smoothstep(maximum.x - feather.x, maximum.x, point.x))
      * smoothstep(minimum.y, minimum.y + feather.y, point.y)
      * (1.0 - smoothstep(maximum.y - feather.y, maximum.y, point.y));
  }

  float headingRegionMask(vec2 fittedUv) {
    float horizontal = smoothstep(-0.03, 0.015, fittedUv.x)
      * (1.0 - smoothstep(0.58, 0.63, fittedUv.x));
    float vertical = smoothstep(0.825, 0.85, fittedUv.y)
      * (1.0 - smoothstep(0.985, 1.025, fittedUv.y));
    return horizontal * vertical;
  }

  void main() {
    vec2 centered = vUv - 0.5;
    float suction = clamp((uEntry - 0.88) / 0.12, 0.0, 1.0);
    float decay = (1.0 - suction) * exp(-2.2 * suction);
    float bounce = decay * cos(suction * 7.8539816);
    float wobble = decay * sin(suction * 9.424778);
    float zoom = 1.0 + 0.18 * bounce;
    vec2 wobbleScale = vec2(1.0 + 0.038 * wobble, 1.0 - 0.026 * wobble);
    vec2 zoomedUv = centered / (zoom * wobbleScale) + 0.5;
    float centeredLength = max(length(centered), 0.0001);
    float radialRipple = sin(centeredLength * 27.0 - suction * 11.0) * decay * 0.006;
    zoomedUv += (centered / centeredLength) * radialRipple;
    vec2 fittedContentUv = fitScreenUv(zoomedUv);
    float contentWarpStrength = mix(0.56, 0.14, smoothstep(0.0, 1.0, suction));
    float edgeWarpStrength = mix(0.30, 0.16, smoothstep(0.0, 1.0, suction));
    vec2 warpedUiUv = distortUv(fittedContentUv, contentWarpStrength);
    vec2 warpedReflectionUv = distortUv(zoomedUv, contentWarpStrength);
    vec2 maskCenter = centered / vec2(1.0 + 0.018 * wobble, 1.0 - 0.012 * wobble);
    vec2 maskUv = distortUv(maskCenter + 0.5, edgeWarpStrength);

    float screenDistance = roundedRectDistance(
      maskUv - 0.5,
      vec2(0.496, 0.492),
      0.036
    );
    float screenMask = 1.0 - smoothstep(-0.0015, 0.0025, screenDistance);

    vec3 reflectionSample = sampleReflection(warpedReflectionUv).rgb;
    vec3 reflectionFill = sampleReflection(
      warpedReflectionUv - vec2(0.0, 0.36)
    ).rgb;
    vec3 uiSample = sampleUi(warpedUiUv).rgb;

    // Translate the supplied CSS glitch into the texture shader so the
    // original pixel lettering and amber color remain intact. Only the heading
    // region is resampled; the rest of the UI keeps its existing mapping.
    float glitchClock = max(uTime - 4.0, 0.0);
    float glitchCycle = floor(glitchClock / 8.0);
    float glitchPhase = fract(glitchClock / 8.0);
    float reverseCycle = mod(glitchCycle, 2.0);
    glitchPhase = mix(glitchPhase, 1.0 - glitchPhase, reverseCycle);
    float glitchEnabled = step(4.0, uTime);
    float distortionPulseA = smoothstep(0.105, 0.114, glitchPhase)
      * (1.0 - smoothstep(0.126, 0.138, glitchPhase));
    float distortionPulseB = smoothstep(0.164, 0.174, glitchPhase)
      * (1.0 - smoothstep(0.186, 0.198, glitchPhase));
    float jerkWindow = max(distortionPulseA, distortionPulseB)
      * glitchEnabled;

    // Keep only the brief flash-and-distort moments: almost no travel, a tiny
    // scale pulse, and just enough skew to make the phosphor image twitch.
    float jerkX = (-0.0015 * distortionPulseA + 0.0020 * distortionPulseB)
      * glitchEnabled;
    float jerkScaleY = 1.0
      + (0.025 * distortionPulseA + 0.035 * distortionPulseB)
        * glitchEnabled;
    float jerkSkew = (0.018 * distortionPulseA - 0.014 * distortionPulseB)
      * glitchEnabled;
    vec2 headingCenter = vec2(0.29, 0.89);
    vec2 jerkedHeadingUv = fittedContentUv - headingCenter;
    jerkedHeadingUv.y /= jerkScaleY;
    jerkedHeadingUv.x -= jerkX + jerkedHeadingUv.y * jerkSkew;
    jerkedHeadingUv += headingCenter;
    vec2 jerkedWarpedUiUv = distortUv(
      jerkedHeadingUv,
      contentWarpStrength
    );
    vec3 jerkedUiSample = sampleUi(jerkedWarpedUiUv).rgb;
    float headingRegion = headingRegionMask(fittedContentUv);
    vec3 effectedUiSample = mix(
      uiSample,
      jerkedUiSample,
      headingRegion * jerkWindow
    );

    // Triggr's terminal timing, applied to the existing Hecto pixels: a short
    // cursor-only beat, 10ms per character, and 100ms between the two lines.
    const float terminalTypingStart = 1.36;
    const float terminalLineOneCharacters = 35.0;
    const float terminalLineTwoCharacters = 19.0;
    const float terminalLineTwoTotalCharacters = 22.0;
    const float terminalCharacterTime = 0.01;
    const float terminalLinePause = 0.10;
    const float terminalDotsDelay = 5.0;
    vec2 terminalLineOneMin = vec2(0.031, 0.724);
    vec2 terminalLineOneMax = vec2(0.518, 0.756);
    vec2 terminalLineTwoMin = vec2(0.031, 0.673);
    vec2 terminalLineTwoMax = vec2(0.375, 0.704);
    const float terminalLineTwoBaseEnd = 0.335;
    float terminalLineTwoStart = terminalTypingStart
      + terminalLineOneCharacters * terminalCharacterTime
      + terminalLinePause;
    float terminalTypingComplete = terminalLineTwoStart
      + terminalLineTwoCharacters * terminalCharacterTime;
    float terminalDotsStart = terminalTypingComplete + terminalDotsDelay;
    float terminalLineOneTyped = clamp(
      floor(max(uTime - terminalTypingStart, 0.0) / terminalCharacterTime),
      0.0,
      terminalLineOneCharacters
    );
    float terminalLineTwoTyped = clamp(
      floor(max(uTime - terminalLineTwoStart, 0.0) / terminalCharacterTime),
      0.0,
      terminalLineTwoCharacters
    );
    float terminalDotCycle = mod(max(uTime - terminalDotsStart, 0.0), 1.35);
    float terminalDotCount = min(3.0, floor(terminalDotCycle / 0.18));
    float terminalDotsActive = step(terminalDotsStart, uTime);
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
    float terminalLineOneRegion = rectMask(
      warpedUiUv,
      terminalLineOneMin,
      terminalLineOneMax
    );
    float terminalLineTwoRegion = rectMask(
      warpedUiUv,
      terminalLineTwoMin,
      terminalLineTwoMax
    );
    float terminalLineOneReveal = 1.0 - smoothstep(
      terminalLineOneCutoff - 0.0008,
      terminalLineOneCutoff + 0.0008,
      warpedUiUv.x
    );
    float terminalLineTwoReveal = 1.0 - smoothstep(
      terminalLineTwoCutoff - 0.0008,
      terminalLineTwoCutoff + 0.0008,
      warpedUiUv.x
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
    effectedUiSample *= 1.0 - terminalHiddenText;

    float terminalOnSecondLine = step(terminalLineTwoStart, uTime);
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
    float terminalCursorOpacity = step(0.96, uTime)
      * (1.0 - fract(max(uTime - 0.96, 0.0)));
    float terminalCursor = rectMask(
      warpedUiUv,
      vec2(terminalCursorX, terminalCursorY + 0.003),
      vec2(terminalCursorX + 0.008, terminalCursorY + 0.027)
    ) * terminalCursorOpacity;

    // Rebuild the bar from the texture's own first amber block. The same
    // progress uniform drives both this view and the physical Three.js screen,
    // so the fullscreen handoff continues instead of restarting the animation.
    const float loadingSegmentCount = 23.0;
    vec2 loadingBarMin = vec2(0.043, 0.611);
    vec2 loadingBarMax = vec2(0.931, 0.641);
    float loadingBoundsX = smoothstep(
      loadingBarMin.x,
      loadingBarMin.x + 0.003,
      warpedUiUv.x
    ) * (1.0 - smoothstep(
      loadingBarMax.x - 0.003,
      loadingBarMax.x,
      warpedUiUv.x
    ));
    float loadingBoundsY = smoothstep(
      loadingBarMin.y,
      loadingBarMin.y + 0.003,
      warpedUiUv.y
    ) * (1.0 - smoothstep(
      loadingBarMax.y - 0.003,
      loadingBarMax.y,
      warpedUiUv.y
    ));
    float loadingBarInterior = loadingBoundsX * loadingBoundsY;
    float loadingPosition = clamp(
      (warpedUiUv.x - loadingBarMin.x)
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
        0.043,
        0.074,
        clamp((loadingCellX - 0.08) / 0.72, 0.0, 1.0)
      ),
      warpedUiUv.y
    );
    vec3 loadingSegmentColor = sampleUi(loadingSourceUv).rgb;
    float proceduralLoadingBlock = loadingBarInterior
      * loadingCellMask
      * loadingOpacity
      * amberUiMask(loadingSegmentColor);

    float sliceWindow = max(distortionPulseA, distortionPulseB)
      * glitchEnabled;
    float sliceFrame = floor(glitchPhase * 100.0);
    float sliceTopA = mix(
      0.825,
      0.980,
      hash21(vec2(sliceFrame, glitchCycle + 31.0))
    );
    float sliceBottomA = mix(
      0.825,
      0.980,
      hash21(vec2(sliceFrame + 17.0, glitchCycle + 47.0))
    );
    float sliceTopB = mix(
      0.825,
      0.980,
      hash21(vec2(sliceFrame + 53.0, glitchCycle + 7.0))
    );
    float sliceBottomB = mix(
      0.825,
      0.980,
      hash21(vec2(sliceFrame + 71.0, glitchCycle + 13.0))
    );
    float sliceFeather = max(fwidth(fittedContentUv.y) * 1.2, 0.0008);
    float sliceBandA = smoothstep(
      sliceTopA - sliceFeather,
      sliceTopA + sliceFeather,
      fittedContentUv.y
    ) * (1.0 - smoothstep(
      sliceBottomA - sliceFeather,
      sliceBottomA + sliceFeather,
      fittedContentUv.y
    )) * step(sliceTopA, sliceBottomA);
    float sliceBandB = smoothstep(
      sliceTopB - sliceFeather,
      sliceTopB + sliceFeather,
      fittedContentUv.y
    ) * (1.0 - smoothstep(
      sliceBottomB - sliceFeather,
      sliceBottomB + sliceFeather,
      fittedContentUv.y
    )) * step(sliceTopB, sliceBottomB);
    sliceBandA *= sliceWindow * headingRegion;
    sliceBandB *= sliceWindow * headingRegion;
    float sliceShiftA = 3.0 / 1210.0;
    float sliceShiftB = 3.0 / 1210.0;
    vec2 sliceWarpA = distortUv(
      fittedContentUv + vec2(sliceShiftA, 0.0),
      contentWarpStrength
    );
    vec2 sliceWarpB = distortUv(
      fittedContentUv - vec2(sliceShiftB, 0.0),
      contentWarpStrength
    );
    vec2 sliceBlur = vec2(0.0, 2.0 / 880.0);
    vec3 sliceSampleA = (
      sampleUi(sliceWarpA - sliceBlur).rgb
      + sampleUi(sliceWarpA).rgb
      + sampleUi(sliceWarpA + sliceBlur).rgb
    ) / 3.0;
    vec3 sliceSampleB = (
      sampleUi(sliceWarpB - sliceBlur * 0.65).rgb
      + sampleUi(sliceWarpB).rgb
      + sampleUi(sliceWarpB + sliceBlur * 0.65).rgb
    ) / 3.0;

    float reflectionUi = amberUiMask(reflectionSample);
    float containedUi = amberUiMask(effectedUiSample);
    containedUi *= 1.0 - loadingBarInterior;
    vec3 color = mix(reflectionSample, reflectionFill, reflectionUi);
    vec2 reflectionEdge = abs(maskUv - 0.5) * 2.0;
    float reflectionSideMask = 1.0 - smoothstep(
      0.88,
      0.91,
      reflectionEdge.x
    );
    color *= reflectionSideMask;
    color = mix(color, effectedUiSample, containedUi);
    color = mix(
      color,
      sliceSampleA,
      sliceBandA * amberUiMask(sliceSampleA)
    );
    color = mix(
      color,
      sliceSampleB,
      sliceBandB * amberUiMask(sliceSampleB)
    );
    color = mix(
      color,
      loadingSegmentColor,
      proceduralLoadingBlock
    );
    color = mix(
      color,
      vec3(0.94, 0.245, 0.008),
      terminalCursor
    );

    vec2 edge = abs(centered) * 2.0;
    float squircle = pow(pow(edge.x, 8.0) + pow(edge.y, 8.0), 1.0 / 8.0);
    float sideShade = 1.0 - smoothstep(0.86, 1.02, edge.x) * 0.34;
    float cornerShade = 1.0 - smoothstep(0.82, 1.02, squircle) * 0.30;
    color *= sideShade * cornerShade;
    float tunnelShade = 1.0 - smoothstep(0.16, 0.72, centeredLength) * decay * 0.68;
    color *= tunnelShade;

    float scanline = sin(warpedUiUv.y * uResolution.y * 1.18 + uTime * 18.0) * 0.008;
    float grain = (hash21(gl_FragCoord.xy + floor(uTime * 42.0)) - 0.5) * 0.024;
    color += scanline + grain;
    color *= smoothstep(0.88, 1.0, uEntry);
    color *= screenMask;

    gl_FragColor = vec4(color, uBlend);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
