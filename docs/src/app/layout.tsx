import "@/globals.css";
import "nextra-theme-docs/style.css";
import "@/overrides.css";

import { getPageMap } from "nextra/page-map";
import { Layout, Navbar } from "nextra-theme-docs";

export const metadata = {
	title: {
		default: "CoAgentHub",
		template: "%s | CoAgentHub",
	},
	description:
		"CoAgentHub - an open-source, self-hosted, local-first AI platform: a LAN-scale multi-agent coordination hub.",
};

const navbar = (
	<Navbar
		logo={<b>CoAgentHub</b>}
		projectLink="https://github.com/laizhixingxingdeli/CoAgentHub"
	/>
);

export default async function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<html
			lang="zh-CN"
			dir="ltr"
			className="antialiased"
			suppressHydrationWarning
		>
			<body>
				<Layout
					navbar={navbar}
					pageMap={await getPageMap()}
					editLink={null}
					docsRepositoryBase="https://github.com/laizhixingxingdeli/CoAgentHub"
				>
					{children}
				</Layout>
			</body>
		</html>
	);
}
