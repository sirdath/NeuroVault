# NeuroVault consumer roadmap

This roadmap is for the paid NeuroVault Desktop application. The open-source
engine and integration bridge live in NeuroVault Core. Desktop is planned as a
paid-upfront Mac App Store product, without a required subscription or cloud
account. Product work should optimize for trust, reliability, usefulness, and
delight.

## Public-release boundary

- Build and verify a separate Mac App Store sandbox flavor while preserving the
  existing Developer ID distribution path for internal migration testing.
- Keep the destructive-path, cross-vault isolation, privacy-contract,
  accessibility, headless-engine, and desktop-GUI gates green.
- Run first-use trust testing with people who did not build NeuroVault.

## Next consumer capabilities

- Temporary/private sessions with a conspicuous scope and automatic expiry.
- A full **Remembered** view for decisions, preferences, facts, tasks, working
  state, provenance, history, move, correct, and forget actions.
- Search filters for source, time, memory type, status, and vault.
- Graph Studio SVG and print/PDF export where the renderer can represent the
  view honestly; keep JSON under **Save style** or **Export graph data**.
- Guided backup and restore verification on a clean install.

## Later delight: a NeuroVault companion

Add an optional local companion/pet inspired by the small Codex companion.
It should make the invisible memory system feel alive without becoming a
notification machine:

- its state must reflect real local status (ready, learning, quiet, paused,
  needs attention, or problem), never decorative fake activity;
- it can celebrate useful milestones and graph growth without gamifying the
  amount of personal data collected;
- it must be fully optional, dismissible, Reduce Motion aware, keyboard and
  screen-reader accessible, and cost zero background network traffic;
- it must never pressure people into reviewing, connecting a provider, or
  storing more data.

The companion is a delight layer on top of a trustworthy memory engine, not a
replacement for clear receipts, controls, or error messages.
