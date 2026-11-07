// Tailwind classes shared by the forms, so fields and buttons look the same on every
// screen. They use the design tokens in index.css, so they follow light and dark mode.
import { buttonClass, fieldClass } from "../ui";

export const inputClass = fieldClass;
export const primaryButton = buttonClass("primary");
export const secondaryButton = buttonClass("secondary");
