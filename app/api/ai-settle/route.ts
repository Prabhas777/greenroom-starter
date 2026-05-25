import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { shows, deals, ticketSales, expenses } from "@/db/schema";
import { asc, desc, eq } from "drizzle-orm";

const ANTHROPIC_MODEL = "claude-sonnet-4-6";

const DEAL_TRANSLATOR_SYSTEM_PROMPT = `You are an expert music venue deal translator. Read the given deal notes. Extract the financial rules into a strict JSON format containing ONLY these exact keys:
-dealType (string): MUST be exactly one of: 'Standard Vs Deal', 'Flat', 'Door Deal', '% of Net', '% of Gross', 'Walkout Pot', 'Tier Ratchet', or 'Vs Gross Variant'.
-guaranteeAmount (number): The flat guarantee amount, or 0 if none.
-artistSplitPercentage (number): The decimal representing the artist's cut (e.g., 0.8 for 80%), or null.
-expenseCap (number or null): The maximum allowable expenses.
-recoupRules (object): MUST contain these exact keys mapping to string explanations or null:
-marketing: (e.g., '$900 against gross', 'inside cap', or null)
-hospitality_overage: (e.g., 'artist covers beyond $300', or null)
-production_overage: (string or null)
-bonuses (string or null): Any unstructured bonuses or walkout pot rules.
Output ONLY raw valid JSON. Do not include markdown formatting, explanations, or code block backticks.`;

type AiSettleRequestBody = {
  showId?: string;
};

function stripMarkdownFences(text: string): string {
  let cleaned = text.trim();
  const fenced = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  if (fenced) {
    cleaned = fenced[1].trim();
  }
  return cleaned;
}

function parseAiTranslationJson(rawText: string): unknown {
  const cleaned = stripMarkdownFences(rawText);
  return JSON.parse(cleaned);
}

function extractTextFromMessage(content: Anthropic.Message["content"]): string {
  const text = content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();

  if (!text) {
    throw new Error("Anthropic returned an empty text response");
  }

  return text;
}

async function translateDealNotes(notesFreetext: string): Promise<unknown> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }

  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
    system: DEAL_TRANSLATOR_SYSTEM_PROMPT,
    messages: [{ role: "user", content: notesFreetext }],
  });

  const rawText = extractTextFromMessage(message.content);
  return parseAiTranslationJson(rawText);
}

export async function POST(request: NextRequest) {
  let body: AiSettleRequestBody;

  try {
    body = (await request.json()) as AiSettleRequestBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const showId = body.showId?.trim();
  if (!showId) {
    return NextResponse.json(
      { error: "showId is required" },
      { status: 400 },
    );
  }

  const showRows = await db
    .select()
    .from(shows)
    .where(eq(shows.id, showId))
    .limit(1);

  if (showRows.length === 0) {
    return NextResponse.json(
      { error: `Show not found: ${showId}` },
      { status: 404 },
    );
  }

  const [show] = showRows;

  const [dealRows, showTicketSales, showExpenses] = await Promise.all([
    db.select().from(deals).where(eq(deals.showId, showId)).limit(1),
    db
      .select()
      .from(ticketSales)
      .where(eq(ticketSales.showId, showId))
      .orderBy(desc(ticketSales.capturedAt)),
    db
      .select()
      .from(expenses)
      .where(eq(expenses.showId, showId))
      .orderBy(asc(expenses.enteredAt)),
  ]);

  const deal = dealRows[0] ?? null;
  const notesFreetext = deal?.dealNotesFreetext?.trim() ?? "";

  let aiTranslation: unknown = null;

  if (notesFreetext) {
    try {
      aiTranslation = await translateDealNotes(notesFreetext);
    } catch (err) {
      if (err instanceof Error && err.message === "ANTHROPIC_API_KEY is not configured") {
        return NextResponse.json({ error: err.message }, { status: 500 });
      }

      if (err instanceof SyntaxError) {
        return NextResponse.json(
          {
            error: "AI response was not valid JSON",
            details: err.message,
          },
          { status: 502 },
        );
      }

      if (err instanceof Anthropic.APIError) {
        return NextResponse.json(
          {
            error: "Anthropic API request failed",
            details: err.message,
          },
          { status: 502 },
        );
      }

      const message =
        err instanceof Error ? err.message : "Failed to translate deal notes";

      return NextResponse.json(
        { error: "Failed to translate deal notes", details: message },
        { status: 502 },
      );
    }
  }

  return NextResponse.json({
    show,
    deal,
    ticketSales: showTicketSales,
    expenses: showExpenses,
    aiTranslation,
  });
}
