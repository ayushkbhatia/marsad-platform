/**
 * Shared prop vocabulary for the extracted UI primitives.
 *
 * `surface` is an explicit prop, never a theme context (component-map.md):
 * dark mode is fixed per surface — data rooms are always dark, editorial is
 * always light — so it is a property of where a component sits, not a user
 * preference.
 */
export type Surface = "light" | "dark";

/**
 * Rating vocabulary for RatingBadge / ScoreModule. "Strong Buy" is valid for
 * human analyst calls only, never the ScoreModule (04-reader-app.md D7) —
 * deliberately excluded here until AnalystRow needs it.
 */
export type Rating = "Buy" | "Overweight" | "Hold" | "Underweight" | "Sell";
