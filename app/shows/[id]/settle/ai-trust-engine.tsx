"use client";

import { useState } from "react";
import { Loader2, Sparkles, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/format";
import {
  buildSettlementNarrative,
  calculateAiSettlement,
  isAiTranslation,
  type AiTranslation,
} from "@/lib/aiSettleMath";
import type { Deal, Expense, TicketSale } from "@/db/schema";

type AiSettleApiResponse = {
  show: unknown;
  deal: Deal | null;
  ticketSales: TicketSale[];
  expenses: Expense[];
  aiTranslation: unknown;
  error?: string;
  details?: string;
};

type EngineState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      ai: AiTranslation;
      math: ReturnType<typeof calculateAiSettlement>;
      narrative: string;
    };

export function AiTrustEngine({ showId }: { showId: string }) {
  const [state, setState] = useState<EngineState>({ status: "idle" });

  async function runEngine() {
    setState({ status: "loading" });

    try {
      const res = await fetch("/api/ai-settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ showId }),
      });

      const data = (await res.json()) as AiSettleApiResponse;

      if (!res.ok) {
        throw new Error(data.error ?? data.details ?? "Request failed");
      }

      if (!data.aiTranslation || !isAiTranslation(data.aiTranslation)) {
        throw new Error(
          "No AI translation available — deal notes may be missing or could not be parsed.",
        );
      }

      const math = calculateAiSettlement({
        aiTranslation: data.aiTranslation,
        ticketSales: data.ticketSales ?? [],
        expenses: data.expenses ?? [],
        hospitalityCap: data.deal?.hospitalityCap,
      });

      const narrative = buildSettlementNarrative(
        data.aiTranslation,
        math,
        formatMoney,
      );

      setState({
        status: "ready",
        ai: data.aiTranslation,
        math,
        narrative,
      });
    } catch (err) {
      setState({
        status: "error",
        message:
          err instanceof Error ? err.message : "Something went wrong",
      });
    }
  }

  return (
    <section className="mb-10 rounded-lg bg-slate-900 p-6 text-slate-50 ring-1 ring-slate-700/80">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            <Sparkles className="h-3.5 w-3.5 text-amber-400" />
            AI Trust &amp; Translate
          </div>
          <h2 className="mt-1 font-display text-[22px] font-medium leading-tight text-slate-50">
            Run AI Trust &amp; Translate Engine
          </h2>
          <p className="mt-1.5 max-w-xl text-[13px] leading-relaxed text-slate-400">
            Translates Mariana&apos;s deal notes into structured rules, then runs
            deterministic settlement math you can show a tour manager at 2 AM.
          </p>
        </div>
        <Button
          type="button"
          variant="brand"
          size="lg"
          onClick={runEngine}
          disabled={state.status === "loading"}
          className="shrink-0 bg-amber-500 text-slate-950 hover:bg-amber-400 ring-amber-600/30"
        >
          {state.status === "loading" ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Running engine…
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" />
              Run AI Trust &amp; Translate Engine
            </>
          )}
        </Button>
      </div>

      {state.status === "error" && (
        <div className="mt-5 flex gap-2.5 rounded-md border border-rose-500/40 bg-rose-950/50 px-4 py-3 text-[13px] text-rose-100">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
          <p>{state.message}</p>
        </div>
      )}

      {state.status === "ready" && (
        <div className="mt-6 space-y-6 border-t border-slate-700/80 pt-6">
          {/* Section 1 — Glance tags */}
          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Glance tags
            </h3>
            <div className="mt-3 flex flex-wrap gap-2">
              <GlanceTag
                label="Guarantee"
                value={formatMoney(state.ai.guaranteeAmount)}
              />
              <GlanceTag
                label="Artist split"
                value={
                  state.ai.artistSplitPercentage != null
                    ? `${(state.ai.artistSplitPercentage * 100).toFixed(0)}%`
                    : "—"
                }
              />
              <GlanceTag
                label="Expense cap"
                value={
                  state.ai.expenseCap != null
                    ? formatMoney(state.ai.expenseCap)
                    : "None"
                }
              />
              <GlanceTag
                label="Marketing recoup"
                value={state.ai.recoupRules.marketing ?? "None"}
              />
              <GlanceTag
                label="Deal type"
                value={state.ai.dealType}
                muted
              />
            </div>
          </div>

          {/* Section 2 — 2 AM narrative */}
          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              The 2 AM narrative
            </h3>
            <div className="mt-3 rounded-md bg-slate-950/60 p-5 ring-1 ring-slate-700/60">
              <p className="whitespace-pre-line text-[14px] leading-relaxed text-slate-200">
                {state.narrative}
              </p>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <MetricPill label="Gross" value={formatMoney(state.math.gross)} />
              <MetricPill
                label="Allowed expenses"
                value={formatMoney(state.math.allowedExpenses)}
              />
              <MetricPill label="Net" value={formatMoney(state.math.net)} />
              <MetricPill
                label="Final payout"
                value={formatMoney(state.math.finalPayout)}
                highlight
              />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function GlanceTag({
  label,
  value,
  muted,
}: {
  label: string;
  value: string;
  muted?: boolean;
}) {
  return (
    <div
      className={`rounded-md px-3 py-2 ring-1 ring-inset ${
        muted
          ? "bg-slate-800/80 ring-slate-600/60"
          : "bg-slate-800 ring-slate-600"
      }`}
    >
      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
        {label}
      </div>
      <div className="mt-0.5 text-[14px] font-bold text-slate-50">{value}</div>
    </div>
  );
}

function MetricPill({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-md px-3 py-2.5 text-center ring-1 ring-inset ${
        highlight
          ? "bg-amber-500/15 ring-amber-400/40"
          : "bg-slate-800/60 ring-slate-700/80"
      }`}
    >
      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
        {label}
      </div>
      <div
        className={`mt-0.5 font-mono text-[15px] font-semibold tabular ${
          highlight ? "text-amber-300" : "text-slate-100"
        }`}
      >
        {value}
      </div>
    </div>
  );
}
