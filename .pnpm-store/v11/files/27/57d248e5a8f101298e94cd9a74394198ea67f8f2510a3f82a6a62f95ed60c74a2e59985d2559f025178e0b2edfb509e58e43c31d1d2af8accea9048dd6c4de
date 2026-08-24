Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

const node_fs = require('node:fs');
const node_path = require('node:path');
const core = require('@sentry/core');
const debugBuild = require('../debug-build.js');
const commonjs = require('../utils/commonjs.js');

let moduleCache;

const INTEGRATION_NAME = 'Modules';

const _modulesIntegration = (() => {
  // This integration only works in CJS contexts
  if (!commonjs.isCjs()) {
    debugBuild.DEBUG_BUILD &&
      core.logger.warn(
        'modulesIntegration only works in CommonJS (CJS) environments. Remove this integration if you are using ESM.',
      );
    return {
      name: INTEGRATION_NAME,
    };
  }

  return {
    name: INTEGRATION_NAME,
    processEvent(event) {
      event.modules = {
        ...event.modules,
        ..._getModules(),
      };

      return event;
    },
  };
}) ;

/**
 * Add node modules / packages to the event.
 *
 * Only works in CommonJS (CJS) environments.
 */
const modulesIntegration = core.defineIntegration(_modulesIntegration);

/** Extract information about paths */
function getPaths() {
  try {
    return require.cache ? Object.keys(require.cache ) : [];
  } catch (e) {
    return [];
  }
}

/** Extract information about package.json modules */
function collectModules()

 {
  const mainPaths = require.main?.paths || [];
  const paths = getPaths();
  const infos

 = {};
  const seen

 = {};

  paths.forEach(path => {
    let dir = path;

    /** Traverse directories upward in the search of package.json file */
    const updir = () => {
      const orig = dir;
      dir = node_path.dirname(orig);

      if (!dir || orig === dir || seen[orig]) {
        return undefined;
      }
      if (mainPaths.indexOf(dir) < 0) {
        return updir();
      }

      const pkgfile = node_path.join(orig, 'package.json');
      seen[orig] = true;

      if (!node_fs.existsSync(pkgfile)) {
        return updir();
      }

      try {
        const info = JSON.parse(node_fs.readFileSync(pkgfile, 'utf8'))

;
        infos[info.name] = info.version;
      } catch (_oO) {
        // no-empty
      }
    };

    updir();
  });

  return infos;
}

/** Fetches the list of modules and the versions loaded by the entry file for your node.js app. */
function _getModules() {
  if (!moduleCache) {
    moduleCache = collectModules();
  }
  return moduleCache;
}

exports.modulesIntegration = modulesIntegration;
//# sourceMappingURL=modules.js.map
