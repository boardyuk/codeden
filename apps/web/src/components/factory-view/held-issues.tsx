import { FACTORY_HOLD_LABEL, type FactoryHeldIssue } from "@codeden/contracts";
import { PauseCircle } from "lucide-react";
import { ago } from "@/lib/format";

/** Why an issue is held, in words: the recorded reason, or the label it carries. */
export function heldReason(h: FactoryHeldIssue): string {
  return h.reason ?? `The ${FACTORY_HOLD_LABEL} label is on the issue`;
}

/**
 * Issues held out of the factory loop (§10.1, Held work), under Intake: each shows "Held", its
 * issue and why. The loop skips them (not taken in, or parked in the queue) until the hold label
 * comes off; each links to its issue on GitHub.
 */
export function HeldIssues({ held }: { held: FactoryHeldIssue[] }) {
  if (held.length === 0) return null;
  return (
    <div className="flex flex-col gap-1" data-testid="factory-held">
      {held.map((h) => {
        const who = h.by === "pm" ? "the PM" : h.by === "user" ? "you" : null;
        const since = h.since ? ` ${ago(h.since)}` : "";
        return (
          <a
            key={h.issue.number}
            href={h.issue.url}
            target="_blank"
            rel="noreferrer"
            className="block rounded-md border border-dashed border-border px-2 py-1.5 text-[11px] transition-colors hover:bg-accent/60"
            title={`Held${who ? ` by ${who}${since}` : ""}: ${heldReason(h)}. The factory skips it until the ${FACTORY_HOLD_LABEL} label comes off.`}
            data-testid="factory-held-issue"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <PauseCircle className="size-3 shrink-0 text-muted-foreground" aria-hidden />
              <span className="shrink-0 font-medium text-muted-foreground">Held</span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                #{h.issue.number}
              </span>
              <span className="truncate">{h.issue.title}</span>
            </span>
            <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
              {heldReason(h)}
            </span>
          </a>
        );
      })}
    </div>
  );
}
