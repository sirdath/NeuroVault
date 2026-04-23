import React from "react"
import { AbsoluteFill, Sequence } from "remotion"
import { S01Landing } from "./scenes/S01Landing"
import { S02Dashboard } from "./scenes/S02Dashboard"
import { S03EventDemo } from "./scenes/S03EventDemo"
import { S04SupplyChain } from "./scenes/S04SupplyChain"
import { S05Closing } from "./scenes/S05Closing"

export const Video: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: "#080D1A" }}>
    <Sequence from={0} durationInFrames={450} name="S01-Landing">
      <S01Landing />
    </Sequence>
    <Sequence from={450} durationInFrames={600} name="S02-Dashboard">
      <S02Dashboard />
    </Sequence>
    <Sequence from={1050} durationInFrames={1050} name="S03-EventDemo">
      <S03EventDemo />
    </Sequence>
    <Sequence from={2100} durationInFrames={750} name="S04-SupplyChain">
      <S04SupplyChain />
    </Sequence>
    <Sequence from={2850} durationInFrames={750} name="S05-Closing">
      <S05Closing />
    </Sequence>
  </AbsoluteFill>
)
