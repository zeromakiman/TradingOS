import { Badge } from "@/components/ui/badge";
import { cx } from "@/components/ui/cx";
import { CUSTOM_MODEL_BADGE } from "./copy";

/**
 * A trade's model in a list (0020): the model's name, and for a custom model a visible "Custom" badge whose accessible
 * text (and tooltip) is "Custom model · not validated by the Risk Engine". The same on every list screen; the trade
 * page spells the full label out.
 */
export function CustomModelBadge({ className }: { className?: string }) {
  return (
    <Badge className={cx("ml-1 flex-none align-middle", className)} title={CUSTOM_MODEL_BADGE}>
      <span aria-hidden="true">Custom</span>
      <span className="sr-only">{CUSTOM_MODEL_BADGE}</span>
    </Badge>
  );
}

export function ModelName({ name, custom }: { name: string; custom: boolean }) {
  return (
    <>
      {name}
      {custom && (
        <>
          {" "}
          <CustomModelBadge />
        </>
      )}
    </>
  );
}
