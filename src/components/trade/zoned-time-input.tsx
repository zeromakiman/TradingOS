import { Input, type InputProps } from "@/components/ui/input";

export type ZonedTimeInputProps = Omit<InputProps, "type" | "step" | "endAdornment"> & {
  /** Short name of the zone the typed time is read in: "UTC−5", "UTC", or the local zone ("GMT+3"). */
  zone: string;
};

/**
 * Date-and-time field of an entry or exit time (docs/V2_ARCHITECTURE.md §5.1, §14.3, §14.4) that states, beside the
 * value, the zone the typed time is read in, so a trader never has to guess whether "09:42" means strategy time, UTC
 * or their own clock. The surrounding Field's label names the zone for assistive technology too (the visible tag is
 * decorative), and the form converts the value with the same zone (./time-input.ts).
 */
export function ZonedTimeInput({ zone, ...props }: ZonedTimeInputProps) {
  return (
    <Input
      type="datetime-local"
      step={60}
      {...props}
      endAdornment={
        <span aria-hidden="true" className="tabular-nums" data-time-zone="">
          {zone}
        </span>
      }
    />
  );
}
