"use client";

import { Eye, EyeOff } from "lucide-react";
import { type ComponentProps, useState } from "react";
import { cx } from "../ui/cx";

/**
 * Password input with a show/hide toggle (Security, Danger zone and the sign-in pages). The toggle is a real button
 * with a pressed state and a 40px hit target; the input keeps every attribute a Field hands it (id, aria wiring).
 */
export function PasswordInput({ className, ...props }: Omit<ComponentProps<"input">, "type">) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        {...props}
        type={visible ? "text" : "password"}
        className={cx("input pr-11", className)}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
      <button
        type="button"
        className="absolute inset-y-0 right-0 grid w-10 place-items-center rounded-r-[var(--radius-control)] text-3 hover:text-text focus-visible:outline-2 focus-visible:outline-accent pointer-coarse:w-11"
        aria-label="Show password"
        aria-pressed={visible}
        aria-controls={props.id}
        onClick={() => setVisible(value => !value)}
        disabled={props.disabled}
      >
        {visible ? <EyeOff aria-hidden="true" className="size-4" /> : <Eye aria-hidden="true" className="size-4" />}
      </button>
    </div>
  );
}
