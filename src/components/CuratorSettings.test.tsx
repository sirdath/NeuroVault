/**
 * The curator's consent surface.
 *
 * Four properties are load-bearing and each has a test: it is OFF until the
 * user says otherwise, it explains in plain words what each switch grants,
 * it never offers to download a model, and it tells the truth about what the
 * last run did.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBrainStore } from "../stores/brainStore";
import { useToastStore } from "../stores/toastStore";
import {
  CuratorSettings,
  modelNotInstalledHint,
  summarizeCuratorRuns,
  type CuratorRunAuditLine,
  type LocalCuratorConfig,
} from "./CuratorSettings";
import { SettingsView } from "./SettingsView";

const MODEL = "qwen3:30b-a3b-instruct-2507-q4_K_M";

/** The GET payload as `handlers::local_curator_state` builds it. */
const offConfig: LocalCuratorConfig = {
  brain: "alpha",
  enabled: false,
  transcript_access: false,
  consent_granted: false,
  provider: null,
  provider_configured: false,
  installed_models: [],
  schedule: {
    interval_hours: 24,
    check_interval_secs: 1800,
    startup_delay_secs: 180,
    last_run: null,
    decision: "consent_off",
  },
};

const runLines: CuratorRunAuditLine[] = [
  {
    run_id: "run-2",
    unit_id: "ev_ctx_7f21",
    unit_status: "completed",
    outcomes: [
      { outcome: "proposal_ready", proposal_id: "3f8c" },
      { outcome: "rejected" },
    ],
    ts: "2026-08-12T02:10:44Z",
  },
  {
    run_id: "run-2",
    unit_id: "ev_ctx_8a02",
    unit_status: "deferred",
    outcomes: [],
    ts: "2026-08-12T02:12:10Z",
  },
  {
    run_id: "run-2",
    unit_id: "ev_ctx_9b13",
    unit_status: "completed",
    outcomes: [{ outcome: "review_required", proposal_id: "77aa" }],
    ts: "2026-08-12T02:14:02Z",
  },
  {
    run_id: "run-1",
    unit_id: "ev_ctx_old",
    unit_status: "completed",
    outcomes: [{ outcome: "proposal_ready", proposal_id: "old" }],
    ts: "2026-08-11T02:14:02Z",
  },
];

type Scenario = {
  config: LocalCuratorConfig;
  runs?: CuratorRunAuditLine[];
  runStatus?: number;
};

let scenario: Scenario;
let fetchMock: ReturnType<typeof vi.fn>;
let putBodies: unknown[];

function mountFetch() {
  putBodies = [];
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/curator/runs")) {
      return { ok: true, status: 200, json: async () => ({ runs: scenario.runs ?? [] }) };
    }
    if (url.includes("/api/curator/run")) {
      const status = scenario.runStatus ?? 200;
      return {
        ok: status < 400,
        status,
        json: async () =>
          status === 200
            ? {
                run_id: "run-3",
                status: "completed",
                units_processed: 4,
                units_deferred: 1,
                proposals_created: 2,
              }
            : { error: "a proposal run already holds this brain" },
      };
    }
    if (url.includes("/api/local_curator")) {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as LocalCuratorConfig;
        putBodies.push(body);
        scenario = { ...scenario, config: { ...scenario.config, ...body } };
        return { ok: true, status: 200, json: async () => scenario.config };
      }
      return { ok: true, status: 200, json: async () => scenario.config };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
}

describe("summarizeCuratorRuns", () => {
  it("folds the newest run's per-unit lines into one summary", () => {
    expect(summarizeCuratorRuns(runLines)).toEqual({
      run_id: "run-2",
      ts: "2026-08-12T02:14:02Z",
      units_seen: 3,
      proposals: 2,
      deferred: 1,
    });
  });

  it("has nothing to say before the first run", () => {
    expect(summarizeCuratorRuns([])).toBeNull();
  });
});

