import type { ComponentProps } from "react";
import { cx } from "./cx";

type CardElement = "div" | "section" | "article";

/** Surface container. Use `as="section"` with `aria-labelledby` when the card is a page region. */
export function Card({ as: Element = "div", className, ...props }: Omit<ComponentProps<"section">, "ref"> & { as?: CardElement }) {
  return <Element className={cx("card", className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cx("card-header", className)} {...props} />;
}

type HeadingLevel = "h2" | "h3" | "h4";

export function CardTitle({ as: Heading = "h2", className, ...props }: ComponentProps<"h2"> & { as?: HeadingLevel }) {
  return <Heading className={cx("card-title", className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return <p className={cx("card-description", className)} {...props} />;
}

export function CardBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cx("card-body", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return <div className={cx("card-footer", className)} {...props} />;
}
