"use client";

// Tailwind's `md` breakpoint: below it, the panels use the phone layout.
export const isMobile = () => window.matchMedia("(width < 48rem)").matches;

/**
 * A panel's open state. Null until the viewer toggles it: open on desktop, closed on phones, decided
 * in CSS so the static page renders the right state on either without a flash.
 */
export type PanelOpen = boolean | null;

export const resolvePanelOpen = (open: PanelOpen) => open ?? !isMobile();

// Collapses a floating panel to its essentials, so the map behind it has room.
export function CollapseButton({ open, onChange, label }: { open: PanelOpen; onChange: (open: boolean) => void; label: string }) {
	const word = (shown: boolean) => (shown ? "Hide" : "Show");
	return (
		<button
			type="button"
			aria-expanded={open ?? undefined}
			aria-label={open === null ? `Toggle ${label}` : `${word(open)} ${label}`}
			onClick={() => onChange(!resolvePanelOpen(open))}
			className="flex cursor-pointer items-center gap-1 rounded-md border border-zinc-300 bg-zinc-50 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-200 hover:text-zinc-900"
		>
			<svg
				viewBox="0 0 20 20"
				fill="currentColor"
				aria-hidden
				className={`size-4 ${open === null ? "md:rotate-180" : open ? "rotate-180" : ""}`}
			>
				<path
					fillRule="evenodd"
					d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
					clipRule="evenodd"
				/>
			</svg>
			{open === null ? (
				<>
					<span className="md:hidden">Show</span>
					<span className="max-md:hidden">Hide</span>
				</>
			) : (
				word(open)
			)}
		</button>
	);
}
