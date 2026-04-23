import { Composition } from "remotion";
import { Video } from "./Video";
import { S01Landing } from "./scenes/S01Landing";
import { S02Dashboard } from "./scenes/S02Dashboard";
import { S03EventDemo } from "./scenes/S03EventDemo";
import { S04SupplyChain } from "./scenes/S04SupplyChain";
import { S05Closing } from "./scenes/S05Closing";
import { NeuroVaultBrain } from "./scenes/NeuroVaultBrain";

export const RemotionRoot: React.FC = () => (
  <>
    {/* Full 2-minute video */}
    <Composition
      id="RiskTerrainDemo"
      component={Video}
      fps={30}
      durationInFrames={3600}
      width={1920}
      height={1080}
    />
    {/* Individual scenes for dev iteration */}
    <Composition id="S01" component={S01Landing} fps={30} durationInFrames={450} width={1920} height={1080} />
    <Composition id="S02" component={S02Dashboard} fps={30} durationInFrames={600} width={1920} height={1080} />
    <Composition id="S03" component={S03EventDemo} fps={30} durationInFrames={1050} width={1920} height={1080} />
    <Composition id="S04" component={S04SupplyChain} fps={30} durationInFrames={750} width={1920} height={1080} />
    <Composition id="S05" component={S05Closing} fps={30} durationInFrames={750} width={1920} height={1080} />

    {/* NeuroVault brain + neural-network hero animation (for ASCII conversion) */}
    <Composition
      id="NeuroVaultBrain"
      component={NeuroVaultBrain}
      fps={30}
      durationInFrames={900}
      width={1920}
      height={1080}
    />
  </>
);
