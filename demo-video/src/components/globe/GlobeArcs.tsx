import React, { useMemo } from "react"
import * as THREE from "three"
import { greatCircleArc } from "../../lib/globe-math"

interface ArcData {
  endLat: number
  endLng: number
  color: string
  progress: number
  label?: string
}

interface GlobeArcsProps {
  epicenterLat: number
  epicenterLng: number
  arcs: ArcData[]
}

export const GlobeArcs: React.FC<GlobeArcsProps> = ({
  epicenterLat,
  epicenterLng,
  arcs,
}) => {
  return (
    <group>
      {arcs.map((arc, i) => (
        <SingleArc
          key={i}
          startLat={epicenterLat}
          startLng={epicenterLng}
          endLat={arc.endLat}
          endLng={arc.endLng}
          color={arc.color}
          progress={arc.progress}
        />
      ))}
    </group>
  )
}

const SingleArc: React.FC<{
  startLat: number
  startLng: number
  endLat: number
  endLng: number
  color: string
  progress: number
}> = ({ startLat, startLng, endLat, endLng, color, progress }) => {
  const lineObj = useMemo(() => {
    const points = greatCircleArc(
      { lat: startLat, lng: startLng },
      { lat: endLat, lng: endLng },
      0.25,
      50
    )
    const count = Math.max(2, Math.floor(points.length * Math.max(0, Math.min(1, progress))))
    const subset = points.slice(0, count)
    const geo = new THREE.BufferGeometry().setFromPoints(subset)
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 })
    return new THREE.Line(geo, mat)
  }, [startLat, startLng, endLat, endLng, color, progress])

  if (progress <= 0) return null

  return <primitive object={lineObj} />
}
