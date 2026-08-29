"use client";

import { useEffect, useRef } from "react";

import styles from "./grain-overlay.module.css";

const GRAIN_ALPHA = 36;
const GRAIN_FPS = 24;
const FRAME_DURATION = 1000 / GRAIN_FPS;

export function GrainOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");

    if (!canvas || !context) {
      return;
    }

    let width = 1;
    let height = 1;
    let grain = context.createImageData(width, height);
    let animationFrame = 0;
    let lastTime = 0;

    const resizeCanvas = () => {
      width = Math.max(1, Math.floor(window.innerWidth));
      height = Math.max(1, Math.floor(window.innerHeight));
      canvas.width = width;
      canvas.height = height;
      grain = context.createImageData(width, height);
    };

    const generateGrain = () => {
      const pixels = grain.data;

      for (let index = 0; index < pixels.length; index += 4) {
        const gray = Math.floor(Math.random() * 256);
        pixels[index] = gray;
        pixels[index + 1] = gray;
        pixels[index + 2] = gray;
        pixels[index + 3] = GRAIN_ALPHA;
      }

      context.putImageData(grain, 0, 0);
    };

    const loop = (currentTime: number) => {
      animationFrame = window.requestAnimationFrame(loop);
      const elapsed = currentTime - lastTime;

      if (elapsed >= FRAME_DURATION) {
        lastTime = currentTime - (elapsed % FRAME_DURATION);
        generateGrain();
      }
    };

    resizeCanvas();
    generateGrain();
    animationFrame = window.requestAnimationFrame(loop);
    window.addEventListener("resize", resizeCanvas);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", resizeCanvas);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={styles.grain}
      aria-hidden="true"
    />
  );
}
