/**
 * ParticleWaveBackground — Bright-style dot ripple animation background (pure Canvas, zero external dependencies).
 *
 * Visual reference to React Bits' Particles / DotGrid: a grid of dots with undulating effects driven by multi-layer sine waves,
 * where the radius and opacity of the points change with the wave peaks, creating a "breathing" soft ripple.
 *
 * Why not directly install the React Bits package:
 *   Its Particles / DotGrid / Aurora each depend on ogl / gsap / three, which this project has not installed.
 *   Implement it via the manual method recommended by the React Bits official (copying source code into the project) to avoid adding new runtime dependencies
 *   and build risks, while retaining fully controllable visual parameter adjustment capabilities.
 *
 * Implementation points:
 *   - Adapt to devicePixelRatio to avoid blur on high-definition screens;
 *   - Use ResizeObserver to follow container size, and do not listen to window to avoid interference between multiple instances;
 *   - Respect prefers-reduced-motion: when motion is preferred to be reduced, render a static frame and do not start rAF;
 *   - Cancel rAF and observer when the component is unmounted, with no memory leaks.
 */
import { useEffect, useRef } from 'react';

export interface ParticleWaveBackgroundProps {
  /** Dot spacing (px), smaller means denser. Default 26 */
  gap?: number;
  /** Base radius of a point (px). Default 1.5 */
  dotRadius?: number;
  /** Point color, must be in `r, g, b` format (opacity calculated internally based on peaks). Default dark gray blue */
  color?: string;
  /** Animation speed coefficient, default 1 */
  speed?: number;
  /** Additional class name */
  className?: string;
}

export default function ParticleWaveBackground({
  gap = 26,
  dotRadius = 1.5,
  color = '100, 116, 139',
  speed = 1,
  className,
}: ParticleWaveBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = 0;
    let width = 0;
    let height = 0;
    let disposed = false;

    const reduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function resize() {
      const parent = canvas!.parentElement;
      if (!parent) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = parent.clientWidth;
      height = parent.clientHeight;
      canvas!.width = Math.max(1, Math.floor(width * dpr));
      canvas!.height = Math.max(1, Math.floor(height * dpr));
      canvas!.style.width = `${width}px`;
      canvas!.style.height = `${height}px`;
      // Use setTransform instead of scale to avoid scaling coefficient accumulation after multiple resizes
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /**
     * Render a frame. Three sine waves with different frequencies/phases are superimposed to obtain an intensity field in [-1, 1];
     * The intensity is mapped to the radius and opacity of points, forming a rippling point array of light and dark variations.
     *
     * Parameter value description: The time coefficient determines "how fast it looks like it is moving". When too small (<0.5), a single wave period will last for over ten seconds, making it almost impossible to tell with the naked eye that it is moving, like a static image; here 0.65~1.15 is taken to make the main wave about 5 seconds
     * one period, which can clearly show the sense of flow without being dazzling.
     *
     */
    function draw(elapsedMs: number) {
      if (width <= 0 || height <= 0) return;
      const t = (elapsedMs / 1000) * speed;
      ctx!.clearRect(0, 0, width, height);

      const cols = Math.ceil(width / gap) + 1;
      const rows = Math.ceil(height / gap) + 1;

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const x = col * gap;
          const y = row * gap;
          // Normalize coordinates so the waveform does not distort with canvas size
          const nx = x / Math.max(width, 1);
          const ny = y / Math.max(height, 1);

          // The main wave flows from right to left, with two other layers superimposed at different angles, to avoid regular stripes
          const wave =
            Math.sin(nx * 7.5 - t * 1.15) * 0.45 +
            Math.sin(ny * 5.5 + t * 0.75) * 0.28 +
            Math.sin((nx * 3.2 + ny * 4.1) + t * 0.95) * 0.27;

          // wave ∈ [-1, 1] → intensity ∈ [0, 1]
          const intensity = (wave + 1) / 2;
          // Shrink the dark areas by power, making the peaks more prominent and the valleys cleaner, with clearer light and dark contrast
          const shaped = Math.pow(intensity, 1.4);
          // Slightly faded at the top and slightly solid at the bottom, enhancing the sense of light coming from above
          const depth = 0.6 + ny * 0.4;
          const alpha = (0.08 + shaped * 0.5) * depth;
          const radius = dotRadius * (0.45 + shaped * 1.15);
          if (alpha <= 0.01 || radius <= 0.05) continue;

          ctx!.beginPath();
          ctx!.fillStyle = `rgba(${color}, ${alpha.toFixed(3)})`;
          ctx!.arc(x, y, radius, 0, Math.PI * 2);
          ctx!.fill();
        }
      }
    }

    function loop(now: number) {
      if (disposed) return;
      draw(now);
      rafId = window.requestAnimationFrame(loop);
    }

    resize();

    const observer = new ResizeObserver(() => {
      resize();
      // When reducing animations, do not run rAF, and manually draw one frame after resize
      if (reduceMotion) draw(0);
    });
    const parent = canvas.parentElement;
    if (parent) observer.observe(parent);

    if (reduceMotion) {
      draw(0);
    } else {
      rafId = window.requestAnimationFrame(loop);
    }

    return () => {
      disposed = true;
      if (rafId) window.cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [gap, dotRadius, color, speed]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
