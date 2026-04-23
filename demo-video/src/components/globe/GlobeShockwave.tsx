import React, { useMemo } from "react"
import * as THREE from "three"
import { latLngToVector3 } from "../../lib/globe-math"

interface GlobeShockwaveProps {
  lat: number
  lng: number
  progress: number
  color: string
  maxRadius?: number
}

export const GlobeShockwave: React.FC<GlobeShockwaveProps> = ({
  lat,
  lng,
  progress,
  color,
  maxRadius = 0.15,
}) => {
  const position = useMemo(() => latLngToVector3(lat, lng, 1.006), [lat, lng])
  const normal = useMemo(() => position.clone().normalize(), [position])
  const quaternion = useMemo(() => {
    const q = new THREE.Quaternion()
    q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal)
    return q
  }, [normal])

  if (progress <= 0 || progress >= 1) return null

  const innerR = progress * maxRadius * 0.8
  const outerR = progress * maxRadius
  const opacity = (1 - progress) * 0.6

  return (
    <mesh position={position} quaternion={quaternion}>
      <ringGeometry args={[innerR, outerR, 64]} />
      <meshBasicMaterial color={color} transparent opacity={opacity} side={2} />
    </mesh>
  )
}
