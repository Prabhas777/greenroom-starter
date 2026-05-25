import type { Expense, TicketSale } from "@/db/schema";

export type AiRecoupRules = {
  marketing: string | null;
  hospitality_overage: string | null;
  production_overage: string | null;
};

export type AiTranslation = {
  dealType: string;
  guaranteeAmount: number;
  artistSplitPercentage: number | null;
  expenseCap: number | null;
  recoupRules: AiRecoupRules;
  bonuses: string | null;
};

export type AiSettleMathInput = {
  aiTranslation: AiTranslation;
  ticketSales: TicketSale[];
  expenses: Expense[];
  hospitalityCap?: number | null;
};

export type AiSettleMathResult = {
  ticketGross: number;
  ticketFees: number;
  gross: number;
  rawExpenses: number;
  cappedBaseExpenses: number;
  marketingRecoup: number;
  marketingOutsideCap: boolean;
  allowedExpenses: number;
  net: number;
  artistSplitPercentage: number;
  percentagePayout: number;
  guaranteeAmount: number;
  basePayout: number;
  bonusAmount: number;
  hospitalityOverage: number;
  productionOverage: number;
  artistOverages: number;
  finalPayout: number;
};

function sumTicketGross(ticketSales: TicketSale[]): number {
  return ticketSales.reduce((sum, t) => sum + t.gross, 0);
}

function sumTicketFees(ticketSales: TicketSale[]): number {
  return ticketSales.reduce((sum, t) => sum + t.fees, 0);
}

function sumPassedThroughExpenses(expenses: Expense[]): number {
  return expenses
    .filter((e) => !e.absorbedByVenue)
    .reduce((sum, e) => sum + e.amount, 0);
}

function expenseTotalByCategory(
  expenses: Expense[],
  category: Expense["category"],
): number {
  return expenses
    .filter((e) => e.category === category && !e.absorbedByVenue)
    .reduce((sum, e) => sum + e.amount, 0);
}

function parseMoney(text: string): number | null {
  const match = text.match(/\$[\d,]+(?:\.\d+)?/);
  if (!match) return null;
  return Number.parseFloat(match[0].replace(/[$,]/g, ""));
}

function parseMarketingRecoup(marketing: string | null): {
  amount: number;
  outsideCap: boolean;
} {
  if (!marketing?.trim()) {
    return { amount: 0, outsideCap: false };
  }

  const lower = marketing.toLowerCase();
  const amount = parseMoney(marketing) ?? 0;
  const insideCap = lower.includes("inside cap");
  const outsideCap =
    !insideCap &&
    (lower.includes("against gross") ||
      lower.includes("off the top") ||
      lower.includes("outside") ||
      lower.includes("recoup"));

  return { amount, outsideCap: insideCap ? false : outsideCap };
}

function usesNetBoxOfficeAsGross(dealType: string): boolean {
  const normalized = dealType.toLowerCase();
  return (
    normalized.includes("net") ||
    normalized.includes("vs") ||
    normalized.includes("door")
  );
}

function parseBonusAmount(
  bonuses: string | null,
  ticketGross: number,
): number {
  if (!bonuses?.trim()) return 0;

  const amountMatch =
    bonuses.match(/\+\s*\$?([\d,]+(?:\.\d+)?)/i) ??
    bonuses.match(/\$?([\d,]+(?:\.\d+)?)\s*(?:bonus|if)/i);
  if (!amountMatch) return 0;

  const bonusAmount = Number.parseFloat(amountMatch[1].replace(/,/g, ""));
  const thresholdMatch = bonuses.match(
    /(?:>|over|above|exceeds?)\s*\$?([\d,]+(?:\.\d+)?)/i,
  );

  if (thresholdMatch) {
    const threshold = Number.parseFloat(thresholdMatch[1].replace(/,/g, ""));
    return ticketGross >= threshold ? bonusAmount : 0;
  }

  return bonusAmount;
}