describe("curator settings", () => {
  beforeEach(() => {
    scenario = { config: { ...offConfig }, runs: [] };
    mountFetch();
    useBrainStore.setState({ activeBrainId: "alpha", activeBrainName: "Alpha" });
    useToastStore.setState({ toasts: [] });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("is off until the user turns it on, and says what each switch grants", async () => {
    render(<CuratorSettings />);

    const curate = await screen.findByRole("switch", { name: "Curate my sessions" });
    const evidence = screen.getByRole("switch", { name: "Keep evidence from my sessions" });
    expect(curate).toHaveAttribute("aria-checked", "false");
    expect(evidence).toHaveAttribute("aria-checked", "false");

    expect(screen.getByText(/The kill switch\./)).toBeInTheDocument();
    expect(
      screen.getByText(/hashes the bytes it saw — never the text itself/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The curator is off. Nothing is scheduled, and no transcript is opened."),
    ).toBeInTheDocument();
    expect(screen.getByText(/roughly 8 GB of RAM/)).toBeInTheDocument();
    expect(screen.getByText(/unloaded when the run finishes/)).toBeInTheDocument();
  });

  it("persists a consent change through the loopback endpoint", async () => {
    const user = userEvent.setup();
    render(<CuratorSettings />);

    await user.click(await screen.findByRole("switch", { name: "Curate my sessions" }));

    await waitFor(() => expect(putBodies).toHaveLength(1));
    expect(putBodies[0]).toMatchObject({ enabled: true, transcript_access: false });
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Curate my sessions" })).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
    expect(
      screen.getByText(/Curation is on, but evidence capture is off/),
    ).toBeInTheDocument();
  });

  it("lists only installed models and never offers to download one", async () => {
    scenario = {
      config: {
        ...offConfig,
        provider: { endpoint: "http://127.0.0.1:11434", model: MODEL },
        installed_models: [
          { name: MODEL, size_bytes: 18_600_000_000 },
          { name: "llama3.1:8b", size_bytes: 4_900_000_000 },
        ],
      },
    };
    render(<CuratorSettings />);

    expect(await screen.findByRole("button", { name: `${MODEL} · 18.6 GB` })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "llama3.1:8b · 4.9 GB" })).toBeInTheDocument();
    for (const label of [/download/i, /pull/i, /install for me/i]) {
      expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
    }
    expect(screen.getByText(/never a remote host/)).toBeInTheDocument();
  });

  it("hands the decision back when the configured model is missing", async () => {
    scenario = {
      config: {
        ...offConfig,
        provider: { endpoint: "http://127.0.0.1:11434", model: MODEL },
        installed_models: [{ name: "llama3.1:8b" }],
        provider_status: {
          ok: false,
          code: "model_not_installed",
          hint: `The model ${MODEL} is not installed. Install it yourself (Settings shows the download size) — the curator will not pull it for you.`,
        },
      },
    };
    render(<CuratorSettings />);

    expect(await screen.findByText(/is not installed/)).toBeInTheDocument();
    expect(screen.getByText(/will not pull it for you/)).toBeInTheDocument();
  });

  it("says it cannot list models rather than pretending none are installed", async () => {
    scenario = {
      config: {
        brain: "alpha",
        enabled: false,
        transcript_access: false,
        provider: { endpoint: "http://127.0.0.1:11434", model: MODEL },
        schedule: { interval_hours: 24, decision: "consent_off" },
      },
    };
    render(<CuratorSettings />);

    expect(await screen.findByText(/can't list your installed models here yet/)).toBeInTheDocument();
    // …and with no list, it must not accuse the configured model of missing.
    expect(screen.queryByText(/is not installed/)).not.toBeInTheDocument();
  });

  it("falls back to its own never-pull wording when the backend sends no hint", async () => {
    scenario = {
      config: {
        ...offConfig,
        provider: { endpoint: "http://127.0.0.1:11434", model: MODEL },
        installed_models: [{ name: "llama3.1:8b" }],
      },
    };
    render(<CuratorSettings />);

    expect(await screen.findByText(modelNotInstalledHint(MODEL))).toBeInTheDocument();
  });

  it("only offers Run now once both switches are on, and says why the clock is idle", async () => {
    render(<CuratorSettings />);

    expect(await screen.findByRole("button", { name: "Run now" })).toBeDisabled();
    expect(screen.getByText("Both switches must be on before a run can start.")).toBeInTheDocument();
    expect(
      screen.getByText(/It won't run: both switches above have to be on\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/Runs at most once every 24 hours/)).toBeInTheDocument();
  });

  it("announces the detached start and leaves the run to the backend (202)", async () => {
    scenario = {
      config: {
        ...offConfig,
        enabled: true,
        transcript_access: true,
        consent_granted: true,
        schedule: { ...offConfig.schedule, decision: "not_due" },
      },
      runs: [],
    };
    const user = userEvent.setup();
    render(<CuratorSettings />);

    await user.click(await screen.findByRole("button", { name: "Run now" }));

    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
        "Curator run started — proposals will land in Memory Review as they pass the gates.",
      ),
    );
    // The button reflects the still-running state; polling owns the reset.
    expect(screen.getByRole("button", { name: /Running…|Run now/ })).toBeInTheDocument();
  });

  it("says so plainly when a run is already in flight (409)", async () => {
    scenario = {
      config: { ...offConfig, enabled: true, transcript_access: true },
      runs: [],
      runStatus: 409,
    };
    const user = userEvent.setup();
    render(<CuratorSettings />);

    await user.click(await screen.findByRole("button", { name: "Run now" }));

    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((t) => t.message)).toContain(
        "A curator run is already in flight — its results will land in Memory Review.",
      ),
    );
    // A 409 is not an error the user caused; nothing is reported as a failure.
    expect(useToastStore.getState().toasts.every((t) => t.type !== "error")).toBe(true);
  });

  it("reports what the last run actually did", async () => {
    scenario = {
      config: { ...offConfig, enabled: true, transcript_access: true },
      runs: runLines,
    };
    render(<CuratorSettings />);

    expect(await screen.findByText(/3 turns seen · 2 proposed · 1 deferred/)).toBeInTheDocument();
    expect(screen.getByText("2 proposals waiting in Memory Review.")).toBeInTheDocument();
  });

  it("calls a quiet night normal, not a failure", async () => {
    scenario = {
      config: { ...offConfig, enabled: true, transcript_access: true },
      runs: [{ run_id: "run-9", unit_status: "completed", outcomes: [], ts: "2026-08-12T02:10:44Z" }],
    };
    render(<CuratorSettings />);

    expect(
      await screen.findByText(/a quiet night is the normal result/),
    ).toBeInTheDocument();
  });

  it("is reachable in Settings → Sources, not hidden behind developer options", async () => {
    render(<SettingsView initialSection="sources" />);

    expect(
      await screen.findByRole("switch", { name: "Curate my sessions" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Developer" })).not.toBeInTheDocument();
  });

  it("admits it when NeuroVault isn't answering", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline in test")));
    render(<CuratorSettings />);

    expect(await screen.findByText(/NeuroVault isn't answering/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Curate my sessions" })).toBeDisabled();
  });
});
