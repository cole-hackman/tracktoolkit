import { cn } from "@/lib/utils";
import * as React from "react";

export type ButtonVariant =
  | "default"
  | "secondary"
  | "destructive"
  | "ghost"
  | "outline"
  | "glass";

export type ButtonSize = "default" | "sm" | "lg" | "icon";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * Keep the label on one line. The base style wraps by default so a long
   * label grows the button instead of overflowing its container on a narrow
   * screen; set this for short labels in a toolbar where a wrap looks broken.
   */
  nowrap?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", nowrap = false, type = "button", ...props }, ref) => {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(
          "inline-flex items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-all duration-150",
          nowrap && "whitespace-nowrap",
          "disabled:cursor-not-allowed disabled:opacity-50",
          // `aria-disabled` is for a control that must stay focusable (so its
          // explanation can be reached). It looks disabled and takes no
          // hover lift/glow or press feedback.
          "aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:shadow-none aria-disabled:hover:translate-y-0 aria-disabled:hover:shadow-none aria-disabled:active:scale-100",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/80 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "active:scale-[0.98]",
          // Variants
          variant === "default" && [
            "bg-primary text-primary-foreground shadow-elevation-1",
            "hover:shadow-glow-sm hover:-translate-y-0.5",
          ],
          variant === "secondary" && [
            "border border-border/70 bg-secondary text-secondary-foreground shadow-sm",
            "hover:border-primary/40 hover:bg-secondary/80",
          ],
          variant === "destructive" && [
            "bg-destructive text-destructive-foreground shadow-sm",
            "hover:bg-destructive/90 aria-disabled:hover:bg-destructive",
            "data-[shake=true]:animate-[shake_150ms_ease-in-out_1]",
          ],
          variant === "ghost" && [
            "hover:bg-accent hover:text-accent-foreground text-foreground",
          ],
          variant === "outline" && [
            "border border-input bg-background shadow-sm text-foreground",
            "hover:bg-accent hover:text-accent-foreground",
          ],
          variant === "glass" && [
            "glass-card text-foreground hover:bg-white/10 dark:hover:bg-white/5",
          ],
          // Sizes — `default` and `icon` clear the 44px touch-target floor.
          size === "default" && "h-11 px-4 py-2",
          size === "sm" && "h-10 rounded-md px-3",
          size === "lg" && "h-12 rounded-xl px-8 text-base",
          size === "icon" && "h-11 w-11",
          className
        )}
        {...props}
      />
    );
  }
)
Button.displayName = "Button"

export { Button }
