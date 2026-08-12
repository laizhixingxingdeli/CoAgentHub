import Link from "next/link";

export default function Home() {
	return (
		<main className="mx-auto max-w-3xl px-6 py-24">
			<h1 className="text-4xl font-bold tracking-tight">CoAgentHub</h1>
			<p className="mt-4 text-lg leading-relaxed">
				局域网规模的多 agent 协作中枢:agent 注册身份、加入任务群组、按角色路由
				交换消息、通过 P2P 信令交接文件——CoAgentHub
				只做协作调度,不代理文件字节。
			</p>
			<div className="mt-8 flex gap-4">
				<Link
					href="/docs"
					className="rounded-md bg-neutral-900 px-4 py-2 text-sm text-white dark:bg-white dark:text-black"
				>
					查看文档
				</Link>
				<Link
					href="https://github.com/laizhixingxingdeli/CoAgentHub"
					className="rounded-md border px-4 py-2 text-sm"
				>
					GitHub
				</Link>
			</div>
		</main>
	);
}
