import type { Rating, Surface } from "./types";

export interface RatingBadgeProps {
  rating?: Rating;
  surface?: Surface;
}

const BASE =
  "inline-block font-ui text-[9px] font-bold uppercase tracking-[0.14em]";

/* Buy and Sell are solid fills (identical on both surfaces per the DC);
   the middle three are 1px outline pills tinted per surface. Filled pills
   carry 3px/9px padding, outlined 2px/8px — the border makes up the px. */
const VARIANT: Record<Surface, Record<Rating, string>> = {
  light: {
    Buy: "bg-positive-fill text-paper-tint px-[9px] py-[3px]",
    Overweight: "border border-positive text-positive px-2 py-[2px]",
    Hold: "border border-ink text-ink px-2 py-[2px]",
    Underweight: "border border-negative text-negative px-2 py-[2px]",
    Sell: "bg-negative text-paper-tint px-[9px] py-[3px]",
  },
  dark: {
    Buy: "bg-positive-fill text-paper-tint px-[9px] py-[3px]",
    Overweight: "border border-positive-dark text-positive-dark px-2 py-[2px]",
    Hold: "border border-paper-tint text-paper-tint px-2 py-[2px]",
    Underweight: "border border-negative-dark text-negative-dark px-2 py-[2px]",
    Sell: "bg-negative text-paper-tint px-[9px] py-[3px]",
  },
};

/** Buy / Overweight / Hold / Underweight / Sell pill. */
export function RatingBadge({
  rating = "Buy",
  surface = "light",
}: RatingBadgeProps) {
  return <span className={`${BASE} ${VARIANT[surface][rating]}`}>{rating}</span>;
}
