import { serveReviewerMcp } from '../src/api/reviewer-mcp.ts';
await serveReviewerMcp(process.stdin, process.stdout, process.env.COAGENT_BASE);
