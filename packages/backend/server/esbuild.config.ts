import "dotenv/config";
import esbuild from "esbuild";

const plugins = [];

// Only enable the Sentry plugin when a token is configured (CI / production).
// Locally there is no auth token and no need to upload source maps.
if (process.env.SENTRY_AUTH_TOKEN) {
  const { sentryEsbuildPlugin } = await import("@sentry/esbuild-plugin");
  plugins.push(
    sentryEsbuildPlugin({
      sourcemaps: {
        filesToDeleteAfterUpload: ["*.map"],
      },
    }),
  );
}

try {
  esbuild
    .build({
      entryPoints: {
        server: "src/index.ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node18",
      outExtension: { ".js": ".mjs" },
      minify: true,
      sourcemap: true,
      outdir: "dist",
      tsconfig: "tsconfig.json",
      packages: "external",
      plugins,
    })
    .catch(() => {
      return process.exit(1);
    });
} catch (error) {
  console.log(error);
}
