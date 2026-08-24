Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

const instrumentation = require('@opentelemetry/instrumentation');
const core = require('@sentry/core');

// List of patched methods
// From: https://sdk.vercel.ai/docs/ai-sdk-core/telemetry#collected-data
const INSTRUMENTED_METHODS = [
  'generateText',
  'streamText',
  'generateObject',
  'streamObject',
  'embed',
  'embedMany',
] ;

/**
 * This detects is added by the Sentry Vercel AI Integration to detect if the integration should
 * be enabled.
 *
 * It also patches the `ai` module to enable Vercel AI telemetry automatically for all methods.
 */
class SentryVercelAiInstrumentation extends instrumentation.InstrumentationBase {
   __init() {this._isPatched = false;}
   __init2() {this._callbacks = [];}

   constructor(config = {}) {
    super('@sentry/instrumentation-vercel-ai', core.SDK_VERSION, config);SentryVercelAiInstrumentation.prototype.__init.call(this);SentryVercelAiInstrumentation.prototype.__init2.call(this);  }

  /**
   * Initializes the instrumentation by defining the modules to be patched.
   */
   init() {
    const module = new instrumentation.InstrumentationNodeModuleDefinition('ai', ['>=3.0.0 <5'], this._patch.bind(this));
    return module;
  }

  /**
   * Call the provided callback when the module is patched.
   * If it has already been patched, the callback will be called immediately.
   */
   callWhenPatched(callback) {
    if (this._isPatched) {
      callback();
    } else {
      this._callbacks.push(callback);
    }
  }

  /**
   * Patches module exports to enable Vercel AI telemetry.
   */
   _patch(moduleExports) {
    this._isPatched = true;

    this._callbacks.forEach(callback => callback());
    this._callbacks = [];

    function generatePatch(originalMethod) {
      return (...args) => {
        const existingExperimentalTelemetry = args[0].experimental_telemetry || {};
        const isEnabled = existingExperimentalTelemetry.isEnabled;

        // if `isEnabled` is not explicitly set to `true` or `false`, enable telemetry
        // but disable capturing inputs and outputs by default
        if (isEnabled === undefined) {
          args[0].experimental_telemetry = {
            isEnabled: true,
            recordInputs: false,
            recordOutputs: false,
            ...existingExperimentalTelemetry,
          };
        }

        // @ts-expect-error we know that the method exists
        return originalMethod.apply(this, args);
      };
    }

    // Is this an ESM module?
    // https://tc39.es/ecma262/#sec-module-namespace-objects
    if (Object.prototype.toString.call(moduleExports) === '[object Module]') {
      // In ESM we take the usual route and just replace the exports we want to instrument
      for (const method of INSTRUMENTED_METHODS) {
        moduleExports[method] = generatePatch(moduleExports[method]);
      }

      return moduleExports;
    } else {
      // In CJS we can't replace the exports in the original module because they
      // don't have setters, so we create a new object with the same properties
      const patchedModuleExports = INSTRUMENTED_METHODS.reduce((acc, curr) => {
        acc[curr] = generatePatch(moduleExports[curr]);
        return acc;
      }, {} );

      return { ...moduleExports, ...patchedModuleExports };
    }
  }
}

exports.SentryVercelAiInstrumentation = SentryVercelAiInstrumentation;
//# sourceMappingURL=instrumentation.js.map
