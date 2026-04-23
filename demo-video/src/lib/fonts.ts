import { loadFont as loadSyne } from "@remotion/google-fonts/Syne"
import { loadFont as loadJetBrainsMono } from "@remotion/google-fonts/JetBrainsMono"

const syneFontInfo = loadSyne()
const monoFontInfo = loadJetBrainsMono()

export const fontFamily = {
  syne: syneFontInfo.fontFamily,
  mono: monoFontInfo.fontFamily,
}
