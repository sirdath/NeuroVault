export const T = {
  bg0: '#080D1A',
  bg1: '#0A0F1E',
  bg2: '#0F172A',
  card: 'rgba(15,23,42,0.8)',
  cardSolid: '#0F172A',
  border: 'rgba(59,130,246,0.15)',
  borderActive: 'rgba(59,130,246,0.4)',
  borderBright: 'rgba(59,130,246,0.5)',
  blue: '#3B82F6',
  deepBlue: '#1D4ED8',
  red: '#EF4444',
  orange: '#F97316',
  yellow: '#EAB308',
  green: '#22C55E',
  gold: '#FFD700',
  purple: '#8B5CF6',
  cyan: '#06B6D4',
  text0: '#F8FAFC',
  text1: '#94A3B8',
  text2: '#64748B',
  text3: '#475569',
  text4: '#334155',
  syne: "'Syne', sans-serif",
  mono: "'JetBrains Mono', monospace",
} as const

export const riskColor = (score: number): string => {
  if (score >= 0.8) return T.red
  if (score >= 0.6) return T.orange
  if (score >= 0.4) return T.yellow
  if (score >= 0.2) return T.green
  return T.blue
}

export const severityColor = (s: number): string =>
  (["", "#22C55E", "#84CC16", "#EAB308", "#F97316", "#EF4444"][s]) || "#64748B"

export const riskLabel = (score: number): string => {
  if (score >= 0.8) return "CRITICAL"
  if (score >= 0.6) return "HIGH"
  if (score >= 0.4) return "MEDIUM"
  if (score >= 0.2) return "LOW"
  return "MINIMAL"
}