function parseOverageCap(
  rule: string | null,
  fallbackCap?: number | null,
): number | null {
  if (rule?.trim()) {
    const beyond = rule.match(/beyond\s*\$?([\d,]+(?:\.\d+)?)/i);
    if (beyond) {
      return Number.parseFloat(beyond[1].replace(/,/g, ""));
    }
    const cap = rule.match(/\$?([\d,]+(?:\.\d+)?)/);
    if (cap) {
      return Number.parseFloat(cap[1].replace(/,/g, ""));
    }
  }
  return fallbackCap ?? null;
}

function calculateCategoryOverage(
  spend: number,
  cap: number | null,
): number {
  if (cap == null) return 0;
  return Math.max(0, spend - cap);
}

export function isAiTranslation(value: unknown): value is AiTranslation {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.dealType === "string" &&
    typeof v.guaranteeAmount === "number" &&
    (v.artistSplitPercentage === null ||
      typeof v.artistSplitPercentage === "number") &&
    (v.expenseCap === null || typeof v.expenseCap === "number") &&
    typeof v.recoupRules === "object" &&
    v.recoupRules !== null
  );
}

/** Industry-standard settlement math driven by AI-translated deal rules. */
export function calculateAiSettlement(
  input: AiSettleMathInput,
): AiSettleMathResult {
  const { aiTranslation, ticketSales, expenses, hospitalityCap } = input;
  const { recoupRules, expenseCap } = aiTranslation;

  const ticketGross = sumTicketGross(ticketSales);
  const ticketFees = sumTicketFees(ticketSales);
  const rawExpenses = sumPassedThroughExpenses(expenses);

  const gross = usesNetBoxOfficeAsGross(aiTranslation.dealType)
    ? ticketGross - ticketFees
    : ticketGross;

  const cappedBaseExpenses =
    expenseCap != null ? Math.min(rawExpenses, expenseCap) : rawExpenses;

  const { amount: marketingRecoup, outsideCap: marketingOutsideCap } =
    parseMarketingRecoup(recoupRules.marketing ?? null);

  let allowedExpenses = cappedBaseExpenses;
  if (marketingRecoup > 0) {
    if (marketingOutsideCap) {
      allowedExpenses = cappedBaseExpenses + marketingRecoup;
    } else {
      allowedExpenses =
        expenseCap != null
          ? Math.min(cappedBaseExpenses + marketingRecoup, expenseCap)
          : cappedBaseExpenses + marketingRecoup;
    }
  }

  const net = gross - allowedExpenses;
  const artistSplitPercentage = aiTranslation.artistSplitPercentage ?? 0;
  const percentagePayout = net * artistSplitPercentage;
  const guaranteeAmount = aiTranslation.guaranteeAmount ?? 0;
  const basePayout = Math.max(guaranteeAmount, percentagePayout);

  const bonusAmount = parseBonusAmount(aiTranslation.bonuses, ticketGross);

  const hospitalitySpend = expenseTotalByCategory(expenses, "hospitality");
  const productionSpend = expenseTotalByCategory(expenses, "production");

  const hospitalityOverage = calculateCategoryOverage(
    hospitalitySpend,
    parseOverageCap(recoupRules.hospitality_overage, hospitalityCap),
  );
  const productionOverage = calculateCategoryOverage(
    productionSpend,
    parseOverageCap(recoupRules.production_overage, null),
  );

  const artistOverages = hospitalityOverage + productionOverage;
  const finalPayout = basePayout + bonusAmount - artistOverages;

  return {
    ticketGross,
    ticketFees,
    gross,
    rawExpenses,
    cappedBaseExpenses,
    marketingRecoup,
    marketingOutsideCap,
    allowedExpenses,
    net,
    artistSplitPercentage,
    percentagePayout,
    guaranteeAmount,
    basePayout,
    bonusAmount,
    hospitalityOverage,
    productionOverage,
    artistOverages,
    finalPayout,
  };
}

