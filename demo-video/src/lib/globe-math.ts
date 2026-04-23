import * as THREE from "three"

const GLOBE_RADIUS = 1

export function latLngToVector3(lat: number, lng: number, radius = GLOBE_RADIUS): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180)
  const theta = (lng + 180) * (Math.PI / 180)
  return new THREE.Vector3(
    -(radius * Math.sin(phi) * Math.cos(theta)),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta)
  )
}

export function greatCircleArc(
  startLatLng: { lat: number; lng: number },
  endLatLng: { lat: number; lng: number },
  altitude: number = 0.3,
  segments: number = 50
): THREE.Vector3[] {
  const start = latLngToVector3(startLatLng.lat, startLatLng.lng)
  const end = latLngToVector3(endLatLng.lat, endLatLng.lng)
  const mid = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5)
  mid.normalize().multiplyScalar(GLOBE_RADIUS + altitude)
  const curve = new THREE.QuadraticBezierCurve3(start, mid, end)
  return curve.getPoints(segments)
}

export function globeRotationForLatLng(lat: number, lng: number): [number, number, number] {
  const phi = lat * (Math.PI / 180)
  const theta = -(lng + 90) * (Math.PI / 180)
  return [phi, theta, 0]
}

export { GLOBE_RADIUS }
