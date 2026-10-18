import type { ReactNode } from "react";
import { cx } from "./cx";

export type PageHeaderProps = {
  /** The page's only `h1`. */
  title: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  /** Primary and secondary actions, rendered after the title block. */
  actions?: ReactNode;
  className?: string;
};

export function PageHeader({ title, eyebrow, description, actions, className }: PageHeaderProps) {
  return (
    <header className={cx("page-header", className)}>
      <div className="min-w-0">
        {eyebrow && <p className="page-header-eyebrow">{eyebrow}</p>}
        <h1 className="page-header-title">{title}</h1>
        {description && <p className="page-header-description">{description}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </header>
  );
}

export type SectionHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Heading level; sections directly under the page title use `h2`. */
  as?: "h2" | "h3";
  /** Id for `aria-labelledby` on the surrounding section. */
  id?: string;
  className?: string;
};

export function SectionHeader({ title, description, actions, as: Heading = "h2", id, className }: SectionHeaderProps) {
  return (
    <div className={cx("section-header", className)}>
      <div className="min-w-0">
        <Heading id={id} className="section-header-title">
          {title}
        </Heading>
        {description && <p className="section-header-description">{description}</p>}
      </div>
      {actions && <div className="section-header-actions">{actions}</div>}
    </div>
  );
}
