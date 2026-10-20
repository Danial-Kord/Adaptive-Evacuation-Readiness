import React from "react";

/* Decorative hero art for the hurricane themes. Purely visual (aria-hidden). */

export type Theme = "base" | "watch" | "eye" | "chart";

// The National Weather Service hurricane symbol: a disc with two curved arms.
function HurricaneGlyph({ size = 40, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="-30 -30 60 60" aria-hidden="true">
      <circle r="9" fill="none" stroke={color} strokeWidth="5" />
      <path d="M0,-9 C14,-10 24,-2 24,12" fill="none" stroke={color} strokeWidth="5" strokeLinecap="round" />
      <path d="M0,9 C-14,10 -24,2 -24,-12" fill="none" stroke={color} strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}

export function HeroArt({ theme }: { theme: Theme }) {
  if (theme === "watch") {
    return (
      <div className="hero-art radar" aria-hidden="true">
        <div className="radar-rings" />
        <div className="radar-sweep" />
        <span className="radar-blip b1" /><span className="radar-blip b2" /><span className="radar-blip b3" />
      </div>
    );
  }
  if (theme === "eye") {
    return (
      <div className="hero-art eye" aria-hidden="true">
        <svg className="eye-spiral" viewBox="-100 -100 200 200">
          {[0, 60, 120, 180, 240, 300].map((r) => (
            <path key={r} transform={`rotate(${r})`} d="M0,-14 C40,-20 78,8 70,62" fill="none" stroke="rgba(255,255,255,.22)" strokeWidth="14" strokeLinecap="round" />
          ))}
          <circle r="16" fill="rgba(255,255,255,.16)" />
        </svg>
      </div>
    );
  }
  if (theme === "chart") {
    // A storm track plotted across the chart: past positions solid, forecast dashed.
    const pts: [number, number][] = [[20, 210], [110, 185], [200, 150], [280, 120], [350, 98], [410, 84]];
    return (
      <div className="hero-art track" aria-hidden="true">
        <svg viewBox="0 0 440 240" className="track-svg">
          <polyline points={pts.slice(0, 4).map((p) => p.join(",")).join(" ")} fill="none" stroke="#c0392b" strokeWidth="3" />
          <polyline points={pts.slice(3).map((p) => p.join(",")).join(" ")} fill="none" stroke="#c0392b" strokeWidth="3" strokeDasharray="8 7" />
          <path d="M280,120 L440,40 L440,170 Z" fill="rgba(192,57,43,.08)" stroke="rgba(192,57,43,.35)" strokeDasharray="4 4" />
        </svg>
        {pts.map(([x, y], i) => (
          <span key={i} className="track-dot" style={{ left: `${(x / 440) * 100}%`, top: `${(y / 240) * 100}%` }}>
            {i < 4 ? <HurricaneGlyph size={i === 3 ? 30 : 20} color="#c0392b" /> : <span className="track-open" />}
          </span>
        ))}
        <span className="track-label">Season peak · Sep 10</span>
      </div>
    );
  }
  return null;
}

export { HurricaneGlyph };
