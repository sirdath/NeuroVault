import { interpolate, spring, Easing } from "remotion"

export function fadeInUp(frame: number, start: number, duration = 30) {
  const opacity = interpolate(frame, [start, start + duration], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  })
  const y = interpolate(frame, [start, start + duration], [20, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  })
  return { opacity, transform: `translateY(${y}px)` }
}

export function fadeOut(frame: number, start: number, duration = 30) {
  return interpolate(frame, [start, start + duration], [1, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  })
}

export function slideIn(frame: number, start: number, from: number, duration = 30) {
  const x = interpolate(frame, [start, start + duration], [from, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  })
  const opacity = interpolate(frame, [start, start + duration], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  })
  return { opacity, transform: `translateX(${x}px)` }
}

export function slideInY(frame: number, start: number, from: number, duration = 30) {
  const y = interpolate(frame, [start, start + duration], [from, 0], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  })
  const opacity = interpolate(frame, [start, start + duration], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  })
  return { opacity, transform: `translateY(${y}px)` }
}

export function springScale(frame: number, fps: number, delay = 0) {
  return spring({ frame, fps, delay, config: { damping: 12, mass: 0.5 } })
}

export function springScaleOvershoot(frame: number, fps: number, delay = 0) {
  return spring({ frame, fps, delay, config: { damping: 8, mass: 0.8, stiffness: 200 } })
}

export function stagger(frame: number, index: number, staggerDelay = 10, duration = 30) {
  const start = index * staggerDelay
  return fadeInUp(frame, start, duration)
}

export function drawProgress(frame: number, start: number, duration: number) {
  return interpolate(frame, [start, start + duration], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
  })
}

export function pulse(frame: number, period = 30) {
  const t = (frame % period) / period
  return 0.3 + 0.7 * Math.abs(Math.sin(t * Math.PI))
}

export function counter(frame: number, start: number, duration: number, target: number) {
  const progress = interpolate(frame, [start, start + duration], [0, 1], {
    extrapolateLeft: "clamp", extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  })
  return Math.round(progress * target)
}
