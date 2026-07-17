import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function IconBase({ children, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="18"
      viewBox="0 0 24 24"
      width="18"
      {...props}
    >
      {children}
    </svg>
  );
}

export function OutlineIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 6h2M4 12h2M4 18h2M9 6h11M9 12h8M9 18h11" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
    </IconBase>
  );
}

export function MapIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="5" cy="12" r="2.4" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="18" cy="6" r="2.4" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="18" cy="18" r="2.4" stroke="currentColor" strokeWidth="1.5" />
      <path d="m7.2 11 8.5-4M7.2 13l8.5 4" stroke="currentColor" strokeWidth="1.5" />
    </IconBase>
  );
}

export function TimelineIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M7 4v16" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="7" cy="6" r="2" fill="currentColor" />
      <circle cx="7" cy="13" r="2" fill="currentColor" />
      <circle cx="7" cy="20" r="2" fill="currentColor" />
      <path d="M11 6h9M11 13h6M11 20h9" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
    </IconBase>
  );
}

export function FocusIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M8 4H4v4M16 4h4v4M20 16v4h-4M8 20H4v-4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" />
    </IconBase>
  );
}

export function SparkIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 2.8c.6 5.4 3.1 7.9 8.5 8.5-5.4.6-7.9 3.1-8.5 8.5-.6-5.4-3.1-7.9-8.5-8.5 5.4-.6 7.9-3.1 8.5-8.5Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5" />
    </IconBase>
  );
}

export function ChevronIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m9 6 6 6-6 6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" />
    </IconBase>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 3 5 6v5c0 4.5 2.8 8 7 10 4.2-2 7-5.5 7-10V6l-7-3Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.5" />
      <path d="m9 12 2 2 4-4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
    </IconBase>
  );
}

export function LinkIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m9.5 14.5 5-5M7.7 17.7l-1 .9a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0M16.3 6.3l1-.9a3.5 3.5 0 0 1 5 5l-3 3a3.5 3.5 0 0 1-5 0" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
    </IconBase>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m5 12 4.5 4.5L19 7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </IconBase>
  );
}

export function HistoryIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 7v5h5M5 12a7 7 0 1 0 2-5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" />
      <path d="M12 8v4l3 2" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
    </IconBase>
  );
}
