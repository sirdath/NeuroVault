import React, { Suspense } from "react"
import { ThreeCanvas } from "@remotion/three"
import { useVideoConfig } from "remotion"
import { GlobeSphere } from "./GlobeSphere"
import { GlobeDots } from "./GlobeDots"
import { GlobeAtmosphere } from "./GlobeAtmosphere"
import { GlobeShockwave } from "./GlobeShockwave"
import { GlobeArcs } from "./GlobeArcs"

interface GlobeProps {
  companies: Array<{ ticker: string; lat: number; lng: number }>
  rotation?: number
  cameraZ?: number
  cameraLat?: number
  cameraLng?: number
  affectedTickers?: Set<string>
  dimmedTickers?: Set<string>
  highlightTickers?: Set<string>
  shockwaves?: Array<{ lat: number; lng: number; progress: number; color: string }>
  arcs?: {
    epicenterLat: number
    epicenterLng: number
    arcs: Array<{ endLat: number; endLng: number; color: string; progress: number }>
  }
  opacity?: number
}

export const Globe: React.FC<GlobeProps> = ({
  companies,
  rotation = 0,
  cameraZ = 2.5,
  affectedTickers,
  dimmedTickers,
  highlightTickers,
  shockwaves = [],
  arcs,
  opacity = 1,
}) => {
  const { width, height } = useVideoConfig()

  return (
    <div style={{ width: "100%", height: "100%", opacity }}>
      <ThreeCanvas
        width={width}
        height={height}
        camera={{ position: [0, 0, cameraZ], fov: 45 }}
        style={{ background: "transparent" }}
      >
        <ambientLight intensity={0.6} />
        <pointLight position={[5, 3, 5]} intensity={0.8} />
        <pointLight position={[-5, -3, -5]} intensity={0.3} color="#1a6bcc" />

        <group rotation={[0.1, rotation, 0]}>
          <Suspense fallback={null}>
            <GlobeSphere />
          </Suspense>
          <GlobeDots
            companies={companies}
            affectedTickers={affectedTickers}
            dimmedTickers={dimmedTickers}
            highlightTickers={highlightTickers}
          />
          <GlobeAtmosphere />

          {shockwaves.map((sw, i) => (
            <GlobeShockwave key={i} {...sw} />
          ))}

          {arcs && <GlobeArcs {...arcs} />}
        </group>
      </ThreeCanvas>
    </div>
  )
}
