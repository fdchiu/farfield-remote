import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { DiffBlock } from "@/components/DiffBlock";
import { Button } from "@/components/ui/button";

export function StreamEventCard({ event }: { event: unknown }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  if (typeof event !== "object" || event === null) {
    return (
      <div className="text-xs font-mono text-muted-foreground px-2 py-1.5 rounded-md border border-border">
        {String(event)}
      </div>
    );
  }
  const e = event as Record<string, unknown>;
  const method = typeof e["method"] === "string" ? e["method"] : null;
  const type = typeof e["type"] === "string" ? e["type"] : null;
  const label = method ?? type ?? "event";

  const params = e["params"] as Record<string, unknown> | undefined;
  const changes = params?.["changes"];
  const isFileChange = Array.isArray(changes);

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <Button
        type="button"
        onClick={() => setOpen((v) => !v)}
        variant="ghost"
        className="h-auto w-full justify-start rounded-none bg-muted/30 px-2.5 py-1.5 text-left hover:bg-muted/60"
      >
        <ChevronRight
          size={10}
          className={`shrink-0 text-muted-foreground/60 transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="font-mono text-[11px] text-muted-foreground truncate">{label}</span>
      </Button>
      {open && (
        <div className="border-t border-border px-2.5 py-2">
          {isFileChange ? (
            <DiffBlock
              changes={
                changes as Array<{
                  path: string;
                  kind: { type: string; move_path?: string | null };
                  diff?: string;
                }>
              }
            />
          ) : (
            <pre className="font-mono text-[11px] text-muted-foreground/80 whitespace-pre-wrap break-words">
              {JSON.stringify(event, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
