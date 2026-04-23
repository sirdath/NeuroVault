import React, { useState, useEffect } from "react"
import * as THREE from "three"
import { useLoader } from "@react-three/fiber"
import { staticFile, delayRender, continueRender } from "remotion"

export const GlobeSphere: React.FC = () => {
  const [handle] = useState(() => delayRender("Loading earth texture"))
  const texture = useLoader(THREE.TextureLoader, staticFile("earth-night.jpg"))

  useEffect(() => {
    if (texture) continueRender(handle)
  }, [texture, handle])

  return (
    <mesh>
      <sphereGeometry args={[1, 64, 64]} />
      <meshPhongMaterial
        map={texture}
        color="#050a14"
        emissive="#0a1628"
        emissiveIntensity={0.15}
        shininess={15}
        specularMap={undefined}
      />
    </mesh>
  )
}
