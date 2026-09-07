#!/usr/bin/env node
/**
 * test-baseline.mjs — capture vitest baseline counts for a ticket.
 *
 * Usage:
 *   node scripts/test-baseline.mjs <packageDir> <testFile...>
 *   node scripts/test-baseline.mjs --json <packageDir> <testFile...>
 *
 * Exit 0 even when tests fail (this tool measures, it does not judge).
 * Non-zero only on tool errors: missing args, vitest won't start, unparseable output.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

function usageAndExit(msg) {
	if (msg) console.error(`error: ${msg}`);
	console.error(
		"usage: node scripts/test-baseline.mjs [--json] <packageDir> <testFile...>",
	);
	process.exit(1);
}

function parseArgs(argv) {
	const args = argv.slice(2);
	let json = false;
	const positional = [];
	for (const a of args) {
		if (a === "--json") json = true;
		else if (a.startsWith("-")) usageAndExit(`unknown flag: ${a}`);
		else positional.push(a);
	}
	if (positional.length < 2) {
		usageAndExit("need <packageDir> and at least one <testFile>");
	}
	const [packageDir, ...testFiles] = positional;
	return { json, packageDir, testFiles };
}

/**
 * Parse vitest summary lines like:
 *   Test Files  1 failed | 2 passed (3)
 *   Tests  5 failed | 10 passed | 1 skipped (16)
 *   Test Files  2 passed (2)
 *   Tests  12 passed (12)
 */
function parseVitestCounts(output) {
	// Prefer the "Tests " line for case counts; also capture "Test Files".
	// Vitest may colorize; strip ANSI first.
	const plain = output.replace(/\u001b\[[0-9;]*m/g, "");

	const filesLine = plain.match(/Test Files\s+([^\n\r]+)/);
	const testsLine = plain.match(/(?:^|\n)\s*Tests\s+([^\n\r]+)/);

	if (!testsLine) return null;

	const parseSegment = (segment) => {
		const failed = Number((segment.match(/(\d+)\s+failed/) || [])[1] || 0);
		const passed = Number((segment.match(/(\d+)\s+passed/) || [])[1] || 0);
		const totalMatch = segment.match(/\((\d+)\)/);
		const total = totalMatch
			? Number(totalMatch[1])
			: failed +
				passed +
				Number((segment.match(/(\d+)\s+skipped/) || [])[1] || 0) +
				Number((segment.match(/(\d+)\s+todo/) || [])[1] || 0);
		return { failed, passed, total };
	};

	const tests = parseSegment(testsLine[1]);
	const files = filesLine ? parseSegment(filesLine[1]) : null;

	return { tests, files };
}

function gitShortHead(cwd) {
	const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
		cwd,
		encoding: "utf8",
		shell: false,
	});
	if (r.status !== 0) return "unknown";
	return (r.stdout || "").trim() || "unknown";
}

function isoWithOffset(d = new Date()) {
	const pad = (n, w = 2) => String(n).padStart(w, "0");
	const tzo = -d.getTimezoneOffset();
	const sign = tzo >= 0 ? "+" : "-";
	const abs = Math.abs(tzo);
	const hh = pad(Math.floor(abs / 60));
	const mm = pad(abs % 60);
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
		`T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
		`${sign}${hh}:${mm}`
	);
}

function main() {
	const { json, packageDir, testFiles } = parseArgs(process.argv);
	const absPkg = resolve(process.cwd(), packageDir);
	if (!existsSync(absPkg)) usageAndExit(`packageDir not found: ${packageDir}`);

	const started = Date.now();
	// On Windows, npx is a .cmd — shell:true is required for spawn to find it.
	const result = spawnSync("npx", ["vitest", "run", ...testFiles], {
		cwd: absPkg,
		encoding: "utf8",
		shell: true,
		env: process.env,
		// vitest writes summary to stderr sometimes; capture both
		maxBuffer: 32 * 1024 * 1024,
	});

	// spawn itself failed (npx missing, etc.)
	if (result.error) {
		console.error(`error: failed to start vitest: ${result.error.message}`);
		process.exit(1);
	}

	const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
	const counts = parseVitestCounts(combined);
	if (!counts) {
		console.error("error: could not parse Test Files / Tests counts from vitest output");
		console.error("--- vitest output (tail) ---");
		console.error(combined.slice(-4000));
		process.exit(1);
	}

	const durationSeconds = Math.round((Date.now() - started) / 1000);
	const commit = gitShortHead(process.cwd());
	const platform = process.platform;
	const nodeVersion = process.version;
	const timestamp = isoWithOffset();

	const payload = {
		failed: counts.tests.failed,
		passed: counts.tests.passed,
		total: counts.tests.total,
		filesFailed: counts.files ? counts.files.failed : null,
		filesPassed: counts.files ? counts.files.passed : null,
		filesTotal: counts.files ? counts.files.total : null,
		durationSeconds,
		commit,
		platform,
		nodeVersion,
		timestamp,
		packageDir,
		testFiles,
	};

	if (json) {
		process.stdout.write(`${JSON.stringify(payload)}\n`);
	} else {
		const filesPart = counts.files
			? `;文件 ${counts.files.failed} failed | ${counts.files.passed} passed (${counts.files.total})`
			: "";
		const line =
			`基线 @ ${commit} (${platform}, node ${nodeVersion}, ${timestamp}, ${durationSeconds}s)\n` +
			`  ${testFiles.join(" ")}\n` +
			`  → ${counts.tests.failed} failed | ${counts.tests.passed} passed (${counts.tests.total})${filesPart}`;
		process.stdout.write(`${line}\n`);
	}

	// Always 0 when we successfully measured — red or green.
	process.exit(0);
}

main();
