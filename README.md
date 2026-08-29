# Hecto

A scrollytelling CRT scene built with Next.js and Three.js. Scrolling drives a
camera move toward a CRT monitor sitting on sand; the screen lights the
environment around it.

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Layout

- `src/app/` — route, root layout, and global styles. The scene lives at `/`.
- `src/features/crt/` — the scene itself:
  - `crt-scene.tsx` — Three.js setup, scroll wiring (Lenis + motion springs)
  - `sand-environment.ts` — terrain, sky, and opening atmosphere
  - `screen-light.ts` — the light the screen casts onto the sand
  - `crt-reflection.ts` — front-surface glass reflection
  - `crt-entry-shader.ts` — entry transition
- `src/features/grain/` — film-grain overlay.
- `public/assets/figma/crt-reference.png` — artwork sampled onto the screen.

## Credits

Shader techniques are adapted from these MIT-licensed CodePen sources, with
attribution in the files that borrow from them:

- [It Is All Just a Reflection](https://codepen.io/atzedent/pen/PovvpvR) — Matthias Hurrle
- [WebGL Scroll Sync V2](https://codepen.io/luis-lessrain/pen/bNwBYMM) — Luis Alberto Martinez Riancho
