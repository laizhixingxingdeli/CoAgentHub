import type { Config } from "tailwindcss";

export default {
	darkMode: "class",
	content: ["./src/**/*.{js,jsx,ts,tsx,mdx}"],
	theme: {
		container: {
			center: true,
			padding: "2rem",
			screens: {
				"2xl": "1400px",
			},
		},
		extend: {
			animation: {
				"accordion-down": "accordion-down 0.2s ease-out",
				"accordion-up": "accordion-up 0.2s ease-out",
				"border-beam": "border-beam calc(var(--duration)*1s) infinite linear",
				meteor: "meteor 5s linear infinite",
				spin: "spin calc(var(--speed) * 2) infinite linear",
				slide: "slide var(--speed) ease-in-out infinite alternate",
				gradient: "gradient 6s linear infinite",
				marquee: "marquee var(--duration) linear infinite",
				grid: "grid 20s linear infinite",
				"marquee-vertical": "marquee-vertical var(--duration) linear infinite",
				"shimmer-slide":
					"shimmer-slide var(--speed) ease-in-out infinite alternate",
				"spin-around": "spin-around calc(var(--speed) * 2) infinite linear",
			},
			keyframes: {
				"accordion-down": {
					from: { height: 0 },
					to: { height: "var(--radix-accordion-content-height)" },
				},
				"accordion-up": {
					from: { height: "var(--radix-accordion-content-height)" },
					to: { height: 0 },
				},
				"border-beam": {
					"100%": {
						"offset-distance": "100%",
					},
				},
				grid: {
					"0%": { transform: "translateY(-50%)" },
					"100%": { transform: "translateY(0)" },
				},
				meteor: {
					"0%": { transform: "rotate(215deg) translateX(0)", opacity: 1 },
					"70%": { opacity: 1 },
					"100%": {
						transform: "rotate(215deg) translateX(-500px)",
						opacity: 0,
					},
				},
				marquee: {
					from: { transform: "translateX(0)" },
					to: { transform: "translateX(calc(-100% - var(--gap)))" },
				},
				"marquee-vertical": {
					from: { transform: "translateY(0)" },
					to: { transform: "translateY(calc(-100% - var(--gap)))" },
				},
				gradient: {
					to: { "background-position": "200% center" },
				},
				spin: {
					"0%": {
						rotate: "0deg",
					},
					"15%, 35%": {
						rotate: "90deg",
					},
					"65%, 85%": {
						rotate: "270deg",
					},
					"100%": {
						rotate: "360deg",
					},
				},
				"spin-around": {
					"0%": {
						transform: "translateZ(0) rotate(0)",
					},
					"15%, 35%": {
						transform: "translateZ(0) rotate(90deg)",
					},
					"65%, 85%": {
						transform: "translateZ(0) rotate(270deg)",
					},
					"100%": {
						transform: "translateZ(0) rotate(360deg)",
					},
				},
				slide: {
					to: {
						transform: "translate(calc(100cqw - 100%), 0)",
					},
				},

				"shimmer-slide": {
					to: {
						transform: "translate(calc(100cqw - 100%), 0)",
					},
				},
			},
			perspective: {
				"1000": "1000px",
			},
		},
	},
} satisfies Config;
