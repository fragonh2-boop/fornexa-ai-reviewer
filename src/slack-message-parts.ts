import { splitSlackText } from "./context-onboarding.js";
import { formatMentionResponseParts } from "./slack-mentions.js";

const SUFFIX_BUDGET = "\n\n_Respuesta 9999999999/9999999999_".length;

export function isCorrelatedReviewResponse(text: string): boolean {
  return /^[A-Z][A-Z0-9_-]* — REVISIÓN(?: NO INICIADA| FALLIDA)?\nSLACK_REQUEST_TS: \d+\.\d+\n\n/.test(text);
}

/** Repeat routing metadata before splitting, leaving room for the part footer. */
export function formatSlackMessageParts(text: string, maxChars = 3800): string[] {
  if (maxChars < 200) throw new RangeError("maxChars debe ser al menos 200.");
  if (text.length <= maxChars) return [text];

  const correlated = text.match(
    /^([A-Z][A-Z0-9_-]* — (RESPUESTA|REVISIÓN(?: NO INICIADA| FALLIDA)?))\n(SLACK_REQUEST_TS: \d+\.\d+)\n\n([\s\S]*)$/
  );
  if (correlated?.[2] === "RESPUESTA") {
    return formatMentionResponseParts(
      correlated[1].replace(" — RESPUESTA", ""),
      correlated[3].replace("SLACK_REQUEST_TS: ", ""),
      correlated[4],
      maxChars
    );
  }

  let prefix = correlated ? `${correlated[1]}\n${correlated[3]}\n\n` : "";
  let body = correlated ? correlated[4] : text;
  if (correlated) {
    const separator = body.indexOf("\n\n");
    const scope = separator === -1 ? body : body.slice(0, separator);
    if (/^(?:TARGET:|PR #\d+:)/.test(scope) && /\bHEAD\b/.test(scope) && /[a-f0-9]{40}/i.test(scope)) {
      prefix += `${scope}\n\n`;
      body = separator === -1 ? "" : body.slice(separator + 2);
    }
  }

  const bodyBudget = maxChars - prefix.length - SUFFIX_BUDGET;
  if (bodyBudget < 200) {
    throw new RangeError("Los metadatos de revisión exceden el presupuesto de Slack.");
  }
  const chunks = splitSlackText(body, bodyBudget);
  return chunks.map((chunk, index) =>
    `${prefix}${chunk}${chunks.length > 1 ? `\n\n_Respuesta ${index + 1}/${chunks.length}_` : ""}`
  );
}
