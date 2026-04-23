import React, { useRef, useMemo, useEffect } from "react"
import * as THREE from "three"
import { latLngToVector3 } from "../../lib/globe-math"

interface GlobeDotsProps {
  companies: Array<{ ticker: string; lat: number; lng: number }>
  affectedTickers?: Set<string>
  dimmedTickers?: Set<string>
  highlightTickers?: Set<string>
}

export const GlobeDots: React.FC<GlobeDotsProps> = ({
  companies,
  affectedTickers,
  dimmedTickers,
  highlightTickers,
}) => {
  const meshRef = useRef<THREE.InstancedMesh>(null)
  const tempObj = useMemo(() => new THREE.Object3D(), [])
  const tempColor = useMemo(() => new THREE.Color(), [])

  useEffect(() => {
    if (!meshRef.current) return
    const mesh = meshRef.current

    companies.forEach((c, i) => {
      const pos = latLngToVector3(c.lat, c.lng, 1.005)
      tempObj.position.copy(pos)
      // Orient dot to face outward from globe center
      tempObj.lookAt(0, 0, 0)
      tempObj.rotateX(Math.PI)
      tempObj.updateMatrix()
      mesh.setMatrixAt(i, tempObj.matrix)

      // Color logic
      let color = "#3B82F6" // default blue
      if (affectedTickers?.has(c.ticker)) {
        color = "#F59E0B" // amber for affected
      }
      if (dimmedTickers && dimmedTickers.size > 0) {
        if (highlightTickers?.has(c.ticker)) {
          color = "#3B82F6" // bright
        } else {
          color = "#1E293B" // dimmed
        }
      }
      tempColor.set(color)
      mesh.setColorAt(i, tempColor)
    })

    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }, [companies, affectedTickers, dimmedTickers, highlightTickers, tempObj, tempColor])

  return (
    <instancedMesh ref={meshRef} args={[undefined, undefined, companies.length]}>
      <icosahedronGeometry args={[0.012, 1]} />
      <meshBasicMaterial />
    </instancedMesh>
  )
}
