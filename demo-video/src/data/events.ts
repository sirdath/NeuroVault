import { DemoEvent, SupplyChainEdge } from './types'

export const TAIWAN_EVENT: DemoEvent = {
  id: "evt_001",
  type: "natural_disaster",
  title: "M7.4 Earthquake — Taiwan",
  description: "Major earthquake strikes Hualien County, Taiwan. TSMC has paused operations at Fab 18. Aftershocks continuing.",
  severity: 5,
  source: "USGS",
  affected_countries: ["Taiwan"],
  affected_sectors: ["Technology", "Semiconductors"],
  lat: 24.0, lng: 121.6,
  created_at: "2026-03-08T09:42:00.000Z",
  risks: {
    NVDA: { score: 0.94, reasoning: "90% of supply chain routed through TSMC Taiwan fabs" },
    AAPL: { score: 0.88, reasoning: "25% supply chain + 19% revenue exposure to Taiwan/China" },
    AMD:  { score: 0.85, reasoning: "TSMC manufactures >80% of AMD chips at Taiwan fabs" },
    QCOM: { score: 0.81, reasoning: "Heavy reliance on TSMC for 5G modem production" },
    INTC: { score: 0.61, reasoning: "Partial exposure through TSMC advanced packaging" },
    MSFT: { score: 0.42, reasoning: "Azure hardware supply chain partially affected" },
    TSLA: { score: 0.38, reasoning: "Semiconductor shortage risk for vehicle production" },
    GOOGL:{ score: 0.35, reasoning: "TPU chip supply chain indirectly exposed" },
    AMZN: { score: 0.28, reasoning: "AWS custom silicon supply partially affected" },
    META: { score: 0.22, reasoning: "AI accelerator procurement mildly impacted" },
  }
}

export const RELATIONSHIP_COLORS: Record<string, string> = {
  chip_fab: '#06B6D4',
  component: '#A78BFA',
  ai_compute: '#F59E0B',
  cloud_provider: '#10B981',
  sector_peer: '#60A5FA',
  logistics: '#EC4899',
  semiconductor: '#22D3EE',
  manufacturing: '#F97316',
  raw_materials: '#A3E635',
  software: '#818CF8',
  licensing: '#FB923C',
  energy: '#FACC15',
  financial: '#34D399',
  supplies: '#38BDF8',
}

export const SUPPLY_CHAIN_EDGES: SupplyChainEdge[] = [
  { from_ticker: "ASML", to_ticker: "TSMC", relationship: "semiconductor", weight: 0.95, description: "EUV lithography machines" },
  { from_ticker: "TSMC", to_ticker: "AAPL", relationship: "chip_fab", weight: 0.90, description: "A-series / M-series chip fabrication" },
  { from_ticker: "TSMC", to_ticker: "NVDA", relationship: "chip_fab", weight: 0.92, description: "GPU die fabrication" },
  { from_ticker: "TSMC", to_ticker: "AMD", relationship: "chip_fab", weight: 0.88, description: "CPU/GPU fabrication" },
  { from_ticker: "TSMC", to_ticker: "INTC", relationship: "chip_fab", weight: 0.45, description: "Advanced packaging" },
  { from_ticker: "TSMC", to_ticker: "QCOM", relationship: "chip_fab", weight: 0.85, description: "Snapdragon fabrication" },
  { from_ticker: "AAPL", to_ticker: "INTC", relationship: "component", weight: 0.30, description: "Modem components" },
  { from_ticker: "NVDA", to_ticker: "MSFT", relationship: "ai_compute", weight: 0.80, description: "Azure AI GPU supply" },
  { from_ticker: "NVDA", to_ticker: "GOOGL", relationship: "ai_compute", weight: 0.75, description: "Cloud TPU alternative" },
  { from_ticker: "NVDA", to_ticker: "AMZN", relationship: "ai_compute", weight: 0.70, description: "AWS GPU instances" },
  { from_ticker: "NVDA", to_ticker: "META", relationship: "ai_compute", weight: 0.72, description: "AI training infrastructure" },
  { from_ticker: "AVGO", to_ticker: "AAPL", relationship: "component", weight: 0.65, description: "RF/wireless components" },
  { from_ticker: "MU", to_ticker: "NVDA", relationship: "component", weight: 0.60, description: "HBM memory supply" },
]

export const SEMICONDUCTOR_TICKERS = new Set([
  "TSMC", "NVDA", "AMD", "INTC", "ASML", "AVGO", "QCOM", "MU",
  "KLAC", "AMAT", "LRCX", "SNPS", "CDNS", "ON", "MRVL", "TXN"
])
