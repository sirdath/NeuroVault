export interface Company {
  ticker: string
  name: string
  sector: string
  lat: number
  lng: number
  mc: number
}

export interface RiskEntry {
  score: number
  reasoning: string
}

export interface DemoEvent {
  id: string
  type: 'natural_disaster' | 'geopolitical' | 'macro'
  title: string
  description: string
  severity: 1 | 2 | 3 | 4 | 5
  source: string
  affected_countries: string[]
  affected_sectors: string[]
  lat: number
  lng: number
  created_at: string
  risks: Record<string, RiskEntry>
}

export interface SupplyChainEdge {
  from_ticker: string
  to_ticker: string
  relationship: string
  weight: number
  description: string
}
