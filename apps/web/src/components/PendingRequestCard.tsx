import { motion } from "framer-motion";
import { getPendingUserInputRequests } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

type PendingRequest = ReturnType<typeof getPendingUserInputRequests>[number];

export function PendingRequestCard({
  request,
  answerDraft,
  onDraftChange,
  onSubmit,
  onSkip,
  isBusy
}: {
  request: PendingRequest;
  answerDraft: Record<string, { option: string; freeform: string }>;
  onDraftChange: (questionId: string, field: "option" | "freeform", value: string) => void;
  onSubmit: () => void;
  onSkip: () => void;
  isBusy: boolean;
}): React.JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border border-border bg-card p-4 space-y-3"
    >
      {request.params.questions.map((q) => {
        const draft = answerDraft[q.id] ?? { option: "", freeform: "" };
        return (
          <div key={q.id} className="space-y-2">
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider font-medium">
              {q.header}
            </div>
            <div className="text-sm font-medium text-foreground">{q.question}</div>
            <div className="space-y-1">
              <RadioGroup
                value={draft.option}
                onValueChange={(value) => onDraftChange(q.id, "option", value)}
                className="space-y-1"
              >
                {q.options.map((opt, optionIndex) => {
                  const optionId = `q-${q.id}-opt-${optionIndex}`;
                  return (
                    <Label
                      key={opt.label}
                      htmlFor={optionId}
                      className={`flex items-start gap-2.5 cursor-pointer p-2 rounded-lg transition-colors ${
                        draft.option === opt.label
                          ? "bg-muted text-foreground"
                          : "hover:bg-muted/50 text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <RadioGroupItem
                        id={optionId}
                        value={opt.label}
                        className="mt-0.5 shrink-0"
                      />
                      <span className="text-sm">
                        <span className="font-medium">{opt.label}</span>
                        {opt.description && (
                          <span className="block text-xs text-muted-foreground/70 mt-0.5">
                            {opt.description}
                          </span>
                        )}
                      </span>
                    </Label>
                  );
                })}
              </RadioGroup>
            </div>
            {q.isOther && (
              <Input
                type={q.isSecret ? "password" : "text"}
                value={draft.freeform}
                onChange={(e) => onDraftChange(q.id, "freeform", e.target.value)}
                placeholder="Free-form answer…"
                className="h-8 bg-background text-base md:text-sm"
              />
            )}
          </div>
        );
      })}

      <div className="flex gap-2 pt-1">
        <Button
          type="button"
          onClick={onSkip}
          disabled={isBusy}
          variant="outline"
          size="sm"
          className="h-8 text-xs"
        >
          Skip
        </Button>
        <Button
          type="button"
          onClick={onSubmit}
          disabled={isBusy}
          size="sm"
          className="h-8 text-xs"
        >
          Submit
        </Button>
      </div>
    </motion.div>
  );
}
