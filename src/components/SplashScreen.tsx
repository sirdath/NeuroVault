import { useEffect, useState } from "react";
import logo from "../assets/vault-mark-transparent.png";

/**
 * Fast, futuristic app-open animation: the NeuroVault mark fades in, two
 * neural rings draw themselves around it (with orbiting nodes), then the whole
 * thing zooms through and dissolves to reveal the app — ~1.4s total.
 *
 * Rendered once at the root (main.tsx), over the app, and self-unmounts. The
 * App mounts underneath immediately, so the reveal is instant. Honours
 * prefers-reduced-motion (a plain quick fade, no motion).
 */
export function SplashScreen() {
  // "in" → playing · "out" → leaving (zoom + fade) · then unmount.
  const [phase, setPhase] = useState<"in" | "out">("in");
  const [mounted, setMounted] = useState(true);

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const hold = reduce ? 350 : 1050; // time the rings play before leaving
    const leave = reduce ? 250 : 450; // fade/zoom-out duration
    const t1 = window.setTimeout(() => setPhase("out"), hold);
    const t2 = window.setTimeout(() => setMounted(false), hold + leave);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, []);

  if (!mounted) return null;

  return (
    <div className={`nv-splash ${phase === "out" ? "nv-splash--out" : ""}`} aria-hidden="true">
      <style>{SPLASH_CSS}</style>
      <div className="nv-splash-stage">
        {/* neural rings */}
        <svg className="nv-splash-rings" viewBox="0 0 240 240" width="240" height="240">
          <defs>
            <radialGradient id="nv-splash-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgba(47,123,246,0.35)" />
              <stop offset="70%" stopColor="rgba(47,123,246,0.06)" />
              <stop offset="100%" stopColor="rgba(47,123,246,0)" />
            </radialGradient>
          </defs>
          <circle className="nv-splash-haze" cx="120" cy="120" r="118" fill="url(#nv-splash-glow)" />
          {/* outer ring — draws in, slow spin */}
          <circle className="nv-splash-ring nv-splash-ring--outer" cx="120" cy="120" r="104" />
          {/* inner ring — draws in, counter-spin */}
          <circle className="nv-splash-ring nv-splash-ring--inner" cx="120" cy="120" r="86" />
          {/* orbiting nodes (the neural motif, echoing the website) */}
          <g className="nv-splash-orbit">
            <circle className="nv-splash-node" cx="120" cy="16" r="3.4" />
            <circle className="nv-splash-node" cx="224" cy="120" r="3.4" />
            <circle className="nv-splash-node" cx="120" cy="224" r="3.4" />
            <circle className="nv-splash-node" cx="16" cy="120" r="3.4" />
          </g>
        </svg>
        {/* logo */}
        <img className="nv-splash-logo" src={logo} alt="" width={108} height={108} />
      </div>
    </div>
  );
}

const SPLASH_CSS = `
.nv-splash{
  position:fixed; inset:0; z-index:99999;
  display:flex; align-items:center; justify-content:center;
  background:
    radial-gradient(ellipse at 50% 45%, var(--nv-accent-glow) 0%, transparent 52%),
    var(--nv-bg);
  animation: nv-splash-bgin .35s ease-out both;
}
.nv-splash--out{ animation: nv-splash-leave .45s cubic-bezier(.55,0,.3,1) forwards; }
@keyframes nv-splash-bgin{ from{opacity:0} to{opacity:1} }
@keyframes nv-splash-leave{
  to{ opacity:0; transform:scale(1.18); filter:blur(2px); }
}
.nv-splash-stage{ position:relative; width:240px; height:240px;
  display:flex; align-items:center; justify-content:center; }
.nv-splash-rings{ position:absolute; inset:0; }
.nv-splash-haze{ opacity:0; animation: nv-fadein .6s .1s ease-out forwards; }

.nv-splash-ring{
  fill:none; stroke:var(--nv-accent); stroke-linecap:round;
  filter: drop-shadow(0 0 6px var(--nv-accent-glow));
  transform-origin:120px 120px; transform-box:fill-box;
}
.nv-splash-ring--outer{
  stroke-width:1.6; stroke-dasharray:653; stroke-dashoffset:653;
  opacity:.9;
  animation: nv-draw .9s .12s cubic-bezier(.2,.7,.2,1) forwards,
             nv-spin 9s .9s linear infinite;
}
.nv-splash-ring--inner{
  stroke-width:1.2; stroke:color-mix(in srgb, var(--nv-accent) 68%, var(--nv-text)); stroke-dasharray:540; stroke-dashoffset:540;
  opacity:.6;
  animation: nv-draw .8s .22s cubic-bezier(.2,.7,.2,1) forwards,
             nv-spin-rev 7s .8s linear infinite;
}
.nv-splash-orbit{ transform-origin:120px 120px; transform-box:fill-box;
  opacity:0; animation: nv-fadein .5s .55s ease-out forwards, nv-spin 6s .55s linear infinite; }
.nv-splash-node{ fill:color-mix(in srgb, var(--nv-accent) 72%, var(--nv-text)); filter: drop-shadow(0 0 4px var(--nv-accent-glow)); }

.nv-splash-logo{
  position:relative; width:108px; height:108px; object-fit:contain;
  filter:drop-shadow(0 14px 24px color-mix(in srgb, var(--nv-accent) 28%, transparent));
  opacity:0; transform:scale(.82);
  animation: nv-pop .55s .05s cubic-bezier(.2,.9,.25,1.3) forwards;
}
@keyframes nv-draw{ to{ stroke-dashoffset:0; } }
@keyframes nv-spin{ to{ transform:rotate(360deg); } }
@keyframes nv-spin-rev{ to{ transform:rotate(-360deg); } }
@keyframes nv-pop{ 0%{opacity:0; transform:scale(.82)} 60%{opacity:1} 100%{opacity:1; transform:scale(1)} }
@keyframes nv-fadein{ to{ opacity:1; } }

@media (prefers-reduced-motion: reduce){
  .nv-splash, .nv-splash-logo, .nv-splash-haze, .nv-splash-orbit{ animation:none; opacity:1; }
  .nv-splash-logo{ transform:none; }
  .nv-splash-ring{ stroke-dashoffset:0; animation:none; }
  .nv-splash--out{ animation: nv-splash-leave .25s ease forwards; }
}
`;
