import type { MetaRecord } from "nextra";

export default {
	index: {
		type: "page",
		title: "CoAgentHub",
		display: "hidden",
		theme: {
			layout: "full",
		},
	},
	docs: {
		type: "page",
		title: "文档",
	},
} satisfies MetaRecord;