export function buildSettlementNarrative(
  ai: AiTranslation,
  result: AiSettleMathResult,
  formatMoney: (n: number) => string,
): string {
  const splitPct = (result.artistSplitPercentage * 100).toFixed(0);
  const lines: string[] = [];

  lines.push(
    `Here's the settlement in plain English — no spreadsheet required.`,
  );

  if (result.ticketFees > 0 && result.gross !== result.ticketGross) {
    lines.push(
      `We started with ${formatMoney(result.ticketGross)} in ticket gross, took out ${formatMoney(result.ticketFees)} in ticketing fees, and worked from ${formatMoney(result.gross)} net box office — that's the "gross" number for this ${ai.dealType} deal.`,
    );
  } else {
    lines.push(
      `Ticket revenue (gross) came to ${formatMoney(result.gross)}.`,
    );
  }

  lines.push(
    `Show expenses totaled ${formatMoney(result.rawExpenses)} before any deal caps or recoups.`,
  );

  if (ai.expenseCap != null) {
    lines.push(
      `Your deal caps passed-through expenses at ${formatMoney(ai.expenseCap)}, so we counted ${formatMoney(result.cappedBaseExpenses)} toward the cap.`,
    );
  }

  if (result.marketingRecoup > 0) {
    lines.push(
      result.marketingOutsideCap
        ? `Marketing recoup (${ai.recoupRules.marketing}) sits outside the expense cap, so we added ${formatMoney(result.marketingRecoup)} on top — allowed expenses are ${formatMoney(result.allowedExpenses)}.`
        : `Marketing recoup (${ai.recoupRules.marketing}) counts inside the cap as part of allowed expenses (${formatMoney(result.allowedExpenses)}).`,
    );
  } else {
    lines.push(
      `Allowed expenses (what comes off before the artist split) are ${formatMoney(result.allowedExpenses)}.`,
    );
  }

  lines.push(
    `Subtract that from gross and you get net: ${formatMoney(result.gross)} − ${formatMoney(result.allowedExpenses)} = ${formatMoney(result.net)}.`,
  );

  if (result.artistSplitPercentage > 0) {
    lines.push(
      `At ${splitPct}% of net, the percentage side pays ${formatMoney(result.net)} × ${splitPct}% = ${formatMoney(result.percentagePayout)}.`,
    );
  }

  if (result.guaranteeAmount > 0) {
    lines.push(
      `The guarantee is ${formatMoney(result.guaranteeAmount)}. We take the higher of guarantee vs. percentage: max(${formatMoney(result.guaranteeAmount)}, ${formatMoney(result.percentagePayout)}) = ${formatMoney(result.basePayout)} base payout.`,
    );
  } else {
    lines.push(`Base payout is ${formatMoney(result.basePayout)}.`);
  }

  if (result.bonusAmount > 0) {
    lines.push(
      `A bonus triggered (${ai.bonuses}), adding ${formatMoney(result.bonusAmount)}.`,
    );
  }

  if (result.artistOverages > 0) {
    const parts: string[] = [];
    if (result.hospitalityOverage > 0) {
      parts.push(
        `${formatMoney(result.hospitalityOverage)} hospitality overage`,
      );
    }
    if (result.productionOverage > 0) {
      parts.push(
        `${formatMoney(result.productionOverage)} production overage`,
      );
    }
    lines.push(
      `Artist-covered overages (${parts.join(", ")}) reduce the total by ${formatMoney(result.artistOverages)}.`,
    );
  }

  lines.push(
    `Final payout: ${formatMoney(result.basePayout)}${result.bonusAmount > 0 ? ` + ${formatMoney(result.bonusAmount)} bonus` : ""}${result.artistOverages > 0 ? ` − ${formatMoney(result.artistOverages)} overages` : ""} = ${formatMoney(result.finalPayout)}.`,
  );

  return lines.join("\n\n");
}
