import React from "react"

export const GlobeAtmosphere: React.FC = () => (
  <mesh>
    <sphereGeometry args={[1.08, 64, 64]} />
    <meshBasicMaterial
      color="#1a6bcc"
      transparent
      opacity={0.08}
      side={1}
    />
  </mesh>
)
